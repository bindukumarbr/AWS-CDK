#!/usr/bin/env node
/**
 * Entry point for the platform app.
 *
 *   npx cdk synth  -c stage=dev
 *   npx cdk deploy -c stage=dev  --all
 *   npx cdk deploy -c stage=prod --all     (CI does this behind a manual approval)
 */
import { App } from 'aws-cdk-lib';
import { getStageConfig } from '../lib/config';
import { addGuardrails, createPlatform } from '../lib/platform';

const app = new App();
const stage = app.node.tryGetContext('stage') ?? 'dev';

createPlatform(app, getStageConfig(stage));
addGuardrails(app);

app.synth();
