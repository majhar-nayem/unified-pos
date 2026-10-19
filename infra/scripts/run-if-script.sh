#!/usr/bin/env bash
# Run `pnpm --filter <package> run <script>` only when the package defines that script.
# Lets pipelines name stages (storybook, e2e) before every stream has shipped them, without hiding failures
# of stages that do exist.
#   run-if-script.sh <package-filter> <script> [args...]
set -euo pipefail

filter="${1:?package filter required}"
script="${2:?script name required}"
shift 2

dir="$(pnpm --filter "$filter" exec pwd 2>/dev/null | head -n1 || true)"
if [ -z "$dir" ] || ! node -e "process.exit(require('${dir}/package.json').scripts?.['${script}'] ? 0 : 1)"; then
  echo "::notice title=Skipped::${filter} has no '${script}' script yet"
  exit 0
fi
exec pnpm --filter "$filter" run "$script" "$@"
