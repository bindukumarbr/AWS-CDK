#!/usr/bin/env node
/**
 * ONE-TIME, human-run app that creates the GitHub OIDC trust and the CI roles.
 * Separate from bin/app.ts so the pipeline can never modify its own permissions.
 *
 *   npx cdk deploy -a "npx tsx bin/github-oidc.ts" \
 *     -c githubOwner=<your-gh-user-or-org> -c githubRepo=<repo> \
 *     [-c existingProviderArn=arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com]
 */
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';

const app = new App();
const owner = app.node.tryGetContext('githubOwner');
const repo = app.node.tryGetContext('githubRepo');
if (!owner || !repo) {
  throw new Error('Pass -c githubOwner=<owner> -c githubRepo=<repo>');
}

new GithubOidcStack(app, 'orders-github-oidc', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-south-1' },
  githubOwner: owner,
  githubRepo: repo,
  environments: ['dev', 'prod'],
  existingProviderArn: app.node.tryGetContext('existingProviderArn'),
});

Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
app.synth();
