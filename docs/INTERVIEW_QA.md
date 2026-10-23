# Interview Q&A for this project

Format of every answer: **answer first → mechanism → trade-off.** Each is written to be spoken in 60–90 seconds.
Where a number or an outcome from your real work belongs, it says `[YOUR NUMBER]`: **use your true figure or drop the claim.**
Nothing here is invented experience. Hooks to your real work are marked **Bridge** and come from what you've told me about Emmes
(Lambda→ECS migration, DynamoDB GSIs/Streams, SQS FIFO, Okta + Lambda Authorizer, CodeBuild/CodeArtifact pipeline debugging, CDK in services).

How to introduce the project: _"To close the gap between my service-level CDK work and a full DevOps platform, I built a reference project:
two stacks, reusable constructs, policy-as-code, and a GitHub OIDC pipeline with security gates. It's not production, but I can walk through every decision."_

---

## A. CDK fundamentals

**1. What are L1, L2 and L3 constructs, and which do you use?**
L1 constructs (`CfnBucket`) are a 1:1 mapping of CloudFormation resources, with no defaults. L2 (`s3.Bucket`) wrap them with sensible
defaults, helper methods and grants. L3, also called patterns, assemble several resources into a use case, like `ApplicationLoadBalancedFargateService`.
I default to L2, and I write my own L3-style constructs when a team needs the same safe defaults repeatedly. `SecureBucket` in my project is one: TLS-only, blocked
public access, versioning, lifecycle. I drop to L1 or `addPropertyOverride` only when an L2 doesn't expose a property. Trade-off: L3 patterns get you running fast but hide security-group and
listener wiring, so I built the ECS service from L2 to control egress rules and the HTTP→HTTPS redirect.
**Bridge:** the CDK I wrote at Emmes was L2-level service infrastructure; this extends it to reusable platform constructs.

**2. Why two stacks, and what's the catch?**
I split by change frequency and risk. Foundation holds stateful, slow-changing things (VPC, RDS, DynamoDB) with termination protection and RETAIN. The app stack is stateless and deploys on every merge, so a bad deploy rolls back
without touching data. The catch is cross-stack references: CDK turns them into CloudFormation exports, and an export can't change or be removed while another stack imports it. The alternative is SSM parameters,
which are looser but lose compile-time wiring.

**3. You hit a circular dependency. What happened?**
`database.connections.allowDefaultPortFrom(service)` creates the ingress rule in the _database's_ stack, but that rule references the service security group in the app stack. The app stack already depends on foundation, so
foundation → app plus app → foundation is a cycle, and `synth` fails. The fix is to import the DB security group by ID inside the app stack and add the ingress rule to that imported group. Then the rule lives in the app stack and the arrow points one way.
General rule: put cross-stack rules in the _consumer's_ stack.

**4. How do you test CDK code?**
Three layers. Fine-grained assertions with `Template.fromStack` for invariants I care about: encrypted DB, least-privilege IAM actions, `AssignPublicIp: DISABLED`, circuit breaker on. Policy tests that synth the whole app through cdk-nag, which fails on violations.
And negative tests that prove the gates reject bad infrastructure. I avoid snapshots as the main tool because they fail on every harmless change and train people to run `jest -u`. A snapshot is fine for
a stable L3 construct you publish. **Trade-off:** assertions need me to know which properties matter; snapshots are cheaper to write but noisier.

**5. What is an Aspect, and how is it different from cdk-nag?**
An Aspect visits every construct in the tree at synth, so it can inspect or modify it. cdk-nag is built on the same idea, but as policy validation. I wrote a `LambdaGuardrails` Aspect that errors if a function lacks X-Ray tracing,
uses an unsupported runtime, or isn't ARM64. Use Aspects for org-specific rules no public pack knows. And Aspects and cdk-nag give fast feedback in the PR; for rules that must be unbreakable, back them with an SCP, because an SCP is enforced by AWS Organizations and can't be bypassed from CDK.

**6. How do you use cdk-nag and handle suppressions?**
I run the AwsSolutions pack on the whole app and `synth` fails on violations, so CI needs no extra step. Every exception is an explicit `acknowledge({ id, reason })` on the narrowest construct that applies, with a real reason, for example "X-Ray doesn't support
resource-level permissions". In cdk-nag v3 this uses CDK's native `Validations` API, and findings are acknowledged individually, like `IAM5[Resource::*]`. A suppression without a reason is a disabled alarm, so I review them like code.

**7. What does `cdk bootstrap` create, and why does it matter for CI?**
It creates the staging resources CDK needs: an S3 bucket for assets, an ECR repo for images, and IAM roles: deploy, file-publishing, image-publishing and lookup, plus a CloudFormation execution role. My CI role's only permission is `sts:AssumeRole`
on those roles, so real permissions live in one place. Caveat to mention: the default execution policy is `AdministratorAccess`; for a regulated environment I'd scope it with custom `--cloudformation-execution-policies` and a permissions boundary.

