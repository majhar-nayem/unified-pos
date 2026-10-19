# Runbook: deploy

Owner: platform (S-INFRA). Related: [rollback](rollback.md), [on-call](on-call.md), [DR drill](dr-restore-drill.md),
[infra/terraform/README.md](../../infra/terraform/README.md), [plan §10](../03-implementation-plan.md).

## Pipelines at a glance

| Trigger         | Workflow                                               | Result                                                                                                                               |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Pull request    | [pr.yml](../../.github/workflows/pr.yml)               | lint, typecheck, unit, golden, integration, cross-tenant, Storybook, images built and scanned (nothing pushed)                       |
| Merge to `main` | [main.yml](../../.github/workflows/main.yml)           | everything above plus e2e, then images to GHCR, copied to dev ECR, migrate dev, deploy dev, smoke                                    |
| Tag `v*`        | [release.yml](../../.github/workflows/release.yml)     | staging migrate and deploy, e2e, k6 and DAST, manual approval, prod expand-only migrate, blue/green deploy with canary and SLO watch |
| Nightly         | [nightly.yml](../../.github/workflows/nightly.yml)     | k6 F10 profile against staging                                                                                                       |
| Infra changes   | [terraform.yml](../../.github/workflows/terraform.yml) | fmt, tflint, validate and a placeholder plan for every environment                                                                   |

Images are built once per commit or tag and pushed to GHCR; each environment copies that digest into its own ECR
([_publish.yml](../../.github/workflows/_publish.yml)). ECR tags are immutable.

## One-time setup of an environment

Do this once per environment, in order. `<env>` is `dev`, `staging` or `prod-au`; `PREFIX` is `pos-<env>`.

1. **State and infrastructure.** Follow [infra/terraform/README.md](../../infra/terraform/README.md): bootstrap the state bucket, fill
   `envs/<env>/terraform.tfvars` (account id, repository, ACM certificates, CloudFront prefix list id, alert endpoints), then
   `terraform apply`. Review the plan; `prod-au` is applied by two people.
2. **Secrets.** Terraform creates empty secrets. Fill them (values never go through Terraform or the pipeline):

   ```bash
   export AWS_REGION=ap-southeast-2 PREFIX=pos-dev
   # identity keys (prints values; paste into the secret JSON, do not log them)
   pnpm --filter @pos/api auth:keygen
   aws secretsmanager put-secret-value --secret-id "$PREFIX/auth" --secret-string file://auth.json
   #   keys: AUTH_JWT_KID, AUTH_JWT_PRIVATE_KEY, AUTH_JWT_PUBLIC_JWKS, AUTH_SECRETS_KEY
   aws secretsmanager put-secret-value --secret-id "$PREFIX/operator" --secret-string '{"AUTH_OPERATOR_TOKENS":"<uuid>:op_<random>"}'
   aws secretsmanager put-secret-value --secret-id "$PREFIX/observability/backend" \
     --secret-string '{"endpoint":"https://<otlp-gateway>/otlp","auth_header":"Basic <token>"}'
   ```

   Operator ids must be UUIDs. Rotate `AUTH_*` and operator tokens by writing a new secret version and redeploying.

3. **Database roles.** The Aurora master user is only for bootstrap and migrations. Create the application login and store its URL:

   ```bash
   # 1. master credentials: Secrets Manager secret from the aurora module output `aurora_master_secret_arn`
   # 2. store the migration URL (master or a dedicated BYPASSRLS role) and the application secrets
   aws secretsmanager put-secret-value --secret-id "$PREFIX/migrate/database" \
     --secret-string '{"DATABASE_URL":"postgres://<user>:<url-encoded-password>@<writer-endpoint>:5432/pos?sslmode=require"}'
   aws secretsmanager put-secret-value --secret-id "$PREFIX/api/database" \
     --secret-string '{"password":"<new>","DATABASE_URL":"postgres://app_rw:<new>@<writer-endpoint>:5432/pos?sslmode=require"}'
   aws secretsmanager put-secret-value --secret-id "$PREFIX/worker/database" \
     --secret-string '{"DATABASE_URL":"postgres://app_rw:<new>@<writer-endpoint>:5432/pos?sslmode=require"}'
   ```

   The migration role must be a superuser or hold `BYPASSRLS` (`@pos/db migrate` refuses otherwise). Check the Aurora master user:
   `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;`. If it is false, create a migration role with `BYPASSRLS` and use its URL.

   Payments uses its own database role and secret (`$PREFIX/payments/database`). The repository does not define that role's grants yet
   (`packages/db/src/roles.ts` only has the application role): the payments stream and the integration lead must provide the matrix
   before the first production deploy. Provider credentials go in `$PREFIX/payments/provider` (keys `config`, `webhook_signing_keys`).

