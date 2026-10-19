# Stream S-INFRA: delivery baseline

Status of the S-INFRA stream ([03-implementation-plan.md §4, §10, §15](../03-implementation-plan.md)) in the format of [§14](../03-implementation-plan.md).
Everything is uncommitted in the working tree. **Nothing was applied to AWS and no real credentials were used**: Terraform was validated and planned offline with placeholder values.

Verified locally on 2026-10-18 (Docker running):

| Check                                                                                     | Result                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `terraform fmt -check`, `terraform validate` (dev, staging, prod-au)                      | clean (Terraform 1.16.6, AWS provider ~> 5.0)                                                                                           |
| `tflint --recursive` (terraform ruleset recommended + AWS ruleset 0.38.0)                 | clean                                                                                                                                   |
| `infra/scripts/tf-offline.sh <env> plan` with `placeholder.tfvars`, no credentials        | dev 251, staging 263, prod-au 267 resources to add; dev plan in [plan.offline.txt](../../infra/terraform/envs/dev/plan.offline.txt)     |
| `actionlint` 1.7.12 with `shellcheck` 0.11 (11 workflows, 1 composite action, 10 scripts)  | clean                                                                                                                                   |
| `pnpm --filter @pos/observability build && test`                                          | 62 tests in 6 files, green                                                                                                              |
| `pnpm --filter @pos/worker build && test` (Testcontainers postgres:16 and redis:7)        | 23 tests in 6 files, green (4 unit, 19 integration: relay 3, job runner 6, outbox gauges 5, bootstrap 5)                                |
| `eslint packages/observability apps/worker infra`, `prettier --check` on every owned path | clean                                                                                                                                   |
| Docker: `api`, `worker`, `payments`, `migrate` images from `infra/docker/Dockerfile`      | all build; runtime images 58 MB (worker) and 124 MB (payments); non-root, read-only root filesystem                                     |
| Migrate image on a fresh postgres:16, twice                                               | applied 0001, 0002, 0003; second run a no-op                                                                                            |
| api image + postgres + redis, read-only filesystem, preload on, `smoke.sh` and k6 `smoke` | `smoke.sh` 3 of 3; k6 117 of 117 checks, 19 orders placed, 0 failed requests                                                            |
| Preload against a fake OTLP collector                                                     | traces (HTTP server and client spans plus a manual span), metrics and logs arrive; the log line carries `trace_id`, emails are redacted |

The root `pnpm build`, `pnpm test` and `pnpm format` were **not** run (§15.2 rule 2).

## Features and status

