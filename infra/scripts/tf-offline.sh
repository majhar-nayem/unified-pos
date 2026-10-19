#!/usr/bin/env bash
# Validate and plan a Terraform environment with placeholder values and no AWS credentials.
#   infra/scripts/tf-offline.sh <dev|staging|prod-au> [plan|validate]
# A temporary override file swaps the S3 backend for a local one; it is removed on exit.
set -euo pipefail

env_name="${1:?usage: tf-offline.sh <dev|staging|prod-au> [plan|validate]}"
mode="${2:-plan}"
dir="$(cd "$(dirname "$0")/../terraform/envs/${env_name}" && pwd)"
cd "$dir"

cleanup() { rm -f offline_override.tf offline.tfstate; }
trap cleanup EXIT

cat > offline_override.tf <<'HCL'
terraform {
  backend "local" {
    path = "offline.tfstate"
  }
}
HCL

export AWS_EC2_METADATA_DISABLED=true
terraform init -reconfigure -input=false -no-color >/dev/null
terraform validate -no-color
if [ "$mode" = "plan" ]; then
  terraform plan -no-color -input=false -var-file=placeholder.tfvars -out=tfplan.offline
  terraform show -no-color tfplan.offline > plan.offline.txt
  echo "plan written to ${dir}/plan.offline.txt"
fi
