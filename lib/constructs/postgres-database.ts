/**
 * PostgresDatabase: RDS PostgreSQL in isolated subnets, secured by default.
 *
 * Decisions worth defending:
 *
 * 1. RDS instance, not Aurora. For a small relational workload RDS Postgres is far cheaper to
 *    run and operate. Aurora wins on fast failover (~30s vs 60-120s), up to 15 read replicas with
 *    shared storage, and Serverless v2 scaling. If the interviewer asks "why not Aurora?":
 *    "I'd move when read scaling or failover time becomes a requirement; the cost is not justified yet."
 *
 * 2. Credentials: Secrets Manager generates the password; nothing sensitive is in the template or
 *    the repo. The app reads it at task start (ECS `secrets`), so it never appears in the task
 *    definition JSON. IAM database authentication is also enabled for a future password-less path.
 *
 * 3. Network: isolated subnets, `publiclyAccessible: false`, and a security group with NO egress
 *    and ingress added only by the consumers that need it (least privilege at the network layer).
 *
 * 4. Stateful guardrails: deletion protection + RETAIN + final snapshot in prod, so neither
 *    `cdk destroy` nor an accidental logical-ID change (replacement!) can delete the data.
 *    A CDK refactor that renames the construct ID makes CloudFormation REPLACE the resource.
 *    This is why stateful resources sit in their own stack and are not renamed casually.
 */
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';

export interface PostgresDatabaseProps {
  readonly vpc: ec2.IVpc;
  readonly instanceType: string;
  readonly multiAz: boolean;
  readonly allocatedStorageGiB: number;
  readonly maxAllocatedStorageGiB: number;
  readonly backupRetentionDays: number;
  readonly rotateSecret: boolean;
  readonly protect: boolean;
  readonly alarmTopic: sns.ITopic;
}

/** Postgres default port. Exported so consumers can write exact security-group rules without a cross-stack token. */
export const POSTGRES_PORT = 5432;

export class PostgresDatabase extends Construct {
  public readonly instance: rds.DatabaseInstance;
  public readonly secret: secretsmanager.ISecret;
  public readonly securityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: PostgresDatabaseProps) {
    super(scope, id);

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_17,
    });

    // Force TLS for every connection at the engine level (defence in depth: the app also verifies the CA).
    const parameterGroup = new rds.ParameterGroup(this, 'Params', {
      engine,
      description: 'Orders platform Postgres parameters',
      parameters: { 'rds.force_ssl': '1' },
    });

    const securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: 'Postgres. Ingress is granted by consumers, egress is denied.',
      allowAllOutbound: false,
    });
    this.securityGroup = securityGroup;

    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      engine,
      parameterGroup,
      instanceType: new ec2.InstanceType(props.instanceType),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [securityGroup],
      publiclyAccessible: false,

      credentials: rds.Credentials.fromGeneratedSecret('app_admin'),
      databaseName: 'orders',
      port: POSTGRES_PORT,
      iamAuthentication: true,

      storageType: rds.StorageType.GP3,
      allocatedStorage: props.allocatedStorageGiB,
      maxAllocatedStorage: props.maxAllocatedStorageGiB, // storage autoscaling: no 3am "disk full"
      storageEncrypted: true,

      multiAz: props.multiAz,
      backupRetention: Duration.days(props.backupRetentionDays),
      preferredBackupWindow: '21:00-21:30', // 02:30-03:00 IST
      preferredMaintenanceWindow: 'sun:21:30-sun:22:30',
      autoMinorVersionUpgrade: true,
      copyTagsToSnapshot: true,
      // Engine logs go to CloudWatch. Retention is deliberately NOT set via `cloudwatchLogsRetention`:
      // that prop deploys a custom-resource Lambda just to set a retention number. Set it with a
      // LogGroup construct if needed (the /aws/rds/instance/<id>/postgresql group).
      cloudwatchLogsExports: ['postgresql', 'upgrade'],

      deletionProtection: props.protect,
      removalPolicy: props.protect ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });

    this.secret = this.instance.secret!;

    if (props.rotateSecret) {
      // Single-user rotation: the rotation Lambda runs inside the VPC (isolated subnets) and uses the
      // Secrets Manager interface endpoint added in Network. Multi-user (alternating) rotation avoids
      // a brief auth-failure window but needs a second DB user; single-user is the pragmatic default.
      this.instance.addRotationSingleUser({
        automaticallyAfter: Duration.days(30),
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });
    } else {
      // Acknowledge on the INSTANCE (an ancestor of the generated secret). `this.secret` is the secret *attachment*,
      // a child of the Secret, so acknowledging there would not cover the CfnSecret that the rule flags.
      Validations.of(this.instance).acknowledge({
        id: 'AwsSolutions-SMG4',
        reason: 'Dev only: rotation needs a paid Secrets Manager VPC endpoint. Enabled in prod via config.',
      });
    }

    if (!props.multiAz) {
      Validations.of(this.instance).acknowledge({
        id: 'AwsSolutions-RDS3',
        reason: 'Dev only: Multi-AZ doubles instance cost. Enabled in prod via config.',
      });
    }
    if (!props.protect) {
      Validations.of(this.instance).acknowledge({
        id: 'AwsSolutions-RDS10',
        reason: 'Dev only: deletion protection would block `cdk destroy` teardown. Enabled in prod.',
      });
    }
    Validations.of(this.instance).acknowledge({
      id: 'AwsSolutions-RDS11',
      reason:
        'Default port 5432 kept: the security group has no internet path (isolated subnet) and allows only the app SG. A custom port is obscurity, not a control.',
    });

    // Alarms that catch the two ways a small RDS instance actually dies: CPU saturation and a full disk.
    const action = new cwActions.SnsAction(props.alarmTopic);
    new cloudwatch.Alarm(this, 'CpuHigh', {
      metric: this.instance.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3, // 15 min sustained: ignores brief spikes
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'RDS CPU above 80% for 15 minutes.',
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, 'FreeStorageLow', {
      // Alarm at 10% of the *allocated* storage. Storage autoscaling raises the ceiling first,
      // so this firing means autoscaling is not keeping up or has hit maxAllocatedStorage.
      metric: this.instance.metricFreeStorageSpace({ period: Duration.minutes(5) }),
      threshold: props.allocatedStorageGiB * 0.1 * 1024 ** 3,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'RDS free storage below 10% of allocated storage.',
    }).addAlarmAction(action);
  }
}
