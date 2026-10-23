/**
 * FoundationStack: everything stateful or slow-changing (network, database, table, alarm topic).
 *
 * WHY a stateful/stateless stack split (an official CDK best practice):
 *   - Blast radius: the App stack deploys many times a day; it must not be able to touch the
 *     database in the same CloudFormation transaction. A bad deploy rolls back only the App stack.
 *   - Safety: termination protection and RETAIN policies live here and nowhere else.
 *   - Speed: App deploys never re-evaluate VPC/RDS resources.
 *
 * Cross-stack references: the App stack receives these resources as typed props. CDK turns the
 * references into CloudFormation Exports/Imports. Trade-off to know: an exported value cannot be
 * changed or removed while another stack imports it, so renaming a resource here can deadlock.
 * ALT: write values to SSM Parameter Store and read them in the consumer (looser coupling, but you lose
 * compile-time wiring and need an explicit deploy order).
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { StageConfig } from '../config';
import { AlarmTopic } from '../constructs/alarm-topic';
import { Network } from '../constructs/network';
import { PostgresDatabase } from '../constructs/postgres-database';

export interface FoundationStackProps extends cdk.StackProps {
  readonly config: StageConfig;
}

export class FoundationStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly database: PostgresDatabase;
  public readonly ordersTable: dynamodb.ITableV2;
  public readonly alarmTopic: sns.ITopic;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, {
      ...props,
      description: `Orders platform (${props.config.stage}) - network, data stores, alarm topic. Stateful: change with care.`,
      terminationProtection: props.config.protectStatefulResources,
    });

    const { config } = props;
    const retain = config.protectStatefulResources;

    const alarms = new AlarmTopic(this, 'Alarms', { email: config.alarmEmail, retain });
    this.alarmTopic = alarms.topic;

    const network = new Network(this, 'Network', {
      cidr: config.vpc.cidr,
      maxAzs: config.vpc.maxAzs,
      natGateways: config.vpc.natGateways,
      secretsManagerEndpoint: config.vpc.secretsManagerEndpoint,
      flowLogRetention: config.logRetention,
      retain,
    });
    this.vpc = network.vpc;

    this.database = new PostgresDatabase(this, 'Database', {
      vpc: network.vpc,
      instanceType: config.db.instanceType,
      multiAz: config.db.multiAz,
      allocatedStorageGiB: config.db.allocatedStorageGiB,
      maxAllocatedStorageGiB: config.db.maxAllocatedStorageGiB,
      backupRetentionDays: config.db.backupRetentionDays,
      rotateSecret: config.db.rotateSecret,
      protect: retain,
      alarmTopic: alarms.topic,
    });

    // DynamoDB data model (single table, two access patterns):
    //   PK orderId ............ get-by-id
    //   GSI byCustomer ........ (customerId, createdAt) -> "list this customer's orders, newest first"
    // On-demand billing: no capacity planning, scales to zero cost; switch to provisioned + autoscaling
    // only when traffic is steady and predictable enough that it is clearly cheaper.
    this.ordersTable = new dynamodb.TableV2(this, 'OrdersTable', {
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, // restore to any second in the last 35 days
      deletionProtection: retain,
      removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      globalSecondaryIndexes: [
        {
          indexName: 'byCustomer',
          partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
        },
      ],
    });
  }
}
