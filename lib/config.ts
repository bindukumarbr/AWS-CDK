/**
 * Stage configuration: the ONLY place where dev and prod differ.
 *
 * WHY a typed config object instead of `if (stage === 'prod')` scattered through constructs:
 *   - Constructs stay environment-agnostic and unit-testable (pass a config, assert the output).
 *   - A reviewer sees every dev/prod difference in one diff.
 *   - Cost knobs (NAT count, Multi-AZ, instance size) are explicit, so "why is dev cheap?" has an answer.
 *
 * ALT: CDK context in cdk.json (`-c stage=prod`) for the *selector* only (done in bin/app.ts),
 *      or SSM Parameter Store for values that change without a code deploy. Context is fine for
 *      the selector; I avoid it for values because context values are untyped strings.
 *
 * Secrets never live here. Account IDs come from the CLI's credentials (CDK_DEFAULT_ACCOUNT).
 */
import * as logs from 'aws-cdk-lib/aws-logs';

export type StageName = 'dev' | 'prod';

export interface StageConfig {
  readonly stage: StageName;
  /** Mumbai: closest to the team, and ap-south-1 has 3 AZs. */
  readonly region: string;

  readonly vpc: {
    readonly cidr: string;
    readonly maxAzs: number;
    /** NAT gateways cost ~$32+/month each. dev: 1 shared (cheap, single point of failure). prod: 1 per AZ. */
    readonly natGateways: number;
    /** Interface endpoint for Secrets Manager (~$7/AZ/month). Needed for in-VPC secret rotation. */
    readonly secretsManagerEndpoint: boolean;
  };

  readonly db: {
    readonly instanceType: string;
    readonly multiAz: boolean;
    readonly allocatedStorageGiB: number;
    readonly maxAllocatedStorageGiB: number;
    readonly backupRetentionDays: number;
    /** Rotates the master secret every 30 days. Requires `vpc.secretsManagerEndpoint`. */
    readonly rotateSecret: boolean;
  };

  readonly web: {
    readonly cpu: number;
    readonly memoryMiB: number;
    readonly desiredCount: number;
    readonly minCapacity: number;
    readonly maxCapacity: number;
    /** ACM certificate ARN. If absent the ALB serves plain HTTP (demo only, no domain needed). */
    readonly certificateArn?: string;
  };

  readonly api: {
    readonly throttleRatePerSecond: number;
    readonly throttleBurst: number;
  };

  /** Stateful resources (DB, table, logs bucket): RETAIN + deletion protection in prod. */
  readonly protectStatefulResources: boolean;
  readonly logRetention: logs.RetentionDays;
  /** Where alarm notifications go. Optional so a fresh clone deploys without an inbox. */
  readonly alarmEmail?: string;
}

const COMMON = {
  region: 'ap-south-1',
  api: { throttleRatePerSecond: 50, throttleBurst: 100 },
} as const;

export function getStageConfig(stage: string): StageConfig {
  const alarmEmail = process.env.ALARM_EMAIL || undefined;
  const certificateArn = process.env.WEB_CERTIFICATE_ARN || undefined;

  switch (stage) {
    case 'dev':
      return {
        stage: 'dev',
        region: COMMON.region,
        vpc: { cidr: '10.20.0.0/16', maxAzs: 2, natGateways: 1, secretsManagerEndpoint: false },
        db: {
          instanceType: 't4g.micro',
          multiAz: false,
          allocatedStorageGiB: 20,
          maxAllocatedStorageGiB: 50,
          backupRetentionDays: 1,
          rotateSecret: false,
        },
        web: {
          cpu: 256,
          memoryMiB: 512,
          desiredCount: 1,
          minCapacity: 1,
          maxCapacity: 2,
          certificateArn,
        },
        api: COMMON.api,
        protectStatefulResources: false,
        logRetention: logs.RetentionDays.ONE_WEEK,
        alarmEmail,
      };
    case 'prod':
      return {
        stage: 'prod',
        region: COMMON.region,
        vpc: { cidr: '10.30.0.0/16', maxAzs: 2, natGateways: 2, secretsManagerEndpoint: true },
        db: {
          instanceType: 't4g.medium',
          multiAz: true,
          allocatedStorageGiB: 50,
          maxAllocatedStorageGiB: 200,
          backupRetentionDays: 14,
          rotateSecret: true,
        },
        web: {
          cpu: 512,
          memoryMiB: 1024,
          desiredCount: 2, // >= 2 so a single task failure or a deploy never drops capacity to zero
          minCapacity: 2,
          maxCapacity: 6,
          certificateArn,
        },
        api: COMMON.api,
        protectStatefulResources: true,
        logRetention: logs.RetentionDays.ONE_MONTH,
        alarmEmail,
      };
    default:
      // Fail loudly: a typo like `-c stage=prd` must never silently deploy dev settings.
      throw new Error(`Unknown stage "${stage}". Use -c stage=dev or -c stage=prod.`);
  }
}
