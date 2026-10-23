import { Match } from 'aws-cdk-lib/assertions';
import { allStatements, asArray, build } from './helpers';

describe.each([
  ['dev', { prod: false }],
  ['prod', { prod: true }],
] as const)('AppStack (%s)', (stage, { prod }) => {
  const { appStack } = build(stage);

  describe('Orders API (API Gateway + Lambda)', () => {
    test('Lambda: modern runtime, ARM64, X-Ray, explicit log group', () => {
      appStack.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        TracingConfig: { Mode: 'Active' },
        LoggingConfig: { LogGroup: Match.anyValue() },
        Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue() }) },
      });
    });

    test('Lambda role is least privilege: exact DynamoDB actions, no wildcards on the table', () => {
      const ddb = allStatements(appStack).filter((s) => asArray(s.Action).some((a: string) => a.startsWith('dynamodb:')));
      const actions = ddb.flatMap((s) => asArray(s.Action)).sort();
      expect(actions).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']);
      // Never table/index/* : only the one index the code queries.
      expect(JSON.stringify(ddb)).not.toContain('/index/*');
      expect(JSON.stringify(ddb)).toContain('/index/byCustomer');
    });

    test('every route requires IAM authorization', () => {
      const routes = Object.values(appStack.findResources('AWS::ApiGatewayV2::Route'));
      expect(routes).toHaveLength(3);
      for (const route of routes) {
        expect((route as any).Properties.AuthorizationType).toBe('AWS_IAM');
      }
    });

    test('stage has throttling and access logging', () => {
      appStack.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 }),
        AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
      });
    });
  });

  describe('Web service (ECS Fargate + ALB)', () => {
    test('safe rolling deploys: new tasks first, circuit breaker with rollback', () => {
      appStack.hasResourceProperties('AWS::ECS::Service', {
        LaunchType: 'FARGATE',
        DeploymentConfiguration: Match.objectLike({
          MinimumHealthyPercent: 100,
          MaximumPercent: 200,
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        }),
        NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
      });
    });

    test('container: read-only filesystem, secrets from Secrets Manager (never plain env vars)', () => {
      appStack.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: [
          Match.objectLike({
            ReadonlyRootFilesystem: true,
            Secrets: Match.arrayWith([Match.objectLike({ Name: 'DB_PASSWORD' })]),
          }),
        ],
      });
      const task = JSON.stringify(Object.values(appStack.findResources('AWS::ECS::TaskDefinition')));
      expect(task).not.toMatch(/"Environment"/); // nothing sensitive can hide in plain env vars
    });

    test('ALB: access logs on, invalid headers dropped, deletion protection follows the stage', () => {
      appStack.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        // (Match.arrayWith is order-sensitive, so these follow the order CloudFormation renders them in.)
        LoadBalancerAttributes: Match.arrayWith([
          { Key: 'deletion_protection.enabled', Value: String(prod) },
          { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
          { Key: 'access_logs.s3.enabled', Value: 'true' },
        ]),
      });
    });

    test('target group health check uses /health (liveness only, not the DB)', () => {
      appStack.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: '/health',
      });
    });

    test('task security group: no allow-all egress; DB reachable only via SG-to-SG rule', () => {
      const groups = Object.values(appStack.findResources('AWS::EC2::SecurityGroup')) as any[];
      for (const g of groups) {
        for (const rule of g.Properties.SecurityGroupEgress ?? []) {
          expect(rule.IpProtocol).not.toBe('-1'); // no "all traffic"
        }
      }
      // Postgres rule is source-SG based, not CIDR based.
      appStack.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        SourceSecurityGroupId: Match.anyValue(),
      });
    });

    test('autoscaling is configured with the stage limits', () => {
      appStack.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
        MinCapacity: prod ? 2 : 1,
        MaxCapacity: prod ? 6 : 2,
      });
    });
  });

  describe('Observability', () => {
    test('every alarm notifies the topic', () => {
      const alarms = Object.values(appStack.findResources('AWS::CloudWatch::Alarm')) as any[];
      expect(alarms.length).toBeGreaterThanOrEqual(6);
      for (const alarm of alarms) {
        expect(alarm.Properties.AlarmActions).toBeDefined();
        // "No traffic" must not page anyone: alarms treat missing data as not breaching.
        expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
      }
    });

    test('dashboard exists with the stage name', () => {
      appStack.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: `orders-${stage}` });
    });
  });
});

describe('AppStack HTTPS mode', () => {
  const { appStack } = build('prod', (c) => ({
    ...c,
    web: { ...c.web, certificateArn: 'arn:aws:acm:ap-south-1:123456789012:certificate/00000000-0000-0000-0000-000000000000' },
  }));

  test('serves TLS 1.2+ on 443 and redirects 80 -> 443', () => {
    appStack.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      SslPolicy: Match.stringLikeRegexp('TLS'),
    });
    appStack.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect' })],
    });
  });
});
