#!/usr/bin/env bash
# Dynamic scan of the staging API from its OpenAPI document with OWASP ZAP (API scan). Fails on High alerts.
# Authentication is not configured here: the scan covers the public surface and error handling; the
# authenticated surface is covered by the cross-tenant and security suites.
#   dast-gate.sh https://api.staging.example.com [report-dir]
set -euo pipefail

base="${1:?base url required}"
out="${2:-dast-report}"
mkdir -p "$out"
chmod 777 "$out"

set +e
docker run --rm -v "$(cd "$out" && pwd):/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py -t "${base%/}/v1/openapi.json" -f openapi -J report.json -r report.html -I
code=$?
set -e
echo "zap exit code ${code}"

if [ ! -s "${out}/report.json" ]; then
  echo "::error::ZAP produced no report"
  exit 1
fi
high="$(jq '[.site[]?.alerts[]? | select((.riskcode | tonumber) >= 3)] | length' "${out}/report.json")"
echo "high or critical alerts: ${high}"
if [ "$high" -gt 0 ]; then
  jq -r '.site[]?.alerts[]? | select((.riskcode | tonumber) >= 3) | "- \(.name) (\(.riskdesc))"' "${out}/report.json"
  echo "::error::DAST gate failed with ${high} high-risk alerts"
  exit 1
fi
