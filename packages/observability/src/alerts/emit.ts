#!/usr/bin/env node
/**
 * Write the alert definitions to infra/alerts/alerts.json (Terraform reads that file).
 *   node dist/alerts/emit.js            write
 *   node dist/alerts/emit.js --check    exit 1 when the committed file is stale
 * ALERTS_OUT overrides the target path.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serialiseAlertDocument } from './definitions.js';

export const DEFAULT_ALERTS_PATH = fileURLToPath(
  new URL('../../../../infra/alerts/alerts.json', import.meta.url),
);

const target = process.env.ALERTS_OUT ?? DEFAULT_ALERTS_PATH;
const expected = serialiseAlertDocument();

if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(target, 'utf8');
  } catch {
    // missing counts as stale
  }
  if (actual !== expected) {
    console.error(`[alerts] ${target} is stale; run: pnpm --filter @pos/observability alerts:emit`);
    process.exit(1);
  }
  console.log('[alerts] infra/alerts/alerts.json is up to date');
} else {
  writeFileSync(target, expected);
  console.log(`[alerts] wrote ${target}`);
}
