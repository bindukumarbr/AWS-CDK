/**
 * Network: a three-tier VPC (public / private-with-egress / isolated).
 *
 *   public ........ only the ALB and NAT gateways live here.
 *   private ....... Fargate tasks. Outbound internet via NAT (pull images, call AWS APIs).
 *   isolated ...... RDS. NO route to the internet at all, in either direction.
 *
 * This is the CDK equivalent of the `terraform-aws-modules/vpc/aws` module (see docs/TERRAFORM_BRIDGE.md).
 * One `new ec2.Vpc()` call generates subnets, route tables, IGW, NAT gateways and associations:
 * roughly 40 CloudFormation resources from ~15 lines. That is the L2 value proposition, and
 * also the thing to be careful about: you must know what it generates (check `cdk synth`).
 *
 * Cost levers (see config.ts): NAT gateways are the biggest line item in a small VPC.
 */
import { RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface NetworkProps {
  readonly cidr: string;
  readonly maxAzs: number;
  readonly natGateways: number;
  readonly secretsManagerEndpoint: boolean;
  readonly flowLogRetention: logs.RetentionDays;
  readonly retain: boolean;
}

export class Network extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      retention: props.flowLogRetention,
      removalPolicy: props.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: props.maxAzs,
      natGateways: props.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        // /28 is plenty for a handful of DB ENIs and leaves address space for growth elsewhere.
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
      ],
      // VPC flow logs (AwsSolutions-VPC7): the first thing a security investigation asks for.
      // ALT: S3 destination is cheaper at volume and queryable with Athena; CloudWatch Logs is
      //      simpler to read during an incident, which is why it is the default here.
      flowLogs: {
        all: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
          trafficType: ec2.FlowLogTrafficType.ALL,
          maxAggregationInterval: ec2.FlowLogMaxAggregationInterval.TEN_MINUTES,
        },
      },
    });

    // Gateway endpoints for S3 and DynamoDB are FREE and keep that traffic off the NAT gateway
    // (which bills per GB processed). Always add them.
    this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    if (props.secretsManagerEndpoint) {
      // Interface endpoints are NOT free (~$7/AZ/month + data). Added only where required.
      // Here: the secret-rotation Lambda runs in the isolated subnets (next to the DB) and has no
      // internet path, so without this endpoint rotation fails at runtime. This is a classic gotcha:
      // `deploy` succeeds, and the failure shows up 30 days later.
      const endpoint = this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        open: false, // default `open: true` allows the VPC CIDR as an unresolved token, which scanners cannot evaluate
      });
      // Explicit and literal: only addresses inside THIS VPC may reach the endpoint, and only on 443.
      endpoint.connections.allowFrom(ec2.Peer.ipv4(props.cidr), ec2.Port.tcp(443), 'VPC to Secrets Manager endpoint');
    }

    // Not added, deliberately (and worth saying out loud in an interview):
    //   - ECR / CloudWatch Logs / STS interface endpoints. With 1-2 tasks the NAT path is cheaper.
    //     At scale, or under a "no internet egress" compliance rule, add them and drop the NAT.
  }
}
