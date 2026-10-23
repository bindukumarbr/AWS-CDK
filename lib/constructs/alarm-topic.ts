/**
 * AlarmTopic: the SNS topic every CloudWatch alarm in the platform notifies.
 *
 * The non-obvious part (a favourite interview probe): CloudWatch alarms CANNOT publish to an SNS
 * topic encrypted with the AWS-managed `alias/aws/sns` key, because that key's policy cannot be
 * edited to trust `cloudwatch.amazonaws.com`. The alarm goes to ALARM state, the notification is
 * silently dropped, and nobody is paged. The fix is a customer-managed KMS key whose key policy
 * allows CloudWatch. That is what this construct does.
 *
 * Satisfies cdk-nag AwsSolutions-SNS2 (topic encrypted) and SNS3 (TLS-only publishers).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface AlarmTopicProps {
  readonly email?: string;
  readonly retain: boolean;
}

export class AlarmTopic extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlarmTopicProps) {
    super(scope, id);

    const key = new kms.Key(this, 'Key', {
      description: 'Encrypts the alarm SNS topic; key policy trusts CloudWatch alarms.',
      enableKeyRotation: true,
      removalPolicy: props.retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToUseKey',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'], // In a KEY policy "*" means "this key" (not a wildcard over keys).
        conditions: {
          // Confused-deputy guard: only alarms from THIS account may use the key.
          StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
        },
      }),
    );

    this.topic = new sns.Topic(this, 'Topic', {
      displayName: 'orders-platform alarms',
      masterKey: key,
      enforceSSL: true,
    });

    if (props.email) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.email));
    }
  }
}
