/**
 * Fine-grained ASSERTION tests (not snapshots).
 * Why: a snapshot test fails on every harmless change and teaches people to blindly run `jest -u`,
 * which defeats it. Assertions pin the properties we actually care about (security, cost, safety),
 * so a failing test means "an invariant was broken", not "something changed".
 */
import { Match } from 'aws-cdk-lib/assertions';
import { build } from './helpers';

describe.each([
  ['dev', { prod: false }],
  ['prod', { prod: true }],
] as const)('FoundationStack (%s)', (stage, { prod }) => {
  const { foundation, platform } = build(stage);

  test('database is encrypted, private, TLS-only and IAM-auth capable', () => {
    foundation.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      EnableIAMDatabaseAuthentication: true,
      EnableCloudwatchLogsExports: ['postgresql', 'upgrade'],
    });
    foundation.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: Match.objectLike({ 'rds.force_ssl': '1' }),
    });
  });

  test(`stateful safety is ${prod ? 'ON' : 'OFF'} (deletion protection, Multi-AZ, termination protection)`, () => {
    foundation.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: prod,
      MultiAZ: prod,
    });
    expect(platform.foundation.terminationProtection).toBe(prod);
  });

  test('database security group has no route to the internet', () => {
    const groups = foundation.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: Match.stringLikeRegexp('^Postgres') },
    });
    expect(Object.keys(groups)).toHaveLength(1);
    const egress = Object.values(groups)[0].Properties.SecurityGroupEgress ?? [];
    for (const rule of egress) {
      // CDK renders "allowAllOutbound: false" as an ICMP rule to 255.255.255.255/32: effectively deny-all.
      expect(rule.CidrIp).not.toBe('0.0.0.0/0');
    }
  });

  test('database lives only in isolated subnets', () => {
    const subnetGroups = foundation.findResources('AWS::RDS::DBSubnetGroup');
    expect(Object.keys(subnetGroups)).toHaveLength(1);
    const ids = JSON.stringify(Object.values(subnetGroups)[0].Properties.SubnetIds);
    expect(ids).toMatch(/isolated/i);
    expect(ids).not.toMatch(/public|private(?!.*isolated)/i);
  });

  test('orders table: on-demand, PITR on, GSI for the customer access pattern', () => {
    foundation.hasResource('AWS::DynamoDB::GlobalTable', {
      // Prod keeps the data if the stack is deleted; dev cleans up after itself.
      DeletionPolicy: prod ? 'Retain' : 'Delete',
      Properties: Match.objectLike({
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: 'byCustomer',
            KeySchema: [
              { AttributeName: 'customerId', KeyType: 'HASH' },
              { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ],
          }),
        ],
        Replicas: [
          Match.objectLike({
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
            // In a GlobalTable, deletion protection is a per-replica setting.
            ...(prod ? { DeletionProtectionEnabled: true } : {}),
          }),
        ],
      }),
    });
  });

  test('network: 3 tiers, flow logs, free gateway endpoints', () => {
    foundation.resourceCountIs('AWS::EC2::FlowLog', 1);
    foundation.resourceCountIs('AWS::EC2::NatGateway', prod ? 2 : 1);
    const endpoints = JSON.stringify(foundation.findResources('AWS::EC2::VPCEndpoint'));
    expect(endpoints).toContain('s3');
    expect(endpoints).toContain('dynamodb');
    // Interface endpoint for Secrets Manager costs money: prod only (needed for rotation).
    expect(endpoints.includes('secretsmanager')).toBe(prod);
  });

  test('prod rotates the database secret, dev does not', () => {
    if (prod) {
      foundation.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
    } else {
      foundation.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
    }
  });

  test('alarm topic is KMS-encrypted with a key CloudWatch can use, and rejects non-TLS publishers', () => {
    foundation.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
    foundation.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'cloudwatch.amazonaws.com' } }),
        ]),
      },
    });
    foundation.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Condition: { Bool: { 'aws:SecureTransport': 'false' } }, Effect: 'Deny' }),
        ]),
      },
    });
  });

  test('database has CPU and free-storage alarms wired to the topic', () => {
    foundation.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'CPUUtilization',
      Namespace: 'AWS/RDS',
      AlarmActions: Match.anyValue(),
    });
    foundation.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'FreeStorageSpace',
      Namespace: 'AWS/RDS',
      AlarmActions: Match.anyValue(),
    });
  });
});
