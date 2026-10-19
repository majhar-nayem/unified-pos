# Runbook: on-call basics

Related: [deploy](deploy.md), [rollback](rollback.md), [DR drill](dr-restore-drill.md). Alerts are defined as code in
[packages/observability/src/alerts/definitions.ts](../../packages/observability/src/alerts/definitions.ts) (application and SLO alerts) and
[infra/terraform/modules/alarms](../../infra/terraform/modules/alarms/main.tf) (infrastructure). Every alert description links to a heading below.

## How paging works

| Severity | Channel                                             | Expectation                                                      |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| page     | SNS topic `pos-<env>-alerts-page` → pager (on-call) | Acknowledge in 5 minutes, start working, update every 30 minutes |
| ticket   | SNS topic `pos-<env>-alerts-ticket` → team queue    | Look the same working day; page yourself if it is getting worse  |

Non-production alerts never page. Prod alarm names start with `pos-prod-au-`.

## First five minutes

1. **Acknowledge** the page and open an incident channel named `inc-<date>-<short-title>`.
2. **Check what changed**: a deploy in the last hour? `aws deploy list-deployments --application-name pos-prod-au-api`, the `release.yml` run, `terraform` applies.
   If yes and the symptom started after it, **roll back first, diagnose later** ([rollback.md](rollback.md)).
3. **Size the impact**: which alarm, since when, which tenants (logs: `tenant_id`), which paths (ALB and RED dashboards). Checkout failures and payment problems are Sev 1.
4. **Look at the three signals**: CloudWatch alarms for the environment, Grafana RED dashboards (rate, errors, duration per route and per service), and logs.
5. **Communicate**: post what you see and what you are doing. State uncertainty plainly.

## Severity

| Sev | Meaning                                                                                      | Examples                                                                                   |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Customers cannot trade, money is at risk, or tenant isolation or audit integrity is in doubt | availability burn, payment uncertain stuck, RLS context missing, audit chain, cross-tenant |
| 2   | Degraded: slow, stale or partially unavailable, with a workaround                            | sync lag, outbox backlog, reporting stale                                                  |
| 3   | No customer impact yet                                                                       | CPU high, single unhealthy target, disk or connection warnings                             |

## Finding things

```bash
# Logs of a service for the last 30 minutes (structured JSON; one correlation id per client command)
aws logs tail /ecs/pos-prod-au/api --since 30m --format short --filter-pattern '{ $.level >= 50 }'
# Follow one request: every log line carries trace_id and span_id; search the tracing backend for the trace id,
# or in Logs Insights:
#   fields @timestamp, level, msg, service, tenant_id | filter trace_id = "<id>" | sort @timestamp
# Which tasks are running and why one stopped
aws ecs describe-services --cluster pos-prod-au --services pos-prod-au-api --query 'services[0].events[0:10].message'
aws ecs list-tasks --cluster pos-prod-au --service-name pos-prod-au-api --desired-status STOPPED
```

Logs are PII-redacted at source (emails, tokens, card numbers); do not paste raw customer data into the channel. Never log or ask for card data.

## SLO burn

Alarms `slo-availability-fast-burn` (page) and `slo-availability-slow-burn` (page), and the ticket-level `slo-availability-ticket-burn`: the share of 5xx responses over a long and a short
window is consuming the 99.95 % monthly error budget at 14.4x, 6x or 3x. Both windows must be breached, so it is real and ongoing.