**8. A teammate renames a construct ID. What happens?**
The logical ID changes, so CloudFormation sees a new resource and a deleted one, which means **replacement**. For a database that means data loss unless it's protected. That's why stateful resources have RETAIN/deletion protection, live in their own stack, and
I always read `cdk diff` for the word "replace" before deploying. If I must rename, I use `overrideLogicalId` to keep the old ID.

## B. CI/CD and security gates

**9. Explain GitHub Actions → AWS with OIDC.**
The workflow requests a short-lived JWT from GitHub that says which repo and environment is running. It calls `AssumeRoleWithWebIdentity`; AWS verifies the signature against the registered OIDC provider and checks the role's trust policy.
The conditions that matter: `aud = sts.amazonaws.com` and `sub = repo:ORG/REPO:environment:prod`. Without a tight `sub`, any repo on GitHub could assume the role. Credentials last about an hour, so there's nothing to leak or rotate.
I use two roles: a read-only one for PRs and a deploy one only the protected `dev`/`prod` environments can assume, and prod needs a human reviewer.

**10. What security checks run in your pipeline, and why those?**
Each catches a different class. Dependency scanning (npm audit, plus Dependabot) for known CVEs. gitleaks over full git history for leaked secrets. Semgrep for insecure patterns in our own code. cdk-nag and Checkov for infrastructure misconfiguration, two scanners because Checkov reads the _final_ template and catches
what escapes CDK-level checks. Trivy for the container image. I fail on HIGH/CRITICAL fixable issues only (`--ignore-unfixed`), otherwise the build is red for things nobody can act on. Exceptions are written down in `.checkov.yaml` with reasons.
**Bridge:** at Emmes I debugged real CodeBuild failures against CodeArtifact (a Yarn authentication issue and a stale `.npmrc` with committed credentials), which is exactly why a secret scan in CI matters.

**11. How do you deploy to production safely and roll back?**
Merge to main runs all gates, deploys dev, smoke-tests through the load balancer, then waits for a manual approval before prod. Three rollback layers: the ECS deployment circuit breaker auto-rolls back the service if new tasks fail health checks; CloudFormation auto-rolls back a failed stack update;
and for a bad-but-healthy release I revert the commit and redeploy, since immutable image hashes mean the previous image is still in ECR. For canary or traffic-shifting I'd move to CodeDeploy blue/green with alarm-based rollback, at the cost of more moving parts.
`[YOUR NUMBER: how your Lambda→ECS cutover was staged and rolled back]`

**12. GitHub Actions vs CDK Pipelines/CodePipeline vs Jenkins?**
GitHub Actions when code, review and scanning already live in GitHub, with the least infrastructure. CDK Pipelines (CodePipeline) when the org mandates AWS-native tooling, wants a self-mutating pipeline, or deploys cross-account from a central tools account.
Jenkins when there's a large existing investment, at the cost of running and patching it yourself. I chose Actions + OIDC for this project because there's nothing to operate.

## C. Compute, data and networking

**13. Why ECS Fargate rather than Lambda, EC2 or EKS for the web tier?**
It's a steady service holding database connections. Lambda would need RDS Proxy to avoid exhausting connections. EC2 means AMI patching and capacity management. EKS adds a control plane and upgrade work I'd only take on for the Kubernetes ecosystem (operators, mesh, portability).
Fargate costs somewhat more per vCPU for zero host management. **Bridge:** I led a Lambda→ECS migration at Emmes, so I know the trade-off from the other side. `[YOUR NUMBER: why you migrated and what changed in cost/latency]`
**Honest edge:** I haven't run production EKS; I understand node groups, IRSA and add-ons conceptually and would ramp quickly.

**14. How do you get zero-downtime deploys on ECS?**
`minHealthyPercent 100` and `maxHealthyPercent 200` start new tasks before stopping old ones. The ALB health check hits `/health`, which checks only the process; I deliberately don't include the database, because a DB blip would then mark every task unhealthy and turn a partial problem into a full outage.
The container handles SIGTERM, stops accepting connections and drains, with a 30 s `stopTimeout`. Deregistration delay is 30 s instead of the 300 s default so deploys don't crawl. The circuit breaker rolls back if the new tasks never become healthy.

**15. RDS: Multi-AZ vs read replica, and RDS vs Aurora?**
Multi-AZ is for availability: a synchronous standby in another AZ with automatic failover (~1–2 minutes); you can't read from it in the standard Multi-AZ instance setup. Read replicas are for read scaling, asynchronous, and promoting one is a manual DR step.
Aurora gives faster failover and up to 15 low-lag readers on shared storage, plus Serverless v2, at a higher price. For a small relational workload I'd run RDS Postgres Multi-AZ in prod and move to Aurora when read scaling or failover time becomes a requirement.
My project turns Multi-AZ on only in prod, and cdk-nag's RDS3 rule is acknowledged in dev only.