| Feature                                                                                                                                    | Status              | Evidence                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------- |
| Terraform modules: network, kms, storage, secrets, ecr, aurora, redis, ecs-cluster, ecs-service, otel-collector, edge, github-oidc, alarms | implemented         | validate, tflint, offline plans                                                                          |
| Per-environment stacks dev, staging, prod-au (shared `stack/`), state bootstrap                                                            | implemented         | offline plans; never applied                                                                             |
| Aurora PostgreSQL 16, writer + reader(s) in separate AZs, PITR, KMS, TLS enforced, pgaudit                                                 | implemented         | plan only                                                                                                |
| ElastiCache Redis 7, TLS, auth token in Secrets Manager, Multi-AZ, no eviction of streams                                                  | implemented         | plan only                                                                                                |
| ECS Fargate api / worker / payments, payments with its own task role, KMS key, secret and database role                                    | implemented         | plan only; images run locally                                                                            |
| CloudFront + WAF + ALB (reachable from CloudFront only), webhooks routed to payments                                                       | implemented         | plan only                                                                                                |
| Blue/green deploy of the api (CodeDeploy, 10 % canary, soak, alarm-driven rollback)                                                        | implemented         | plan only; scripts shellchecked; **not exercised on AWS**                                                |
| S3: receipts, exports, audit anchors with Object Lock COMPLIANCE, ALB logs; ECR immutable + scan                                           | implemented         | plan only                                                                                                |
| GitHub OIDC deploy role (bound to a GitHub Environment) and read-only plan role                                                            | implemented         | plan only                                                                                                |
| CloudWatch alarms (infra) and application alerts generated from code, multi-window SLO burn rates                                          | implemented         | tests on definitions; plan shows 17 alarms and 3 composites per environment                              |
| OpenTelemetry collector (ADOT) with redaction and a CloudWatch EMF path for paging                                                         | implemented         | plan only; the image tag is unverified (see limitations)                                                 |
| PR, main, release, nightly, security and Terraform pipelines, Renovate                                                                     | implemented         | actionlint; image build, migrate, smoke and k6 steps exercised locally; **no GitHub run yet**            |
| Reusable migration job (`_migrate.yml`) with expand-only guard                                                                             | implemented         | guard tested on a throwaway repo; migrate image tested on postgres:16; ECS run-task path not run         |
| `packages/observability`: `startTelemetry`, pino logger with trace correlation, PII redaction, RED helpers                                 | tested              | 62 tests, plus the preload check against a fake collector                                                |
| Operational gauges (outbox backlog and age, stream lag, sync lag, payment uncertain, RLS missing, audit failure, cross-tenant)             | implemented         | helpers tested; **only the outbox gauges and stream lag are wired** (worker); others need their owners   |
| `apps/worker` bootstrap: telemetry, Postgres + Redis readiness, outbox relay, consumer group with `processed_events`, BullMQ job runner    | tested              | 19 integration tests                                                                                     |
| k6 F10 profile (1k registers, 200 orders/s, 10x catalog burst), self-provisioning, SLO thresholds                                          | tested (smoke only) | smoke against the real api image; TOTP self-test against RFC 6238; **staging and full profiles not run** |
| Runbooks: deploy, rollback, DR restore drill, on-call                                                                                      | implemented         | alert-to-runbook anchors checked by a test; procedures not yet rehearsed                                 |
| Preview environment per pull request (`preview-<pr>`)                                                                                      | planned             | needs a Terraform workspace per PR and an ephemeral seed; not built                                      |
| Region-loss recovery, dashboards as code, webhook-failure and store-offline alerts                                                         | planned             | see limitations                                                                                          |

## Architectural decisions

No ADR files were written (`docs/adr/**` belongs to S-DOCS). Decisions to record there:

1. **One stack module, thin environment roots.** `infra/terraform/stack` composes everything; each `envs/<env>` only sets providers, backend, sizing and placeholders. Differences between environments are visible in one file each.
2. **Build once, copy by digest.** Images are built into GHCR once per commit or tag and copied into each environment's ECR (immutable tags), so staging and production run the same bytes even across AWS accounts.
3. **Migrations run as a Fargate task inside the VPC**, not from a GitHub runner: Aurora has no public path and the migration role needs superuser or `BYPASSRLS`. Expand-only is enforced in the release pipeline by a script, contract-phase files are marked `-- phase: contract`.
4. **Blue/green through CodeDeploy for the api only**; worker and payments use rolling updates with the ECS circuit breaker (no inbound traffic to shift for the worker; payments is internal and stateful per attempt).
5. **Paging does not depend on the observability backend.** The collector also writes a short allow-list of operational gauges as CloudWatch EMF (namespace `POS/App`); alerts are defined as code and rendered to CloudWatch alarms. Burn-rate alerts are composites of a long and a short window.
6. **Event-like signals are gauges over a five minute window plus a `.total` counter**, so an alarm returns to OK without a redeploy.
7. **Payments isolation is structural**: separate task role without S3, separate KMS key for its secrets (the api and worker roles cannot decrypt them), separate database role and secret.
8. **Telemetry is a preload** (`node --import @pos/observability/register`), because ESM resolves the import graph before any module runs and instrumentations must patch modules before they load. Without `OTEL_EXPORTER_OTLP_ENDPOINT` it does nothing.
9. **Scheduled jobs on BullMQ job schedulers**, not `setInterval`: with several worker replicas each tick must run once. Outbox relay and consumers stay safe with replicas through `FOR UPDATE SKIP LOCKED` and `processed_events`.