1. Recent deploy? A burn during a canary stops the deployment by itself; confirm with `aws deploy get-deployment` and that traffic is back on the old task set.
2. Which route and status? RED dashboard by `http.route`; in Logs Insights filter `level >= 50` grouped by `msg`.
3. Dependency? Check [Database](#database), [Redis](#redis), the payment provider status, and `unhealthy-targets`.
4. Mitigate: roll back, scale out (`aws ecs update-service --desired-count`), or shed the offending traffic (WAF rate rule). Then clear the alarm and write the incident note.

## ALB 5xx

`alb-elb-5xx`: the load balancer itself returned 5xx (502/503/504), not the application. Usually no healthy targets (see [Unhealthy targets](#unhealthy-targets)), a deployment mid-swap, or a task
set that was deregistered. Check the target group health and ALB access logs in the `alb-logs` bucket.

## Unhealthy targets

`api-*-unhealthy-hosts`: targets fail `/v1/health`. `aws elbv2 describe-target-health --target-group-arn <arn>` for the reason; look at task logs for startup errors (missing secret
value, bad `DATABASE_URL`, unreachable Redis). A new environment without secret values behaves this way. Green target group alarms during a deployment are ticket level and expected briefly.

## Latency

`api-latency-p95`: standard API p95 above 300 ms (§12.1). Find the slow routes in the RED dashboard, then the slow spans in traces (database spans carry `db.statement` without values).
Check Aurora CPU and connections, Redis latency, and whether autoscaling is at its ceiling (`ecs_cpu` alarm). A slow query is the usual cause: `pg_stat_statements` on the writer.

## ECS tasks

`*-running-tasks-low`: fewer tasks than the minimum. A stopped task's reason is in `describe-tasks` (`OutOfMemoryError`, essential container exited, failed health check, image pull error).
After a deploy the circuit breaker may already have rolled back. `worker` at zero means the outbox is not draining: expect [Outbox backlog](#outbox-backlog) next.

## Database

Alarms `aurora-cpu`, `aurora-freeable-memory` (page), `aurora-connections`, `aurora-replica-lag`, `aurora-deadlocks`.

- Connections high: a leaked pool or a runaway job. `SELECT application_name, count(*) FROM pg_stat_activity GROUP BY 1;` (`pos-api`, `pos-worker`, `pos-migrate`).
- Long queries: `SELECT pid, now() - query_start AS age, state, left(query, 120) FROM pg_stat_activity WHERE state <> 'idle' ORDER BY age DESC LIMIT 10;`
- Failover (about 30 s) is expected to be survived: devices queue commands and retry. If it is not, that is a bug to file.
- Data loss or corruption: stop writes if needed and follow the [DR drill](dr-restore-drill.md) "Doing it for real".

## Redis

`redis-*-engineCPUUtilization`, `databasememoryusagepercentage`, `evictions` (page). Streams (`pos:events`) must never be evicted; the parameter group uses `volatile-lru` so only keys with a TTL are candidates.
Evictions mean the cache is oversized for the node: scale the node type, and check `pos:events` length and the dead stream. With Redis down checkout still works (no cache, rate limiting fails open for POS tokens)
but WebSocket hints stop and clients poll.

## Outbox backlog

Alarms `outbox-backlog-high` (ticket, over 500 for 5 minutes), `outbox-backlog-critical` (page, over 5000), `outbox-relay-stalled` (page, oldest unpublished event older than 5 minutes).
The relay in `worker` polls `audit.outbox_events` where `published_at IS NULL`, publishes to the `pos:events` stream and marks the rows. Events are never lost, only late.

1. Is `worker` running (`ecs-tasks`)? Is Redis healthy? Relay log lines: `outbox publish failed`, `outbox event moved to dead stream`.
2. Dead-letter stream length is on the `pos.stream.lag` gauge (stream `pos:events:dead`). Dead rows keep their error in `audit.outbox_events.last_error`.
3. Consumer lag: `pos.stream.lag` for `pos:events:event-log:lag`. A consumer that fails repeatedly shows in its logs; consumers dedupe by event id, so replays are safe.
4. Nothing to repair by hand in the data. Restart the worker (`ecs-deploy.sh worker <current image>`) if the relay loop is wedged; scale it out for throughput.

Until the exact-totals SQL function from [infra/sql/outbox-stats.sql](../../infra/sql/outbox-stats.sql) is applied, the gauges report lower bounds seen by the relay (rows that failed to publish, or a full batch);
the worker logs a warning at startup when it is missing.

## Sync lag

`sync-lag-high` (ticket, p95 above 5 s) and `sync-lag-critical` (page, above 60 s): devices are receiving changes late. Check api health and latency first, then Redis pub/sub and the sync feed
endpoints. Devices keep working offline, so impact is staleness (prices, availability, kitchen routing for Store Hub profiles). The gauge is produced by the api once the sync endpoints exist (slice M1);
until then this alert has no data and stays quiet.

## Payment uncertain

`payment-uncertain` (page): payment attempts have been in `uncertain` for 10 minutes without reconciliation resolving them. The platform queries the provider before any retry and never charges twice
by retrying; do not retry by hand either.

1. List them: `SELECT id, tenant_id, provider, created_at FROM payments.payment_attempts WHERE status = 'uncertain' ORDER BY created_at;` (read-only, via the payments role).
2. Check the provider's status page and sandbox/production console for the same references.
3. Check the payments service: webhook inbox backlog, provider call errors, outbound connectivity (NAT).
4. Resolve with the provider outcome through the reconciliation tooling, never by editing rows. If the provider is down, the stores continue on other tenders or store-and-forward where enabled.
5. Every manual resolution is audited; note the attempt ids in the incident.

## RLS context missing

`rls-context-missing-<service>` (page, any non-zero): a request ran database work without `app.tenant_id` set. Row level security makes this fail closed (zero rows or an error), so the risk is wrong empty results
and a code defect that could expose data if a role ever bypassed RLS. This counter is expected to be zero always.

1. Find the route: logs with the message from the kernel guard and `trace_id`; the span of the failing request.
2. Roll back if it started with a deploy. Otherwise disable the route's feature flag.
3. File a Sev 2 defect with the trace; the fix needs a regression test in the cross-tenant harness.

## Audit chain

`audit-chain-verification-failure` (page): the nightly or on-demand verification found a broken hash chain for a tenant. Treat as possible tampering or corruption (Sev 1).

1. Identify the tenant and the first broken `seq` from the verification result (`POST /v1/audit/verify`, or the worker job log).
2. Do not repair or delete rows. Preserve the database state: take a manual snapshot of the cluster now.
3. Compare the chain head with the S3 Object Lock anchors once the anchoring job exists; anchors are immutable evidence.
4. Escalate to security. Follow the [DR drill](dr-restore-drill.md) procedure if a restore is needed to establish ground truth.

## Cross-tenant

`cross-tenant-access-attempt` (page): a request was refused because it tried to reach another tenant's data (or a location outside the caller's scope). The refusal worked (404), the signal is that someone or
something tried. Check the logs for the principal, tenant, route and IP; a buggy client looks different from probing (one route repeatedly vs many ids).

1. If one principal is probing: revoke their sessions (`POST` sign-out-everywhere in the admin console), block the IP in the WAF if external.
2. If a client bug: Sev 3, file a defect with the route.
3. If any response contained data from another tenant: Sev 1, security incident, preserve logs.

## After the incident

Write the timeline, the trigger, what detected it, what fixed it, and what would have caught it sooner. Add or tune an alert in
[definitions.ts](../../packages/observability/src/alerts/definitions.ts) (then `pnpm --filter @pos/observability alerts:emit`) and update this runbook in the same pull request.
