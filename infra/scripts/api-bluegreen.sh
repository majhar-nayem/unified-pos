#!/usr/bin/env bash
# Blue/green deploy of the api through CodeDeploy: 10 % canary, soak while the SLO alarms are watched,
# then 100 %. CodeDeploy rolls back automatically when an alarm fires (alarms module); the old task set
# stays up for the termination wait so a manual stop is an instant rollback.
#   PREFIX=pos-dev api-bluegreen.sh <image> [max-wait-minutes]
# Emergency rollback or hotfix: DEPLOYMENT_CONFIG=CodeDeployDefault.ECSAllAtOnce skips the canary soak (docs/runbooks/rollback.md).
set -euo pipefail

image="${1:?image required}"
max_wait="${2:-120}"
prefix="${PREFIX:?PREFIX required}"
family="${prefix}-api"
port="${API_PORT:-3000}"

new_definition="$(aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
  jq --arg image "$image" '
    .containerDefinitions |= map(if .name == "api" then .image = $image else . end)
    | with_entries(select(.key | IN("family","taskRoleArn","executionRoleArn","networkMode","containerDefinitions",
        "volumes","placementConstraints","requiresCompatibilities","cpu","memory","runtimePlatform",
        "ephemeralStorage","pidMode","ipcMode")))')"
arn="$(aws ecs register-task-definition --cli-input-json "$new_definition" \
  --query taskDefinition.taskDefinitionArn --output text)"
echo "registered ${arn}"

appspec="$(jq -nc --arg td "$arn" --argjson port "$port" '{
  version: 1,
  Resources: [{ TargetService: { Type: "AWS::ECS::Service", Properties: {
    TaskDefinition: $td,
    LoadBalancerInfo: { ContainerName: "api", ContainerPort: $port } } } }]
}')"

config_args=()
if [ -n "${DEPLOYMENT_CONFIG:-}" ]; then config_args=(--deployment-config-name "$DEPLOYMENT_CONFIG"); fi

deployment_id="$(aws deploy create-deployment \
  --application-name "$family" --deployment-group-name "$family" ${config_args[@]+"${config_args[@]}"} \
  --revision "$(jq -nc --arg content "$appspec" '{revisionType: "AppSpecContent", appSpecContent: {content: $content}}')" \
  --description "api ${image##*:}" --query deploymentId --output text)"
echo "CodeDeploy deployment ${deployment_id}"
echo "deployment-id=${deployment_id}" >> "${GITHUB_OUTPUT:-/dev/null}"

deadline=$((SECONDS + max_wait * 60))
while :; do
  status="$(aws deploy get-deployment --deployment-id "$deployment_id" --query deploymentInfo.status --output text)"
  echo "$(date -u +%H:%M:%S) ${status}"
  case "$status" in
    Succeeded) break ;;
    Failed | Stopped)
      aws deploy get-deployment --deployment-id "$deployment_id" --query deploymentInfo.errorInformation --output json || true
      echo "::error::api deployment ${deployment_id} ${status}; traffic is back on the previous task set"
      exit 1
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::api deployment ${deployment_id} still ${status} after ${max_wait} minutes; stopping with rollback"
    aws deploy stop-deployment --deployment-id "$deployment_id" --auto-rollback-enabled >/dev/null || true
    exit 1
  fi
  sleep 30
done
echo "api now runs ${image}"
