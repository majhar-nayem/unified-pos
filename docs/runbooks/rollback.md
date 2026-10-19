# Runbook: rollback

Related: [deploy](deploy.md), [on-call](on-call.md). Rule from [plan §10](../03-implementation-plan.md): rollback is a blue/green swap for services;
migrations are expand-only, so code rollback never needs a schema rollback.

## Decide

| Situation                                                | Action                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| api deployment in progress, canary or soak looks bad     | [Stop the deployment](#api-stop-a-deployment-in-progress): traffic returns to the previous task set within seconds                   |
| api deployment finished, problem found within 60 minutes | [Redeploy the previous image all at once](#api-redeploy-the-previous-image)                                                          |
| worker or payments misbehaving after a deploy            | [Roll the service back](#worker-and-payments)                                                                                        |
| a feature misbehaves but the release is otherwise fine   | Turn the feature flag off. Prefer this to a rollback when the change is flagged                                                      |
| devices misbehave after a client release                 | Use the kill-switch flag to pin devices to the previous version (plan §10). Server rollback does not help                            |
| the migration looks wrong                                | Do **not** roll the schema back. Forward-fix with a new expand-only migration, or flag off the code that uses it                     |
| Terraform change broke the environment                   | Revert the commit, `terraform plan`, apply. Never `terraform destroy` data resources (deletion protection is on in staging and prod) |

## api: stop a deployment in progress

During the canary (10 % of traffic) and until the soak ends, CodeDeploy still has the previous task set serving the rest. Stopping with
rollback sends all traffic back to it.

```bash
export AWS_REGION=ap-southeast-2 PREFIX=pos-prod-au
aws deploy list-deployments --application-name "$PREFIX-api" --deployment-group-name "$PREFIX-api" \
  --include-only-statuses InProgress --query 'deployments' --output text
aws deploy stop-deployment --deployment-id d-XXXXXXXXX --auto-rollback-enabled
```

The pipeline job `deploy-prod` fails when the deployment stops; that is expected. A fired SLO alarm does the same automatically
(`DEPLOYMENT_STOP_ON_ALARM`). Then follow [on-call](on-call.md#slo-burn) to confirm the alarm clears.

## api: redeploy the previous image

After a successful shift the old task set is kept for 60 minutes, but CodeDeploy offers no instant re-route after success. Roll back by deploying the
previous image with the all-at-once config (no canary, because the previous version is known good):

```bash
export PREFIX=pos-prod-au AWS_REGION=ap-southeast-2
# the previous tag: the one before the current release in `git tag --sort=-creatordate`
DEPLOYMENT_CONFIG=CodeDeployDefault.ECSAllAtOnce \
  infra/scripts/api-bluegreen.sh "<account>.dkr.ecr.ap-southeast-2.amazonaws.com/$PREFIX/api:<previous-tag>" 30
infra/scripts/smoke.sh https://api.example.com
```

Roll worker and payments back to the same tag as well when the release changed event or payment payloads. Check the new code's events are readable by the old
consumers: the stream keeps at-least-once semantics and consumers dedupe by event id, so replays are safe.

## worker and payments

The ECS deployment circuit breaker rolls a service back by itself when new tasks never become healthy. For a bad build that starts fine:

```bash
export PREFIX=pos-prod-au
infra/scripts/ecs-deploy.sh worker   "<ecr>/$PREFIX/worker:<previous-tag>"
infra/scripts/ecs-deploy.sh payments "<ecr>/$PREFIX/payments:<previous-tag>"
```

Worker rollback is safe at any time: the outbox is transactional, the relay claims with a lease, and consumers are idempotent (`audit.processed_events`).
**Payments:** before rolling back, list attempts in `uncertain` (see [on-call](on-call.md#payment-uncertain)) so the older build does not retry blindly; the platform
queries the provider before any retry.

## After any rollback

1. Post in the incident channel: what was rolled back, to which tag, and why.
2. Confirm [alarms](on-call.md) return to OK and the smoke test passes.
3. Block the bad tag: mark the release as withdrawn and open an issue with the evidence (deployment id, alarm, trace ids).
4. If a migration shipped with the bad release it stays applied; the next release must be compatible with it.
