#!/usr/bin/env bash
# Post-deploy smoke test against a base URL (through CloudFront and the ALB, so the whole edge is covered).
#   smoke.sh https://api.dev.example.com
set -euo pipefail

base="${1:?base url required}"
base="${base%/}"

fail() { echo "::error::smoke: $*"; exit 1; }

retry() { # name, attempts, command...
  local name="$1" attempts="$2"
  shift 2
  for ((i = 1; i <= attempts; i++)); do
    if "$@" >/dev/null 2>&1; then echo "ok   ${name}"; return 0; fi
    sleep 10
  done
  fail "${name} did not pass after ${attempts} attempts"
}

status() { # url, expected, [curl args]
  local url="$1" expected="$2"
  shift 2
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" "$url")" = "$expected" ]
}

retry "GET /v1/health is 200" 30 status "${base}/v1/health" 200
retry "GET /v1/openapi.json is 200" 6 status "${base}/v1/openapi.json" 200
retry "unauthenticated GET /v1/tenants/me is 401" 6 status "${base}/v1/tenants/me" 401
if [[ "$base" == https://* ]]; then
  retry "HTTP is redirected to HTTPS" 3 bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 'http://${base#https://}/v1/health')\" = 301 ]"
fi

body="$(curl -s --max-time 10 "${base}/v1/health")"
echo "health: ${body}"
