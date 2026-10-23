/**
 * WebService: containerised service on ECS Fargate behind an internet-facing ALB.
 *
 * I build this from L2 constructs instead of the one-line L3 `ApplicationLoadBalancedFargateService`.
 * ALT: that pattern is great for a prototype (20 lines, sane defaults). The cost is that it hides
 * the security groups, listener and target group wiring, and bends awkwardly when you need
 * locked-down egress, a custom health-check path or two listeners (HTTP->HTTPS redirect). In an interview
 * "I can use the L3, and I can build the same thing from L2 when I need control" is the strong answer.
 *
 * Why ECS Fargate (and not EC2, Lambda or EKS) for this tier:
 *   - vs Lambda: long-lived connections to Postgres. Lambda would need RDS Proxy to avoid exhausting
 *     DB connections; a small steady container pool is simpler and cheaper at steady load.
 *   - vs ECS on EC2: no AMI patching, no capacity management. Pay ~20-30% more per vCPU for that.
 *   - vs EKS: Kubernetes adds a control plane ($73/month), add-ons and upgrade work. Pick EKS when you need
 *     the Kubernetes ecosystem (operators, service mesh, portability); ECS when you just need containers run well.
 *
 * Deployment safety (zero-downtime story):
 *   - minHealthyPercent 100 / maxHealthyPercent 200: new tasks start BEFORE old ones stop.
 *   - Deployment circuit breaker with rollback: if new tasks keep failing health checks the
 *     service rolls back to the last good task definition automatically.
 *   - ALB health check hits /health (liveness only). The DB is deliberately NOT part of it: a DB blip
 *     must not make the ALB mark every task unhealthy and turn a partial outage into a total one.
 *   - stopTimeout + SIGTERM handler in the app: in-flight requests finish during a deploy.
 *   - ALT for stricter control: CodeDeploy blue/green (ECS) with test listener + traffic shifting + alarm rollback.
 *     More moving parts; use it when "canary 10% for 5 minutes" is a requirement.
 */
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'node:path';
import { Construct } from 'constructs';
import { POSTGRES_PORT, PostgresDatabase } from './postgres-database';
import { SecureBucket } from './secure-bucket';

export interface WebServiceProps {
  readonly vpc: ec2.IVpc;
  readonly database: PostgresDatabase;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly desiredCount: number;
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly certificateArn?: string;
  readonly logRetention: logs.RetentionDays;
  readonly alarmTopic: sns.ITopic;
  /** prod: keep ALB log bucket + enable ALB deletion protection. */
  readonly protect: boolean;
}

const CONTAINER_PORT = 8080;

export class WebService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: WebServiceProps) {
    super(scope, id);