## Modules and files changed

Owned and created: `infra/terraform/**` (13 modules, `stack/`, `bootstrap/`, `envs/{dev,staging,prod-au}`, `.tflint.hcl`, README), `infra/docker/Dockerfile` and `Dockerfile.dockerignore`, `infra/scripts/*` (10 scripts), `infra/alerts/alerts.json` (generated), `infra/load/**`, `infra/sql/outbox-stats.sql` (proposal), `infra/github/README.md` (rewritten), `.github/workflows/*` (11 workflows), `.github/actions/setup`, `.github/renovate.json5`, `packages/observability/**`, `apps/worker/**`, `docs/runbooks/*.md` (4), this file.
**Removed:** `.github/workflows/ci.yml` (replaced by `pr.yml` and `main.yml`; same stages plus the new ones).

`packages/observability/src`: `logger.ts` (pino, trace correlation, redaction, OTel log bridge, `withSpan` now a real span), `telemetry.ts` (`startTelemetry`), `processors.ts`, `redact.ts`, `register.ts`, `metrics/red.ts`, `metrics/operational.ts`, `alerts/{definitions,emit}.ts`. Public API of `createLogger`, `Logger` and `withSpan` is unchanged (`withSpan` gained an optional fourth argument); existing api and worker imports compile unchanged.

`apps/worker/src`: new `bootstrap.ts` (`startWorker`), `jobs/{job-runner,builtin-jobs}.ts`, `telemetry/outbox-stats.ts`, `test-support.ts`; edited `main.ts` (now delegates to `startWorker`), `modules/outbox/outbox-relay.service.ts` (pass hook and observation, no behaviour change), `event-consumer.ts` (batch hook), `redis.provider.ts` (`createBullConnection`), `public/index.ts` (exports).

## Migrations applied

None. `infra/sql/outbox-stats.sql` is a **proposed** migration (`audit.fn_outbox_stats()`, SECURITY DEFINER) for the integration lead: `packages/db` is another stream's. Until it lands, the outbox gauges report relay-observed lower bounds (the worker logs one warning). The test installs the function in a container and proves the exact path.

## APIs introduced

No HTTP endpoints, so no OpenAPI diff. Library API: `startTelemetry(serviceName, options)`, `getTelemetry()`, `createRedMetrics(meter)`, `registerOperationalMetrics(probes, options)` (returns `recordRlsContextMissing`, `recordAuditChainVerificationFailure`, `recordCrossTenantAttempt`), `redactObject`, `scrubString`, `alertDocument`. Worker: `startWorker()`, `JobRunner.register/start/enqueue/stop`.

## Tests executed and results

- **Unit and integration:** see the table above. Notable cases: log redaction of nested keys, emails, JWTs, bearer and operator tokens and Luhn-valid card numbers; span, event and log-record redaction independent of pino; RED counts only 5xx as errors; gauges for events fall back to zero after the window; a failing probe is counted, not thrown; scheduled ticks run once with two replicas; exhausted jobs stay failed, unhandled jobs fail without retries; stale schedulers are removed; relay hook and fallback gauges; consumer group lag and the dead-letter length; full `startWorker` wiring and a clean second `stop()`.
- **Bug found by the integration tests and fixed:** the logger's `err` serializer threw when a caller logged `err` as a string (the relay does), which would have crashed that code path. Regression test added.
- **Load:** k6 `smoke` against the real api image. `staging` and `full` were not run (no target). The script was checked to parse at the full profile (200 orders/s, up to 1200 VUs, 10x burst).
- **Security:** Trivy, Gitleaks, CodeQL, DAST and `pnpm audit` are configured in workflows but **have not run**; no scanner result exists yet.
- **Not tested:** anything that needs AWS (apply, CodeDeploy, ECS run-task, ECR copy, WAF, alarms), GitHub-hosted runs, the staging and full k6 profiles, the DR drill.

## Known limitations

