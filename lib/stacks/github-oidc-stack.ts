/**
 * GithubOidcStack: lets GitHub Actions deploy to this AWS account WITHOUT any stored AWS keys.
 *
 * How it works (be able to draw this):
 *   1. A workflow run asks GitHub for a short-lived OIDC JWT. The token states WHO is asking:
 *      `sub = repo:ORG/REPO:environment:prod` (or `...:pull_request`), `aud = sts.amazonaws.com`.
 *   2. The workflow calls `sts:AssumeRoleWithWebIdentity`, presenting that JWT.
 *   3. AWS checks the signature against the OIDC provider registered here, then evaluates the role's
 *      TRUST POLICY conditions (`aud` and `sub`). If they match, STS returns credentials valid for ~1 hour.
 *   Nothing long-lived exists to leak, rotate or revoke. The `sub` condition is the security
 *   control: without it, ANY GitHub repository on earth could assume the role.
 *
 * Two roles, least privilege:
 *   - diff role ... assumable from pull requests. Can only assume the CDK *lookup* role (read-only).
 *   - deploy role . assumable only from the protected GitHub Environments (dev/prod). Can only
 *     assume the CDK bootstrap roles; it holds NO direct permissions on any service.
 *
 * Why "assume the CDK bootstrap roles" rather than attach admin permissions to the GitHub role:
 *   `cdk bootstrap` already creates purpose-built roles (deploy, file-publishing, image-publishing,
 *   lookup). The CI role just needs to be allowed to use them, so real permissions stay in one place
 *   and are scoped by CloudFormation execution policy. This is the pattern AWS documents for CDK CI.
 *
 * This stack is deployed ONCE by a human (chicken-and-egg: the pipeline cannot create its own
 * trust). It lives in its own CDK app (bin/github-oidc.ts) so the pipeline never modifies its own permissions.
 *
 * ALT: AWS CodePipeline + CDK Pipelines (self-mutating, all inside AWS, no OIDC needed). Better when
 * the org mandates AWS-native tooling or cross-account deploy from a tools account; GitHub Actions
 * wins when code review, secrets scanning and the rest of the SDLC already live in GitHub.
 */
import * as cdk from 'aws-cdk-lib';
import { Validations } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** e.g. "my-org" */
  readonly githubOwner: string;
  /** e.g. "orders-platform-cdk" */
  readonly githubRepo: string;
  /** GitHub Environments allowed to deploy (must have required reviewers configured for prod). */
  readonly environments: string[];
  /** CDK bootstrap qualifier. Default `hnb659fds` unless you bootstrapped with a custom one. */
  readonly bootstrapQualifier?: string;
  /** An AWS account can hold only ONE provider per issuer URL. Pass its ARN if it already exists. */
  readonly existingProviderArn?: string;
}

const ISSUER_HOST = 'token.actions.githubusercontent.com';

export class GithubOidcStack extends cdk.Stack {
  public readonly deployRole: iam.Role;
  public readonly diffRole: iam.Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, {
      ...props,
      description: 'GitHub Actions OIDC trust + least-privilege CI roles for CDK deploys. Deploy once, by hand.',
    });

    const qualifier = props.bootstrapQualifier ?? 'hnb659fds';
    const repo = `${props.githubOwner}/${props.githubRepo}`;

    const providerArn =
      props.existingProviderArn ??
      new iam.OidcProviderNative(this, 'GitHubProvider', {
        url: `https://${ISSUER_HOST}`,
        clientIds: ['sts.amazonaws.com'],
      }).oidcProviderArn;

    // Trust policy builder. StringEquals on `aud` and StringLike on `sub` (no wildcards beyond the
    // exact repo/environment strings we enumerate: never `repo:ORG/*`).
    const trustedFor = (subjects: string[]): iam.WebIdentityPrincipal =>
      new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { [`${ISSUER_HOST}:aud`]: 'sts.amazonaws.com' },
        StringLike: { [`${ISSUER_HOST}:sub`]: subjects },
      });

    // CDK bootstrap role ARNs: cdk-<qualifier>-<purpose>-role-<account>-<region>
    const bootstrapRoleArn = (purpose: string): string =>
      `arn:${this.partition}:iam::${this.account}:role/cdk-${qualifier}-${purpose}-role-${this.account}-*`;

    this.diffRole = new iam.Role(this, 'DiffRole', {
      roleName: 'orders-github-diff',
      description: 'GitHub Actions on pull requests: read-only CDK lookups for `cdk diff`.',
      assumedBy: trustedFor([`repo:${repo}:pull_request`]),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.diffRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkLookupRoleOnly',
        actions: ['sts:AssumeRole'],
        resources: [bootstrapRoleArn('lookup')],
      }),
    );

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'orders-github-deploy',
      description: 'GitHub Actions deploy from protected Environments only.',
      assumedBy: trustedFor(props.environments.map((env) => `repo:${repo}:environment:${env}`)),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(bootstrapRoleArn),
      }),
    );

    // cdk-nag flags the `-*` region suffix in the bootstrap role ARNs as a wildcard. It is intentional and as narrow as it can
    // be: the roles exist once per region (cdk-<qualifier>-<purpose>-role-<account>-<region>), and a role that deploys to several
    // regions needs all of them. Acknowledged per finding, with the reason, so any NEW wildcard still fails the build.
    // (nag renders the partition token as <AWS::Partition>; the account is concrete when the stack has an env.)
    const account = cdk.Token.isUnresolved(this.account) ? '<AWS::AccountId>' : this.account;
    const nagArn = (purpose: string): string =>
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::${account}:role/cdk-${qualifier}-${purpose}-role-${account}-*]`;
    const reason =
      'Region suffix of the CDK bootstrap role name; the role set exists once per bootstrapped region. Scope is still one account, one qualifier, one purpose.';
    Validations.of(this.diffRole).acknowledge({ id: nagArn('lookup'), reason });
    for (const purpose of ['deploy', 'file-publishing', 'image-publishing', 'lookup']) {
      Validations.of(this.deployRole).acknowledge({ id: nagArn(purpose), reason });
    }

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Set as GitHub repo variable AWS_DEPLOY_ROLE_ARN',
    });
    new cdk.CfnOutput(this, 'DiffRoleArn', {
      value: this.diffRole.roleArn,
      description: 'Set as GitHub repo variable AWS_DIFF_ROLE_ARN',
    });
  }
}
