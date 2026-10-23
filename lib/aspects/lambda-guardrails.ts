/**
 * LambdaGuardrails: a custom CDK Aspect that enforces OUR platform rules on every Lambda function.
 *
 * Aspects are CDK's visitor mechanism: they walk the whole construct tree at synth time and can
 * inspect or modify any construct. cdk-nag itself is built on this idea. Writing your own is how a
 * platform team encodes organisation-specific rules that no public rule pack knows about.
 *
 * Rules here (all produce synth-time ERRORS, so a violating change never reaches CloudFormation):
 *   1. X-Ray tracing must be ACTIVE.
 *   2. Runtime must be a supported modern Node.js (rejects EOL runtimes before AWS does).
 *   3. Architecture must be ARM64 (Graviton) unless explicitly exempted.
 *
 * Aspect vs cdk-nag suppression vs Service Control Policy:
 *   - Aspect ........ fails at synth, in the developer's terminal/PR. Fast feedback, advisory.
 *   - SCP ........... enforced by AWS Organizations at API level. Cannot be bypassed, but the error appears at deploy time.
 *   Use both for rules that matter: Aspect for fast feedback, SCP as the hard backstop.
 */
import { Annotations, IAspect } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { IConstruct } from 'constructs';

const ALLOWED_RUNTIMES = new Set(['nodejs22.x', 'nodejs24.x']);
/** Construct IDs that are allowed to opt out of ARM64 (e.g. a native dependency without an arm64 build). */
const X86_EXEMPT_TAG = 'platform:allow-x86';

export class LambdaGuardrails implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof lambda.Function)) return;

    const cfn = node.node.defaultChild as lambda.CfnFunction;

    if (!cfn.tracingConfig || (cfn.tracingConfig as lambda.CfnFunction.TracingConfigProperty).mode !== 'Active') {
      Annotations.of(node).addError('LambdaGuardrails: X-Ray tracing must be Active (set `tracing: Tracing.ACTIVE`).');
    }

    if (!ALLOWED_RUNTIMES.has(node.runtime.name)) {
      Annotations.of(node).addError(
        `LambdaGuardrails: runtime "${node.runtime.name}" is not allowed. Allowed: ${[...ALLOWED_RUNTIMES].join(', ')}.`,
      );
    }

    const isArm = node.architecture === lambda.Architecture.ARM_64;
    const exempt = node.node.tryGetContext(X86_EXEMPT_TAG) === node.node.path;
    if (!isArm && !exempt) {
      Annotations.of(node).addError('LambdaGuardrails: use ARM64 (Graviton) for ~20% lower cost per ms.');
    }
  }
}
