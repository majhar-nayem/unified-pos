#!/usr/bin/env bash
# Start apps/api for the Playwright suites in CI: migrate and grant against the service containers
# (Postgres and Redis on localhost), then run the built API in the background and wait for /v1/health.
# Expects `pnpm build` (or a turbo build of @pos/api...) to have run. Writes the PID to .e2e-api.pid.
#   e2e-api.sh start | stop
set -euo pipefail

port="${E2E_API_PORT:-3100}"
pidfile=".e2e-api.pid"
operator_id="0a1b2c3d-0000-4000-8000-000000000f08" # operator ids must be UUIDs
operator_token="${E2E_OPERATOR_TOKEN:-op_ci_operator_token_0001}"

case "${1:-}" in
  start)
    admin_url="${E2E_ADMIN_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/pos}"
    app_url="${E2E_APP_DATABASE_URL:-postgres://app_rw:app_rw@localhost:5432/pos}"
    DATABASE_URL="$admin_url" pnpm db:migrate
    DATABASE_URL="$admin_url" pnpm --filter @pos/db grants
    (
      cd apps/api
      DATABASE_URL="$app_url" \
        REDIS_URL="${E2E_REDIS_URL:-redis://localhost:6379}" \
        PORT="$port" \
        AUTH_OPERATOR_TOKENS="${operator_id}:${operator_token}" \
        AUTH_WEBAUTHN_RP_ID=localhost \
        AUTH_WEBAUTHN_ORIGINS="http://localhost:3101" \
        RATE_LIMIT_ENABLED=false \
        nohup node dist/main.js > ../../e2e-api.log 2>&1 &
      echo $! > "../../${pidfile}"
    )
    for _ in $(seq 1 60); do
      if curl -fs "http://localhost:${port}/v1/health" >/dev/null; then
        echo "api is up on ${port}"
        exit 0
      fi
      sleep 1
    done
    echo "::error::api did not become healthy"
    tail -n 50 e2e-api.log || true
    exit 1
    ;;
  stop)
    if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; fi
    ;;
  *)
    echo "usage: e2e-api.sh start|stop" >&2
    exit 2
    ;;
esac
