#!/usr/bin/env bash
# Register a new task-definition revision with a new image and roll an ECS service onto it
# (rolling update with the deployment circuit breaker). Used for worker and payments.
#   PREFIX=pos-dev ecs-deploy.sh <service> <image>
set -euo pipefail

service="${1:?service (worker|payments) required}"
image="${2:?image required}"
prefix="${PREFIX:?PREFIX required, e.g. pos-dev}"
family="${prefix}-${service}"

new_definition="$(aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
  jq --arg image "$image" --arg name "$service" '
    .containerDefinitions |= map(if .name == $name then .image = $image else . end)
    | with_entries(select(.key | IN("family","taskRoleArn","executionRoleArn","networkMode","containerDefinitions",
        "volumes","placementConstraints","requiresCompatibilities","cpu","memory","runtimePlatform",
        "ephemeralStorage","pidMode","ipcMode")))')"

arn="$(aws ecs register-task-definition --cli-input-json "$new_definition" \
  --query taskDefinition.taskDefinitionArn --output text)"
echo "registered ${arn}"

aws ecs update-service --cluster "$prefix" --service "$family" --task-definition "$arn" >/dev/null
echo "waiting for ${family} to stabilise"
if ! aws ecs wait services-stable --cluster "$prefix" --services "$family"; then
  echo "::error::${family} did not stabilise; the circuit breaker rolls back to the previous revision"
  aws ecs describe-services --cluster "$prefix" --services "$family" \
    --query 'services[0].events[0:8].message' --output text || true
  exit 1
fi
echo "${family} now runs ${image}"