4. **GitHub.** Create the Environments `dev`, `staging`, `prod-au` and `prod-au-approval` (required reviewers; restrict `prod-au` to tags `v*`).
   Set these Environment variables (from `terraform output`):

   | Variable                  | Value                                                        |
   | ------------------------- | ------------------------------------------------------------ |
   | `AWS_DEPLOY_ROLE_ARN`     | `deploy_role_arn` output (trusted for this Environment only) |
   | `AWS_REGION`              | `ap-southeast-2`                                             |
   | `PREFIX`                  | `pos-<env>`                                                  |
   | `BASE_URL`                | public API URL through CloudFront, e.g. `https://api.dev.…`  |
   | `MIGRATE_SUBNETS`         | `migrate_network.subnets`, comma separated                   |
   | `MIGRATE_SECURITY_GROUPS` | `migrate_network.security_groups`, comma separated           |

   Secret `E2E_OPERATOR_TOKEN` on `staging` (an operator token for tests). Repository variable `DEPLOY_ENABLED=true` switches the dev deployment on
   in `main.yml`; `NIGHTLY_LOAD_ENABLED=true` enables the scheduled load run; `CODEQL_ENABLED=true` on private repositories with Advanced Security.

5. **Create the application role and run the first migration** from the pipeline (push to `main`), or by hand:

   ```bash
   export PREFIX=pos-dev SUBNETS=subnet-a,subnet-b SECURITY_GROUPS=sg-0123
   infra/scripts/migrate-task.sh "<account>.dkr.ecr.ap-southeast-2.amazonaws.com/$PREFIX/migrate:<tag>"
   # application role (grants matrix), once and after changing the password:
   aws ecs run-task --cluster "$PREFIX" --launch-type FARGATE --task-definition "$PREFIX-migrate" \
     --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SECURITY_GROUPS],assignPublicIp=DISABLED}" \
     --overrides '{"containerOverrides":[{"name":"migrate","command":["pnpm","--filter","@pos/db","grants"]}]}'
   ```

6. **Bootstrap images.** Terraform seeds the task definitions with tag `bootstrap`, which does not exist. The first pipeline run registers real
   revisions; until then the services show zero running tasks and the running-tasks alarms fire. That is expected on a new environment.
7. **First tenant.** Create it with the operator token as in [docs/releases/f1.md](../releases/f1.md) ("Running it").

## A normal release

1. Merge to `main`. Dev deploys automatically. Check `main` is green and the smoke step passed.
2. Tag the release: `git tag v1.4.0 && git push origin v1.4.0`.
3. The pipeline deploys staging and runs e2e, k6 (`PROFILE=staging`) and the ZAP API scan. Read the k6 summary artifact against the SLO table in
   [infra/load/README.md](../../infra/load/README.md). A High DAST finding or a missed threshold stops the release.
4. Approve `prod-au-approval` only after reading: the staging results, the migration list (`git diff <previous-tag>..HEAD -- packages/db/migrations`),
   open incidents, and that nobody is mid-release elsewhere.
5. Production migrates (expand-only; the job rejects destructive statements) and deploys: worker and payments roll, then the api shifts 10 % of
   traffic to the new task set and soaks for **30 minutes** while the SLO burn-rate alarms are watched. CodeDeploy rolls back automatically if one
   fires. After 100 % the old task set stays up for 60 minutes, then a 10 minute SLO watch runs.
6. Watch during the soak: CloudWatch alarms `pos-prod-au-slo-availability-*`, ALB 5xx and p95 latency, Grafana RED dashboards for `api` by route,
   `worker` outbox backlog, and `payments` uncertain count. Anyone watching may stop the deployment: [rollback.md](rollback.md).

## Migrations: expand then contract

- A release only contains **expand** changes: new tables, new nullable columns, new indexes, new functions. Code in that release must work with
  both the old and the new schema, so a code rollback never needs a schema rollback ([plan §10](../03-implementation-plan.md)).
- **Contract** changes (drops, renames, type changes, `NOT NULL` on existing columns) ship one release later, behind a feature flag, in a file marked
  `-- phase: contract`. The release workflow's guard ([check-expand-only.sh](../../infra/scripts/check-expand-only.sh)) refuses both destructive
  statements and the contract marker, so contract migrations run only from a deliberate manual run of the migrate workflow with `expand_only: false`,
  approved by a second engineer.
- Large index builds use `CREATE INDEX CONCURRENTLY` in their own migration file. Migrations are immutable once applied (checksum guard).

## Manual deploy (when the pipeline is unavailable)

```bash
export PREFIX=pos-staging AWS_REGION=ap-southeast-2
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.$AWS_REGION.amazonaws.com
infra/scripts/migrate-task.sh <ecr>/$PREFIX/migrate:<tag>        # needs SUBNETS and SECURITY_GROUPS
infra/scripts/ecs-deploy.sh worker   <ecr>/$PREFIX/worker:<tag>
infra/scripts/ecs-deploy.sh payments <ecr>/$PREFIX/payments:<tag>
infra/scripts/api-bluegreen.sh       <ecr>/$PREFIX/api:<tag>
infra/scripts/smoke.sh https://api.staging.example.com
```

Production manual deploys need a second person on the call and a note in the incident channel.

## After `terraform apply`

Terraform changes to environment variables or secrets references create a new task-definition revision but do not roll the services (CI owns the running
revision). Run the deploy scripts with the current image tag to roll them. Secret value changes need a service restart (`ecs-deploy.sh` with the same image).

## Observability wiring

All three services start with `NODE_OPTIONS=--import @pos/observability/register` and send OTLP/HTTP to the collector at
`http://otel.<PREFIX>.pos.local:4318`, which exports to the backend in `$PREFIX/observability/backend`. Operational gauges also reach CloudWatch (namespace `POS/App`)
so paging does not depend on the backend. Without a collector the preload is inert.
