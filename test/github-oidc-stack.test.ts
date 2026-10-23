import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';
import { allStatements, asArray } from './helpers';

const stack = new GithubOidcStack(new App(), 'oidc', {
  env: { account: '123456789012', region: 'ap-south-1' },
  githubOwner: 'acme',
  githubRepo: 'orders-platform-cdk',
  environments: ['dev', 'prod'],
});
const template = Template.fromStack(stack);

const roles = () => Object.values(template.findResources('AWS::IAM::Role')) as any[];
const byName = (name: string) => roles().find((r) => r.Properties.RoleName === name).Properties;
const conditionOf = (props: any) => props.AssumeRolePolicyDocument.Statement[0].Condition;

describe('GitHub OIDC trust', () => {
  test('registers the GitHub provider with the STS audience', () => {
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
  });

  test('deploy role trusts ONLY this repo and ONLY the protected environments', () => {
    const cond = conditionOf(byName('orders-github-deploy'));
    expect(cond.StringEquals['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
    expect(asArray(cond.StringLike['token.actions.githubusercontent.com:sub']).sort()).toEqual([
      'repo:acme/orders-platform-cdk:environment:dev',
      'repo:acme/orders-platform-cdk:environment:prod',
    ]);
  });

  test('diff role trusts pull requests only', () => {
    const cond = conditionOf(byName('orders-github-diff'));
    expect(asArray(cond.StringLike['token.actions.githubusercontent.com:sub'])).toEqual([
      'repo:acme/orders-platform-cdk:pull_request',
    ]);
  });

  test('no trust condition uses a broad wildcard (the classic "any repo can assume this" bug)', () => {
    for (const role of roles()) {
      const subs = asArray(conditionOf(role.Properties).StringLike['token.actions.githubusercontent.com:sub']);
      for (const sub of subs as string[]) {
        expect(sub).not.toMatch(/\*/);
        expect(sub).toMatch(/^repo:acme\/orders-platform-cdk:/);
      }
    }
  });

  test('roles hold NO service permissions: only sts:AssumeRole on CDK bootstrap roles', () => {
    for (const s of allStatements(template)) {
      expect(asArray(s.Action)).toEqual(['sts:AssumeRole']);
      expect(JSON.stringify(s.Resource)).toContain('role/cdk-hnb659fds-');
    }
  });

  test('diff role can reach only the read-only lookup role', () => {
    const diffPolicy = Object.values(template.findResources('AWS::IAM::Policy')).find((p: any) =>
      JSON.stringify(p.Properties.Roles).includes('DiffRole'),
    ) as any;
    expect(JSON.stringify(diffPolicy.Properties.PolicyDocument)).toContain('lookup-role');
    expect(JSON.stringify(diffPolicy.Properties.PolicyDocument)).not.toContain('deploy-role');
  });

  test('sessions are short-lived (1 hour)', () => {
    for (const role of roles()) expect(role.Properties.MaxSessionDuration).toBe(3600);
  });
});
