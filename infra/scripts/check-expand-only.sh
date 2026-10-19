#!/usr/bin/env bash
# Guard for production: migrations shipped in a release must be expand-only (docs/03 §10, docs/01 §12.3).
# Looks at migration files added or changed between a base ref and HEAD and rejects destructive statements.
# Contract-phase migrations (drops, type changes) run one release later behind a flag and are marked with
#   -- phase: contract
# which this check refuses in expand-only mode.
#   check-expand-only.sh <base-ref> [migrations-dir]
set -euo pipefail

base="${1:?base ref required (previous release tag or origin/main)}"
dir="${2:-packages/db/migrations}"

files="$(git diff --name-only --diff-filter=AM "${base}...HEAD" -- "$dir" | grep -E '\.sql$' || true)"
if [ -z "$files" ]; then
  echo "no migration changes since ${base}"
  exit 0
fi

pattern='(^|[^a-z_])(drop[[:space:]]+(table|column|schema|type|index[[:space:]]+concurrently)|alter[[:space:]]+table[^;]*[[:space:]]drop[[:space:]]|alter[[:space:]]+table[^;]*rename[[:space:]]|alter[[:space:]]+column[^;]*type[[:space:]]|truncate[[:space:]]|delete[[:space:]]+from[[:space:]])'
failed=0
for file in $files; do
  if grep -qiE '^--[[:space:]]*phase:[[:space:]]*contract' "$file"; then
    echo "::error file=${file}::contract-phase migration cannot ship in an expand-only release"
    failed=1
    continue
  fi
  # strip line comments before matching
  if sed -e 's/--.*$//' "$file" | grep -qiE "$pattern"; then
    line="$(sed -e 's/--.*$//' "$file" | grep -inE "$pattern" | head -n1)"
    echo "::error file=${file}::destructive statement in an expand-only release: ${line}"
    failed=1
  else
    echo "ok ${file}"
  fi
done
exit "$failed"
