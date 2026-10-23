import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { StageConfig, getStageConfig } from '../lib/config';
import { Platform, createPlatform } from '../lib/platform';

export interface Built {
  readonly app: App;
  readonly platform: Platform;
  readonly foundation: Template;
  readonly appStack: Template;
}

/** Builds the real platform (same code path as bin/app.ts) for a stage, optionally with config overrides. */
export function build(stage: 'dev' | 'prod', override?: (c: StageConfig) => StageConfig): Built {
  const app = new App();
  const base = getStageConfig(stage);
  const platform = createPlatform(app, override ? override(base) : base);
  return {
    app,
    platform,
    foundation: Template.fromStack(platform.foundation),
    appStack: Template.fromStack(platform.app),
  };
}

/** Flattens every IAM policy statement in a template: used for least-privilege assertions. */
export function allStatements(template: Template): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const doc = (policy as any).Properties.PolicyDocument;
    out.push(...(Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement]));
  }
  return out;
}

export const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);
