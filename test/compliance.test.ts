/**
 * Proves the guardrails are real: the full platform passes them, AND deliberately bad
 * infrastructure is REJECTED. A gate that has never been seen failing is an untested gate.
 */
import { App, Aspects, Validations } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Stack } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { LambdaGuardrails } from '../lib/aspects/lambda-guardrails';
import { getStageConfig } from '../lib/config';
import { addGuardrails, createPlatform } from '../lib/platform';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';

describe('whole platform passes cdk-nag (AwsSolutions) + custom guardrails', () => {
  test.each(['dev', 'prod'])('%s stage synthesizes with zero violations', (stage) => {
    const app = new App();
    createPlatform(app, getStageConfig(stage));
    addGuardrails(app);
    // cdk-nag v3 runs inside CDK's validation phase: synth THROWS if any rule fails.
    expect(() => app.synth()).not.toThrow();
  });
});

describe('the CI-access (OIDC) app also passes cdk-nag', () => {
  // bin/github-oidc.ts is a separate CDK app, so it needs its own proof: it holds the keys to the account.
  test('synthesizes with zero violations', () => {
    const app = new App();
    new GithubOidcStack(app, 'oidc', {
      env: { account: '123456789012', region: 'ap-south-1' },
      githubOwner: 'acme',
      githubRepo: 'orders-platform-cdk',
      environments: ['dev', 'prod'],
    });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).not.toThrow();
  });
});

describe('the gates actually reject bad infrastructure', () => {
  test('cdk-nag blocks an S3 bucket without TLS enforcement / access logs', () => {
    const app = new App();
    const stack = new Stack(app, 'Bad');
    new s3.Bucket(stack, 'Naked'); // no enforceSSL, no logging
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).toThrow(/AwsSolutions-S10/);
  });

  test('LambdaGuardrails flags an x86, untraced, end-of-life Lambda', () => {
    const app = new App();
    const stack = new Stack(app, 'BadLambda');
    new lambda.Function(stack, 'Old', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    });
    Aspects.of(app).add(new LambdaGuardrails());

    const annotations = Annotations.fromStack(stack);
    annotations.hasError('*', Match.stringLikeRegexp('X-Ray tracing must be Active'));
    annotations.hasError('*', Match.stringLikeRegexp('runtime "nodejs18.x" is not allowed'));
    annotations.hasError('*', Match.stringLikeRegexp('ARM64'));
  });

  test('an unknown stage name fails loudly instead of defaulting', () => {
    expect(() => getStageConfig('prd')).toThrow(/Unknown stage/);
  });
});
