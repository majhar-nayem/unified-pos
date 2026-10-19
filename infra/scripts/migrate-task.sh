#!/usr/bin/env bash
# Run `pnpm --filter @pos/db migrate` as a one-off Fargate task inside the VPC (Aurora has no public path),
# stream its logs and fail on a non-zero exit code. Migrations are expand-only (docs/03 §10).
#   PREFIX=pos-dev SUBNETS=subnet-a,subnet-b SECURITY_GROUPS=sg-1 migrate-task.sh <image>
set -euo pipefail

image="${1:?image required}"
prefix="${PREFIX:?PREFIX required}"
subnets="${SUBNETS:?SUBNETS required (comma separated)}"
groups="${SECURITY_GROUPS:?SECURITY_GROUPS required (comma separated)}"
family="${prefix}-migrate"

new_definition="$(aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
  jq --arg image "$image" '
    .containerDefinitions |= map(.image = $image)
    | with_entries(select(.key | IN("family","taskRoleArn","executionRoleArn","networkMode","containerDefinitions",
        "volumes","placementConstraints","requiresCompatibilities","cpu","memory","runtimePlatform",
        "ephemeralStorage","pidMode","ipcMode")))')"
arn="$(aws ecs register-task-definition --cli-input-json "$new_definition" \
  --query taskDefinition.taskDefinitionArn --output text)"

task_arn="$(aws ecs run-task --cluster "$prefix" --launch-type FARGATE --task-definition "$arn" \
  --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${groups}],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"
task_id="${task_arn##*/}"
echo "migration task ${task_id}"

aws ecs wait tasks-stopped --cluster "$prefix" --tasks "$task_arn"

log_group="/ecs/${prefix}/migrate"
aws logs get-log-events --log-group-name "$log_group" --log-stream-name "migrate/migrate/${task_id}" \
  --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' || true

exit_code="$(aws ecs describe-tasks --cluster "$prefix" --tasks "$task_arn" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
if [ "$exit_code" != "0" ]; then
  reason="$(aws ecs describe-tasks --cluster "$prefix" --tasks "$task_arn" --query 'tasks[0].stoppedReason' --output text)"
  echo "::error::migration failed (exit ${exit_code}): ${reason}"
  exit 1
fi
echo "migration finished"
