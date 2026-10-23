/**
 * SecureBucket: an S3 bucket with the guardrails every bucket in this platform must have.
 *
 * This is an L3-style "opinionated wrapper" construct. It is the smallest useful example of
 * the pattern a platform team ships as a shared construct library: teams get safe defaults for
 * free and have to go out of their way to weaken them.
 *
 * Why these defaults (each maps to a cdk-nag rule or a real incident class):
 *   - BLOCK_ALL public access ........ stops the classic "public bucket" leak.
 *   - enforceSSL ...................... bucket policy denies non-TLS requests (AwsSolutions-S10).
 *   - versioned + lifecycle ........... recover from accidental overwrite; bound storage cost.
 *   - S3-managed encryption ........... REQUIRED here: ALB access-log delivery only supports SSE-S3,
 *                                       not KMS. A KMS key would silently break log delivery.
 *
 * ALT: use `s3.Bucket` directly everywhere and rely on cdk-nag to catch mistakes. That works,
 *      but every team re-decides the same settings. The wrapper moves the decision left.
 */
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface SecureBucketProps {
  /** RETAIN in prod so a stack delete never deletes audit data; DESTROY in dev for easy teardown. */
  readonly retain: boolean;
  /** Objects older than this are expired. Logs rarely need to live forever. */
  readonly expireAfterDays?: number;
  /** Set for buckets that are themselves log sinks (see note on AwsSolutions-S1 below). */
  readonly isLogSink?: boolean;
}

export class SecureBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: SecureBucketProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      // BUCKET_OWNER_ENFORCED disables ACLs entirely: access is IAM + bucket policy only.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: props.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      // autoDeleteObjects uses a CDK-managed custom-resource Lambda to empty the bucket before delete.
      // Only worth it where we WANT clean teardown (dev).
      autoDeleteObjects: !props.retain,
      lifecycleRules: [
        {
          expiration: Duration.days(props.expireAfterDays ?? 90),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    if (props.isLogSink) {
      // AwsSolutions-S1 wants server access logs on every bucket. For a bucket that IS the
      // log destination, logging it into itself is circular, and logging it into another
      // bucket just moves the problem. Acknowledged on purpose, with the reason recorded.
      Validations.of(this.bucket).acknowledge({
        id: 'AwsSolutions-S1',
        reason: 'This bucket is a log sink; server access logging a log sink is circular.',
      });
    }
  }
}
