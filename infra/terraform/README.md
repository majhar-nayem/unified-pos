# infra/terraform

AWS baseline for `ap-southeast-2` ([docs/01-system-architecture.md §4, §12, §13](../../docs/01-system-architecture.md),
[docs/03-implementation-plan.md §10](../../docs/03-implementation-plan.md)).

```
bootstrap/         state bucket, once per account
envs/{dev,staging,prod-au}/   thin roots: providers, backend, sizing, placeholder.tfvars
stack/             composition shared by every environment
modules/           network, kms, storage, secrets, ecr, aurora, redis, ecs-cluster, ecs-service,
                   otel-collector, edge (ALB + CloudFront + WAF), github-oidc, alarms
```

## What an environment contains

| Area      | Resources                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Network   | VPC, public / private / isolated subnets per AZ, NAT, S3 gateway and interface endpoints, flow logs                                          |
| Data      | Aurora PostgreSQL 16 (writer + readers, PITR, KMS, TLS enforced, pgaudit), ElastiCache Redis 7 (TLS, auth token, Multi-AZ, no stream eviction) |
| Storage   | receipts and exports buckets, audit-anchor bucket with Object Lock COMPLIANCE, ALB log bucket, ECR (immutable tags, scan on push)             |
| Compute   | ECS cluster, services `api` (CodeDeploy blue/green, 10 % canary, 30 min soak), `worker`, `payments`, one-off `migrate` task, OTel collector  |
| Edge      | CloudFront + WAF (managed rules, rate limit) → ALB reachable only from CloudFront; provider webhooks routed to `payments`                    |
| Secrets   | KMS keys `data`, `secrets`, `payments`, `logs`; Secrets Manager containers (values set out of band)                                          |
| Delivery  | GitHub OIDC deploy role bound to the GitHub Environment, read-only plan role for pull requests                                              |
| Alerting  | SNS page and ticket topics, infra alarms, application alerts and burn-rate composites generated from `packages/observability`                |

Payments is isolated: own task role without S3, own KMS key for its secrets, own database role and secret.
The api and worker roles cannot decrypt payments secrets.

## Offline validation and plan (no credentials)

```bash
infra/scripts/tf-offline.sh dev plan        # writes envs/dev/plan.offline.txt
infra/scripts/tf-offline.sh staging validate
terraform fmt -recursive -check infra/terraform
(cd infra/terraform && tflint --init && tflint --recursive)
```

The script swaps the S3 backend for a local one and uses `placeholder.tfvars`. Nothing is applied.

## First deployment of an account

1. `bootstrap/`: `terraform apply -var account_id=<id>` with an admin profile.
2. Replace the bucket name in `envs/<env>/backend.tf`, create `terraform.tfvars` (gitignored) with the real
   account id, repository, ACM certificates, CloudFront prefix list id and alert endpoints.
3. `terraform init && terraform apply` in `envs/<env>`, then follow [docs/runbooks/deploy.md](../../docs/runbooks/deploy.md)
   to set secret values, create the application database roles and push the first images.

## Things to verify at first apply

- Prefix list id for `com.amazonaws.global.cloudfront.origin-facing` in ap-southeast-2; it counts as 55 security group rules, so raise the quota.
- ADOT collector image tag (`otel-collector` module default) exists; Renovate tracks it afterwards.
- The Aurora master user holds `BYPASSRLS` or is a superuser (`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`); `@pos/db migrate` refuses to run otherwise. Otherwise create a dedicated migration role and store its URL in the `migrate/database` secret.
- CloudWatch EMF dimension naming for the `POS/App` metrics (`service.name`) once the collector is running.
