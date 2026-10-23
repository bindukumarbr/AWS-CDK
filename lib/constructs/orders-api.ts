/**
 * OrdersApi: HTTP API (API Gateway v2) -> Lambda -> DynamoDB.
 *
 *   POST /orders                        create an order
 *   GET  /orders/{orderId}              read one order           (table primary key)
 *   GET  /customers/{customerId}/orders list a customer's orders (GSI `byCustomer`)
 *
 * Decisions worth defending:
 *
 * 1. HTTP API, not REST API. ~70% cheaper per request and lower latency. REST API is still the
 *    right pick when you need usage plans / API keys, request validation models, WAF
 *    attachment, or edge-optimised endpoints. None apply here. (Interview: know this list.)
 *
 * 2. NodejsFunction (esbuild) bundles TypeScript at synth time: no separate build step, one
 *    small artifact. Runtime is the newest supported Node (AwsSolutions-L1), ARM64 (Graviton:
 *    ~20% cheaper per ms and usually faster), X-Ray tracing on.
 *
 * 3. Explicit LogGroup passed to the function. The older `logRetention` prop deploys a custom
 *    resource Lambda just to set retention, and the implicit log group is never deleted with the
 *    stack. An explicit group is simpler, auditable and cleaned up with the stack.
 *
 * 4. Least privilege by action: the function can Put/Get/Query this one table (+ its indexes),
 *    not `dynamodb:*`. `grantReadWriteData` would add Scan/Delete/Update that the code never uses.
 *
 * 5. Throttling at the stage protects DynamoDB and the wallet from a runaway client.
 *
 * Auth: IAM (SigV4) authorizer. Simple and secure for service-to-service callers. End-user traffic would use a
 * JWT authorizer (Cognito/Okta) instead: same routes, different `authorizer`.
 */
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'node:path';
import { Construct } from 'constructs';

export interface OrdersApiProps {
  readonly table: dynamodb.ITableV2;
  readonly logRetention: logs.RetentionDays;
  readonly throttleRatePerSecond: number;
  readonly throttleBurst: number;
  readonly alarmTopic: sns.ITopic;
  readonly retain: boolean;
}

export class OrdersApi extends Construct {
  public readonly function: nodejs.NodejsFunction;
  public readonly api: apigwv2.HttpApi;
  public readonly stage: apigwv2.HttpStage;

  constructor(scope: Construct, id: string, props: OrdersApiProps) {
    super(scope, id);

    const removal = props.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const functionLogs = new logs.LogGroup(this, 'FunctionLogs', {
      retention: props.logRetention,
      removalPolicy: removal,
    });

    this.function = new nodejs.NodejsFunction(this, 'Handler', {
      entry: path.join(__dirname, '../../app/orders-api/src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10), // well under the API Gateway 30s cap: fail fast, don't hold connections
      tracing: lambda.Tracing.ACTIVE,
      logGroup: functionLogs,
      environment: {
        TABLE_NAME: props.table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
        // The AWS SDK v3 ships in the Lambda runtime: leave it out of the bundle (smaller, faster cold start).
        // Trade-off: you get the runtime's SDK version, not the one in package-lock.
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Least privilege, down to the resource: PutItem/GetItem on the table, Query on the ONE index the code
    // uses. `table.grant(fn, ...)` would also add `<table>/index/*`, a wildcard that cdk-nag (rightly) flags.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OrdersTableReadWrite',
        actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
        resources: [props.table.tableArn],
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OrdersByCustomerIndexQuery',
        actions: ['dynamodb:Query'],
        resources: [`${props.table.tableArn}/index/byCustomer`],
      }),
    );

    this.api = new apigwv2.HttpApi(this, 'Api', {
      description: 'Orders API',
      createDefaultStage: false, // we create the stage ourselves to attach throttling + access logs
    });

    const apiLogs = new logs.LogGroup(this, 'AccessLogs', {
      retention: props.logRetention,
      removalPolicy: removal,
    });

    this.stage = new apigwv2.HttpStage(this, 'Stage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: props.throttleRatePerSecond, burstLimit: props.throttleBurst },
      accessLogSettings: { destination: new apigwv2.LogGroupLogDestination(apiLogs) },
    });

    // Authorization: IAM (SigV4). Callers must sign requests and hold `execute-api:Invoke` on this API.
    // Fits service-to-service traffic and needs no extra infrastructure. For END USERS swap in a JWT
    // authorizer (`HttpJwtAuthorizer` with Cognito or Okta): a one-line change per route, no handler change.
    const authorizer = new authorizers.HttpIamAuthorizer();
    const integration = new integrations.HttpLambdaIntegration('OrdersIntegration', this.function);
    this.api.addRoutes({ path: '/orders', methods: [apigwv2.HttpMethod.POST], integration, authorizer });
    this.api.addRoutes({ path: '/orders/{orderId}', methods: [apigwv2.HttpMethod.GET], integration, authorizer });
    this.api.addRoutes({
      path: '/customers/{customerId}/orders',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer,
    });

    // --- Alarms: user-visible symptoms, not internal causes -------------------------------------
    const action = new cwActions.SnsAction(props.alarmTopic);

    new cloudwatch.Alarm(this, 'LambdaErrors', {
      metric: this.function.metricErrors({ period: Duration.minutes(1) }),
      threshold: 3,
      evaluationPeriods: 3,
      datapointsToAlarm: 2, // 2 of 3 minutes: tolerant of a single blip, quick on a real fault
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // no traffic is not an outage
      alarmDescription: 'Orders Lambda is throwing errors.',
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, 'Api5xx', {
      metric: this.api.metricServerError({ period: Duration.minutes(1) }),
      threshold: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'HTTP API is returning 5xx to clients.',
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, 'LambdaP95Latency', {
      metric: this.function.metricDuration({ period: Duration.minutes(5), statistic: 'p95' }),
      threshold: 3000, // ms; the function timeout is 10s
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Orders Lambda p95 duration above 3s.',
    }).addAlarmAction(action);

    // --- cdk-nag acknowledgements (each with the reason) -----------------------------------------
    // The Lambda role uses the AWS-managed AWSLambdaBasicExecutionRole. Replacing it with an inline
    // policy is possible, but the managed policy is the AWS-documented minimal log-write grant.
    Validations.of(this.function).acknowledge({
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      reason: 'AWS-managed minimal CloudWatch Logs write policy for Lambda; no wildcard data access.',
    });
    Validations.of(this.function).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'X-Ray PutTraceSegments/PutTelemetryRecords do not support resource-level permissions; "*" is the only valid value.',
    });
  }
}