1. **Never applied.** Plans are offline with placeholders; real applies will find things offline planning cannot. Verify at first apply: the CloudFront origin-facing **prefix list id** for ap-southeast-2 (and raise the security group rule quota, the list counts as 55 rules); that the **ADOT collector image tag** in `modules/otel-collector` exists; whether the Aurora **master user holds BYPASSRLS** (the migrator refuses otherwise; use a dedicated role if not); the **EMF dimension names** (`service.name`) once the collector runs; that the shared-preload parameter `pgaudit` is accepted by the chosen engine version.
2. **Region loss is not covered.** Multi-AZ and PITR are; there is no cross-region copy. The Phase 1 target "RPO 5 min, RTO 4 h" holds for cluster loss and corruption in the region, not for a region outage. [dr-restore-drill.md](../runbooks/dr-restore-drill.md) says so explicitly; decide before GA.
3. **Dashboards are not built.** Runbooks refer to RED dashboards in Grafana or Datadog; only alerts exist. The api does not yet call `createRedMetrics().http.record` (apps/api is not this stream's), so per-route RED comes from ALB metrics and traces until an interceptor is added.
4. **Only some gauges have emitters.** Outbox backlog and age, stream lag and the worker's RED are wired. Sync lag (api, slice M1), payment `uncertain` count (payments), RLS context missing, audit chain failure and cross-tenant attempts need their owners to call `registerOperationalMetrics`. Until then those alarms see no data and stay quiet (`notBreaching`). Webhook delivery failure rate and store-offline alerts are not defined because their metrics do not exist yet.
5. **The audit anchoring job is not built** (F1 open item); the Object Lock bucket is provisioned.
6. **DAST covers the unauthenticated surface** from the OpenAPI document. The authenticated surface is covered by the cross-tenant and security suites.
7. **The e2e, Storybook and POS steps skip with a notice** when a package has no such script (`run-if-script.sh`); `@pos/ui` has no `build-storybook` yet. The release e2e against staging needs `E2E_OPERATOR_TOKEN` and runs the console locally against the staging API.
8. **CodeQL needs Advanced Security on private repositories** (`CODEQL_ENABLED`). IaC scanning is report-only until its findings are triaged.
9. **Deploy role breadth.** ECS and CodeDeploy describe and register actions cannot be resource-scoped, so they are `*`; `iam:PassRole` is limited to the service roles and `ecs:RunTask` to the migrate task definition. The migrate task holds migration-role credentials, so the GitHub Environment approvals on `prod-au` are part of the control.
10. **No cost estimate.** Instance classes and counts are starting points, not sized by measurement.
11. **`IdempotencyPurgeJob.start()` (setInterval) is now unused**; the worker runs the purge through the job runner. Left in place for compatibility.

## Security considerations

- Deploy credentials are short-lived OIDC sessions bound to one GitHub Environment per AWS role (`repo:<org>/<repo>:environment:<env>`); pull requests only get a read-only plan role. No long-lived keys anywhere.
- Secrets live in Secrets Manager under customer-managed KMS keys; Terraform creates empty containers and never holds values. Payments secrets use a key the api and worker cannot decrypt.
- Database and Redis sit in isolated subnets with no route out, reachable only from the services' security groups; TLS is enforced on both (`rds.force_ssl`, in-transit encryption). The images carry the **Amazon RDS CA bundle** (`NODE_EXTRA_CA_CERTS`) because Node does not trust it by default; without it the first connection fails.
- The ALB accepts HTTPS only from CloudFront's prefix list; WAF applies managed rule sets (the body-size rule is count-only so sync uploads pass) and a per-IP rate limit. Provider webhooks reach `payments` through the same edge.
- The audit anchor bucket is Object Lock COMPLIANCE with a bucket policy denying retention changes; ECR tags are immutable and scanned on push; images are scanned (Trivy, blocking on high and critical) and built with provenance and SBOM.
- Containers run as non-root with a read-only root filesystem and a `/tmp` volume; ECS Exec is off.
- Logs, spans and log records are redacted at source and again in the collector. The redaction is defence in depth, not a licence to log secrets or card data.
- The load profile creates `load-*` tenants through the operator API: point it only at environments where that is acceptable, and keep operator tokens out of shared logs.

## Deployment instructions

[docs/runbooks/deploy.md](../runbooks/deploy.md) has the full procedure. In short: bootstrap the state bucket, fill `terraform.tfvars`, `terraform apply` the environment, set secret values, create the application database roles, configure the GitHub Environments and variables, push to `main` (dev) and tag `v*` (staging, then production after approval). Offline checks: `infra/scripts/tf-offline.sh <env> plan`.

## Shared files, dependencies, stubs

- **Shared-file lines appended:** `.prettierignore`: `infra/alerts/alerts.json` (generated file that a test keeps byte-identical to the emitter) and its comment. No change to the root `package.json`, `app.module.ts` or the other shared files.
- **`pnpm-lock.yaml` changed** by two `pnpm install` runs (§15.2 rule 3). `packages/observability` added: `@opentelemetry/api` 1.9.1, `api-logs` 0.223.0, `exporter-{trace,metrics,logs}-otlp-http` 0.223.0, `instrumentation` 0.223.0, `instrumentation-http` 0.223.0, `instrumentation-pg` 0.76.0, `instrumentation-ioredis` 0.71.0, `resources` 2.12.0, `sdk-logs` 0.223.0, `sdk-metrics` 2.12.0, `sdk-node` 0.223.0, `sdk-trace-base` 2.12.0, `semantic-conventions` 1.43.0, and `vitest` 3.2.7 as a dev dependency. `apps/worker` added `bullmq` 6.3.16 (the plan's queue library; `ioredis` is its peer).
- **Workstation tools installed** (not in the repository): Terraform 1.16.6 (HashiCorp tap) and shellcheck via Homebrew; tflint as a release binary.
- **Stubs left:** none in code. Simulated or placeholder: the `bootstrap` image tag in the first task definitions; `placeholder.tfvars` values; the ADOT image tag; the proposed `fn_outbox_stats`.
- **Defects and gaps found for the integration lead (no files outside this stream were changed):**
  1. The system `cashier` and `server` roles have **no `catalog.view`**, so a register user gets 403 on `GET /v1/variants/by-barcode`. The k6 profile works around it with a custom role; the system roles probably need the permission (packages/auth).
  2. `POST /v1/orders` still needs an item snapshot on each line ("until the catalog is wired", S-F4/S-F2 integration), and `POST /v1/orders/{id}/place` requires `If-Match`. The k6 profile sends both.
  3. The api logs `Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0` at startup: some code issues concurrent queries on one client.
  4. The payments database role has no grant matrix in `packages/db/src/roles.ts` (only `app_rw`); needed before the first production deploy.
  5. `audit.fn_outbox_stats()` (proposal above) and its grant in `roles.ts`.
  6. No HTTP RED interceptor and no emitters for the operational gauges in the api and payments (limitation 4).
  7. The api's rate limiter keys by tenant, token kind and user; the F10 profile needs enough users or a relaxed limiter on the target (documented in `infra/load/README.md`).

## Remaining tasks and recommended next steps

1. Apply `dev` for real: bootstrap, secrets, roles, first pipeline run; fix whatever offline planning could not see; then repeat for staging.
2. Run the `staging` and `full` k6 profiles and record results against §12.1; extend the profile with a tender step once the payments mock provider exists and with sync endpoints (M1).
3. Rehearse the runbooks: one deploy with a forced canary rollback, the DR restore drill, and an alarm fire-drill for each page-level alert.
4. Decide region-loss recovery (cross-region snapshot copies now, Aurora Global Database in Phase 3) and record it as an ADR.
5. Add the api HTTP RED interceptor and wire the operational gauges in api, payments and worker (sync lag, payment uncertain, RLS context, audit verification, cross-tenant).
6. Build dashboards as code for the RED, outbox, sync and payment signals; add webhook-failure and store-offline alerts when the metrics exist.
7. Preview environments per pull request; a Terraform apply workflow with approvals if desired (today applying is deliberately manual).
8. Triage the first IaC scan findings and make that check blocking; enable CodeQL where licensed.
