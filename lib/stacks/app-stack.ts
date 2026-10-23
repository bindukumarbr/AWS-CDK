/**
 * AppStack: the stateless, frequently-deployed layer (API, web service, alarms, dashboard).
 *
 * This is the stack the CI/CD pipeline changes on every merge. It can be rolled back or even
 * deleted and recreated without losing data, because all state lives in FoundationStack.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { StageConfig } from '../config';
import { OrdersApi } from '../constructs/orders-api';
import { PostgresDatabase } from '../constructs/postgres-database';
import { WebService } from '../constructs/web-service';

export interface AppStackProps extends cdk.StackProps {
  readonly config: StageConfig;
  readonly vpc: ec2.IVpc;
  readonly database: PostgresDatabase;
  readonly ordersTable: dynamodb.ITableV2;
  readonly alarmTopic: sns.ITopic;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, {
      ...props,
      description: `Orders platform (${props.config.stage}) - API, web service, alarms, dashboard. Stateless.`,
    });

    const { config } = props;

    const ordersApi = new OrdersApi(this, 'OrdersApi', {
      table: props.ordersTable,
      logRetention: config.logRetention,
      throttleRatePerSecond: config.api.throttleRatePerSecond,
      throttleBurst: config.api.throttleBurst,
      alarmTopic: props.alarmTopic,
      retain: false, // logs of a stateless stack are disposable; keep the stack deletable
    });

    const web = new WebService(this, 'WebService', {
      vpc: props.vpc,
      database: props.database,
      cpu: config.web.cpu,
      memoryMiB: config.web.memoryMiB,
      desiredCount: config.web.desiredCount,
      minCapacity: config.web.minCapacity,
      maxCapacity: config.web.maxCapacity,
      certificateArn: config.web.certificateArn,
      logRetention: config.logRetention,
      alarmTopic: props.alarmTopic,
      protect: config.protectStatefulResources,
    });

    // One dashboard = the first screen you open during an incident: traffic, errors, latency, saturation.
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `orders-${config.stage}`,
      defaultInterval: cdk.Duration.hours(3),
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API requests and 5xx',
        left: [ordersApi.api.metricCount(), ordersApi.api.metricServerError()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda p95 duration (ms) and errors',
        left: [ordersApi.function.metricDuration({ statistic: 'p95' })],
        right: [ordersApi.function.metricErrors()],
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB requests and target response time',
        left: [web.loadBalancer.metrics.requestCount()],
        right: [web.loadBalancer.metrics.targetResponseTime()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS service CPU / memory %',
        left: [web.service.metricCpuUtilization(), web.service.metricMemoryUtilization()],
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'RDS CPU % and connections',
        left: [props.database.instance.metricCPUUtilization()],
        right: [props.database.instance.metricDatabaseConnections()],
        width: 24,
      }),
    );

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: ordersApi.stage.url,
      description: 'HTTP API base URL (POST /orders, GET /orders/{id}, GET /customers/{id}/orders)',
    });
    new cdk.CfnOutput(this, 'WebUrl', {
      value: `${config.web.certificateArn ? 'https' : 'http'}://${web.loadBalancer.loadBalancerDnsName}`,
      description: 'ALB DNS name for the containerised web service (/health, /db-check)',
    });
  }
}