    const removal = props.protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ---------------------------------------------------------------- cluster + task definition
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      // Container Insights: per-task CPU/memory/network metrics (AwsSolutions-ECS4). Costs extra CloudWatch metrics.
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const containerLogs = new logs.LogGroup(this, 'ContainerLogs', {
      retention: props.logRetention,
      removalPolicy: removal,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryMiB,
      // X86_64 on purpose: the GitHub-hosted runner is x86, so the image builds natively. ARM64 (Graviton,
      // ~20% cheaper) needs buildx + QEMU or an arm64 runner. A good next optimisation, not a day-2 task.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // `fromAsset` builds the Docker image from ./app/web, pushes it to the CDK bootstrap ECR repo, and
    // pins the task definition to the image's content hash. Rollback = previous hash, so deploys are immutable.
    // ALT: build/scan/push in CI and pass `ContainerImage.fromEcrRepository(repo, gitSha)`. That is the better
    // shape for a real pipeline (scan the exact image you ship); `fromAsset` keeps this project self-contained.
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../app/web'), {
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      portMappings: [{ containerPort: CONTAINER_PORT }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web', logGroup: containerLogs }),
      // Secrets are resolved by ECS at task start and injected as env vars. They never appear in the
      // task definition JSON or CloudFormation template. Caveat: a rotated password is only picked up by
      // NEW tasks. Production answer: re-fetch on auth failure, or switch to IAM database auth.
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(props.database.secret, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(props.database.secret, 'port'),
        DB_NAME: ecs.Secret.fromSecretsManager(props.database.secret, 'dbname'),
        DB_USER: ecs.Secret.fromSecretsManager(props.database.secret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.database.secret, 'password'),
      },
      readonlyRootFilesystem: true, // a compromised process cannot write to the container filesystem
      stopTimeout: Duration.seconds(30),
      healthCheck: {
        // Container-level check, independent of the ALB: lets ECS replace a wedged task fast.
        command: [
          'CMD-SHELL',
          `node -e "fetch('http://127.0.0.1:${CONTAINER_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(20),
      },
    });

    // ------------------------------------------------------------------------------ security groups
    // Egress is locked down on purpose. Tasks may only: reach Postgres (rules added below),
    // and call AWS APIs over 443 (ECR image pull, CloudWatch Logs, Secrets Manager) through the NAT.
    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc: props.vpc,
      description: 'Fargate tasks: ingress from ALB only; egress 443 + Postgres only.',
      allowAllOutbound: false,
    });
    serviceSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'AWS APIs via NAT (ECR, Logs, Secrets Manager)');

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      description: 'Public ALB: 80/443 from the internet; egress only to the service.',
      allowAllOutbound: false,
    });

    // ------------------------------------------------------------------------------------ service
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: props.desiredCount,
      securityGroups: [serviceSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: Duration.seconds(60), // do not kill slow-starting tasks while the ALB warms up
      enableExecuteCommand: false, // no interactive shell into prod containers unless explicitly enabled
    });

    // Cross-stack security-group rules: DB (Foundation stack) <-> tasks (App stack).
    // GOTCHA (hit while building this): `db.connections.allowDefaultPortFrom(service)` puts the rule on the
    // DB security group's stack (Foundation), which then references the service SG in the App stack:
    // Foundation -> App while App -> Foundation = cyclic dependency, and `synth` fails.
    // FIX: import the DB security group BY ID inside this (consumer) stack and add the rules to the import.
    // The rules then live in the App stack and the dependency arrow only points App -> Foundation.
    const dbSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'DbSg', props.database.securityGroup.securityGroupId, {
      mutable: true,
    });
    dbSg.addIngressRule(serviceSg, ec2.Port.tcp(POSTGRES_PORT), 'Fargate tasks to Postgres');
    serviceSg.addEgressRule(dbSg, ec2.Port.tcp(POSTGRES_PORT), 'Tasks to Postgres');

    // ------------------------------------------------------------------------------------- the ALB
    const accessLogs = new SecureBucket(this, 'AlbLogs', {
      retain: props.protect,
      expireAfterDays: 60,
      isLogSink: true,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true, // defends against HTTP desync / request smuggling via malformed headers
      deletionProtection: props.protect,
    });
    this.loadBalancer.logAccessLogs(accessLogs.bucket, 'alb');

    let listener: elbv2.ApplicationListener;
    if (props.certificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn);
      listener = this.loadBalancer.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS, // TLS 1.2/1.3 only
      });
      this.loadBalancer.addRedirect({
        sourcePort: 80,
        sourceProtocol: elbv2.ApplicationProtocol.HTTP,
        targetPort: 443,
        targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      });
    } else {
      // Demo mode: no domain means no ACM certificate, so plain HTTP. Production = HTTPS + redirect (branch above).
      listener = this.loadBalancer.addListener('Http', { port: 80 });
    }

    this.targetGroup = listener.addTargets('Web', {
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      deregistrationDelay: Duration.seconds(30), // default 300s makes every deploy crawl; our requests are short
      healthCheck: {
        path: '/health',
        interval: Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    Validations.of(taskDefinition).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'ecr:GetAuthorizationToken does not support resource-level permissions; "*" is the only valid value.',
    });

    Validations.of(albSg).acknowledge({
      id: 'AwsSolutions-EC23',
      reason: 'Internet-facing ALB must accept 80/443 from 0.0.0.0/0. Targets are private; egress is locked to the service SG.',
    });

    // ------------------------------------------------------------------------------ autoscaling
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: props.minCapacity,
      maxCapacity: props.maxCapacity,
    });
    // Target tracking keeps average CPU near 60%: headroom for spikes while new tasks (~1 min) start.
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.minutes(5), // scale in slowly to avoid flapping
      scaleOutCooldown: Duration.minutes(1),
    });

    // ---------------------------------------------------------------------------------- alarms
    const action = new cwActions.SnsAction(props.alarmTopic);

    new cloudwatch.Alarm(this, 'Target5xx', {
      metric: this.targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Web tasks are returning 5xx through the ALB.',
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, 'UnhealthyHosts', {
      metric: this.targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'At least one web task is failing ALB health checks.',
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, 'CpuHigh', {
      metric: this.service.metricCpuUtilization({ period: Duration.minutes(5) }),
      threshold: 85,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Service CPU above 85% for 15 minutes: autoscaling is saturated or maxed out.',
    }).addAlarmAction(action);
  }
}
