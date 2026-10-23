/**
 * Composition root: builds the stacks for one stage and attaches the guardrails.
 * Shared by bin/app.ts (real deploys) and the tests, so tests exercise exactly what ships.
 */
import { App, Aspects, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LambdaGuardrails } from './aspects/lambda-guardrails';
import { StageConfig } from './config';
import { AppStack } from './stacks/app-stack';
import { FoundationStack } from './stacks/foundation-stack';

export interface Platform {
  readonly foundation: FoundationStack;
  readonly app: AppStack;
}

export function createPlatform(app: App, config: StageConfig): Platform {
  // env-specific stacks: required for ALB access logging (needs the region) and for context
  // lookups. Account comes from the CLI credentials, so the same code deploys to any account.
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

  const foundation = new FoundationStack(app, `orders-${config.stage}-foundation`, { env, config });

  const appStack = new AppStack(app, `orders-${config.stage}-app`, {
    env,
    config,
    vpc: foundation.vpc,
    database: foundation.database,
    ordersTable: foundation.ordersTable,
    alarmTopic: foundation.alarmTopic,
  });
  appStack.addStackDependency(foundation); // explicit: deploy order and rollback order are intentional

  // Tags propagate to every taggable resource: cost allocation (Cost Explorer tag filters) and ownership.
  Tags.of(app).add('Project', 'orders-platform');
  Tags.of(app).add('Stage', config.stage);
  Tags.of(app).add('ManagedBy', 'aws-cdk');

  return { foundation, app: appStack };
}

/**
 * Policy-as-code guardrails, evaluated at synth time:
 *   - our own Aspect (organisation rules)
 *   - cdk-nag AwsSolutions pack (AWS Solutions Library best practices)
 * `cdk synth` FAILS if either reports an error, so a violating change cannot reach CloudFormation
 * and CI needs no extra step: the build itself is the gate.
 */
export function addGuardrails(app: App): void {
  Aspects.of(app).add(new LambdaGuardrails());
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
}
