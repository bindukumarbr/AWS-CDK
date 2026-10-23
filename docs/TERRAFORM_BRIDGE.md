# Terraform bridge: from CDK (strength) to Terraform (gap)

The JD says "CDK, Terraform **and** CloudFormation". Your real depth is CDK. The honest, strong answer is
_"I think in desired-state IaC; I know exactly how my CDK maps to Terraform concepts, and here is where the
mapping stops being identical."_ Say where the bridge ends. Do not bluff HCL.

## 1. Concept map

| CDK / CloudFormation                            | Terraform                                           | Where the bridge ends                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Construct (L2/L3)                               | Module                                              | A construct is a class you can unit-test with real code; a module is HCL with inputs/outputs. No loops/conditionals beyond HCL's `for_each`, `count`, `dynamic`.                           |
| Stack (a CloudFormation stack)                  | Root module + **state file**                        | CloudFormation owns state for you. Terraform state is YOUR responsibility: remote backend (S3 + DynamoDB/S3 lock), encryption, access control. This is the biggest operational difference. |
| `cdk diff`                                      | `terraform plan`                                    | Same idea. Plan is also the artifact you can save and apply later (`plan -out`).                                                                                                           |
| `cdk deploy`                                    | `terraform apply`                                   | CloudFormation rolls back failed updates automatically. Terraform does NOT roll back: a failed apply leaves partial changes you reconcile.                                                 |
| `cdk bootstrap`                                 | Creating the remote-state bucket/lock + CI role     | Bootstrap is one command in CDK; in Terraform you build that foundation yourself (or with a bootstrap module).                                                                             |
| Context / `StageConfig`                         | Variables + `*.tfvars` + workspaces                 | I use a typed config object; Terraform uses variable files per environment.                                                                                                                |
| Logical IDs (rename = replacement)              | Resource addresses (rename = destroy/create)        | Same hazard. Terraform fixes it with `moved {}` blocks; CDK with `overrideLogicalId` or careful IDs.                                                                                       |
| `RemovalPolicy.RETAIN` / termination protection | `lifecycle { prevent_destroy = true }`              | Close equivalent.                                                                                                                                                                          |
| Drift detection (CloudFormation drift)          | `terraform plan` shows drift every run              | Terraform's refresh makes drift visible by default. CloudFormation drift detection is a separate action.                                                                                   |
| `cdk import` / resource import                  | `terraform import` / `import {}` blocks             | Terraform has a larger set of importable resources; the import workflow is more manual.                                                                                                    |
| cdk-nag / Aspects                               | Checkov, tfsec/Trivy config, OPA/Conftest, Sentinel | Same policy-as-code idea; in Terraform you scan the **plan JSON** or the HCL.                                                                                                              |
| CDK assertions tests                            | `terraform test`, Terratest                         | `terraform test` (native) for module behaviour; Terratest (Go) deploys real infra.                                                                                                         |
| Providers / multi-cloud                         | Providers                                           | **Terraform's real edge:** one workflow across AWS, GCP, Azure, GitHub, Datadog. CDK is AWS-first (CDKTF exists but is a separate project).                                                |

## 2. Same network, in Terraform (equivalent of `lib/constructs/network.ts`)

> **Not validated here** (no Terraform binary in the build environment). Treat it as a study aid: run
> `terraform init && terraform validate` before you quote it, and check the module's current inputs.

```hcl
terraform {
  required_version = ">= 1.10" # use_lockfile (S3-native state locking) needs 1.10+
  required_providers { aws = { source = "hashicorp/aws", version = "~> 6.0" } }
  # Remote state is what CloudFormation gives you for free. In Terraform YOU set it up:
  # backend "s3" { bucket = "..." key = "orders/dev/network.tfstate" region = "ap-south-1" use_lockfile = true encrypt = true }
}

variable "stage"    { type = string }
variable "vpc_cidr" { type = string }

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = "orders-${var.stage}"
  cidr = var.vpc_cidr
  azs  = ["ap-south-1a", "ap-south-1b"]

  public_subnets   = [cidrsubnet(var.vpc_cidr, 8, 0), cidrsubnet(var.vpc_cidr, 8, 1)]   # ALB + NAT
  private_subnets  = [cidrsubnet(var.vpc_cidr, 8, 10), cidrsubnet(var.vpc_cidr, 8, 11)] # Fargate
  database_subnets = [cidrsubnet(var.vpc_cidr, 8, 20), cidrsubnet(var.vpc_cidr, 8, 21)] # isolated: RDS

  create_database_subnet_group = true  # no route to the internet by default = CDK's PRIVATE_ISOLATED

  enable_nat_gateway = true
  single_nat_gateway = var.stage == "dev" # dev: one shared NAT (cheap). prod: one per AZ.

  enable_flow_log                                 = true
  create_flow_log_cloudwatch_log_group            = true
  create_flow_log_cloudwatch_iam_role             = true
  flow_log_max_aggregation_interval               = 600

  tags = { Project = "orders-platform", Stage = var.stage, ManagedBy = "terraform" }
}
# Gateway endpoints (S3, DynamoDB) live in the companion submodule: terraform-aws-modules/vpc/aws//modules/vpc-endpoints
```

**Reading it as a CDK engineer:** the module call is `new Network(this, 'Network', {...})`. `single_nat_gateway = var.stage == "dev"`
is `natGateways: config.vpc.natGateways`. The `.tfvars` file is `getStageConfig()`. What you do **not** get: compile-time types, a unit-test
framework in the same language, or automatic state management.

## 3. Interview answer (60–90 s): "CDK vs Terraform vs CloudFormation: which and why?"

> "They are all declarative IaC, so the real differences are language, state and scope. CloudFormation is the engine:
> AWS-managed state, automatic rollback, but verbose YAML. CDK generates CloudFormation from TypeScript, so I get
> types, loops, unit tests and reusable constructs, and AWS handles state and rollback for me. That's why I use it for
> AWS-only workloads and where the team already writes TypeScript. Terraform's advantages are multi-cloud and
> multi-provider workflows, a huge module ecosystem and plan output that's easy to review, and the cost is that state is
> mine to run: remote backend, locking, encryption, and no automatic rollback on a failed apply.
> My depth is CDK; I've mapped it to Terraform: construct to module, stack to root module plus state file,
> `cdk diff` to `plan`. Where I'd be learning on the job is state operations: `state mv`, import, workspace and backend design.
> I'd pick by constraint: AWS-only and TypeScript-heavy, CDK; multi-cloud or an org that already standardised on it, Terraform."

## 4. Study checklist for the 1 day you have (highest-value first)

1. State: remote backend (S3 + locking), why state contains secrets, `terraform state mv/rm`, `import`.
2. `plan` → `apply` flow in CI (save the plan, apply the same plan, never re-plan at apply).
3. `count` vs `for_each` (and why index-based `count` causes surprise destroys when a list shifts).
4. Modules: inputs/outputs, versioning/pinning, the registry modules used above.
5. `lifecycle`: `prevent_destroy`, `ignore_changes`, `create_before_destroy`.
6. Provider and version pinning (`.terraform.lock.hcl`), `moved` blocks.