**16. What's the secret-rotation gotcha?**
Rotation runs a Lambda in the database's subnets. My DB is in isolated subnets with no internet path, so that Lambda can't reach Secrets Manager unless there's a VPC interface endpoint. Without it, deploy succeeds and rotation fails 30 days later.
The endpoint costs money, so I enable it in prod only. Related: ECS injects secrets at task start, so a rotated password is only picked up by new tasks; the fix is re-fetching on auth failure or moving to IAM database auth.

**17. How did you design the DynamoDB table?**
Partition key `orderId` for get-by-id, and a GSI `byCustomer` (customerId, createdAt) for "a customer's orders, newest first". On-demand billing so there's no capacity planning, PITR for point-in-time restore, and deletion protection plus RETAIN in prod. The Lambda gets `PutItem`/`GetItem` on the table and `Query` on that one index ARN, not `table.grant()`,
which adds `index/*` as a wildcard. Query has a `Limit`, because an unbounded query is a latent cost and latency bug.
**Bridge:** I've used GSIs and Streams in production at Emmes, and my LSP design uses a two-table split so audit data gets separate IAM isolation.

**18. Walk me through the network and what it costs.**
Three tiers: public (ALB, NAT), private (Fargate with egress through NAT), isolated (RDS with no internet route either way). Free gateway endpoints for S3 and DynamoDB keep that traffic off the NAT, which bills per GB.
NAT gateways are usually the biggest line in a small VPC, so dev uses one and prod uses one per AZ for availability. Flow logs go to CloudWatch for investigations. I didn't add ECR/Logs interface endpoints because at one or two tasks the NAT is cheaper; at scale, or with a "no internet egress" rule, I would.
Security groups are SG-to-SG, with egress locked down (443 and Postgres only) rather than allow-all.

## D. Observability and operations

**19. What do you alarm on, and how do you avoid noise?**
Symptoms users feel, not internal causes: API 5xx, Lambda errors and p95 latency, target 5xx and unhealthy hosts at the ALB, and RDS CPU and free storage. Alarms use "2 of 3 datapoints" so one blip doesn't page, and `treatMissingData: notBreaching` so no traffic isn't an outage (RDS alarms use breaching,
because missing DB metrics usually _is_ a problem). All alarms go to one SNS topic. The non-obvious bit: the topic needs a customer-managed KMS key whose policy trusts `cloudwatch.amazonaws.com`, otherwise CloudWatch can't publish to it and the alert silently disappears.
**Bridge:** CloudWatch alarms and logging on Lambda/SQS at Emmes.

**20. How would this scale to 20 teams / enterprise?**
Four moves. Publish the constructs as a versioned library (npm) so teams get the safe defaults and upgrade deliberately. Give each team a template repo with the pipeline wired in. Move to multi-account (dev/stage/prod, plus a tools and a log-archive account) under AWS Organizations
with SCPs as the hard backstop for what Aspects and cdk-nag check softly. And centralise: Checkov/cdk-nag results, cost tags (already applied), and a shared OIDC role pattern per account. I'd decide between GitHub Actions and CDK Pipelines for cross-account deploys based on who owns the tooling.
Honest note: this repo is single-account; the multi-account layer is the extension, not something I've built here.
**Bridge:** regulated delivery at Emmes (21 CFR Part 11 / GDPR) means I already work with audit trails, access separation and change control.

---

## E. Likely traps (know your answer)

| Question                                            | Short answer                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Show me where a secret could leak in your design." | Task definition JSON (avoided via ECS `secrets`), CloudFormation template (avoided: generated secret), git history (gitleaks), logs (never log the env).                                          |
| "Why not `AdministratorAccess` for the CI role?"    | OIDC role can only assume CDK bootstrap roles; real permissions come from the CloudFormation execution policy. Blast radius of a compromised workflow is the bootstrap roles, not the account.    |
| "What if someone opens a PR from a fork?"           | The `pull_request` event from a fork gets no OIDC token and no secrets. The diff job only runs where `AWS_DIFF_ROLE_ARN` exists. Never use `pull_request_target` with checkout of untrusted code. |
| "What's your weakest area for this role?"           | Terraform in production and EKS. State what you've done to close it (the bridge doc, the K8s practice) and your ramp-up plan.                                                                     |
| "Any problems deploying it?"                        | Fill in from your first real deploy. This is your best story.                                                                                                                                     |

## F. After every practice answer

Top 2 weaknesses and the next specific thing to study: bring this file to the drill and ask to be questioned on it, one question at a time, with grading.
