/**
 * `pnpm --filter @pos/api openapi:export` writes the generated OpenAPI 3.1 document to
 * packages/contracts/openapi/v1.json (committed, so API consumers and reviewers can diff it).
 * Boots the real AppModule without touching Postgres or Redis, like src/openapi.boot.test.ts.
 */
import 'reflect-metadata';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Test } from '@nestjs/testing';

import { AppModule } from '../app.module.js';
import {
  API_PREFIX,
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_DISABLED,
} from '../modules/kernel/public/index.js';

process.env.SKIP_ACCESS_SEED = '1';
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/openapi/v1.json',
);

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(RATE_LIMIT_CONFIG)
  .useValue(RATE_LIMIT_DISABLED)
  .compile();
const app = moduleRef.createNestApplication({ logger: false });
app.setGlobalPrefix(API_PREFIX);
await app.init();
await app.listen(0);
const { port } = app.getHttpServer().address() as { port: number };
const document = (await (await fetch(`http://127.0.0.1:${port}/v1/openapi.json`)).json()) as {
  paths: Record<string, unknown>;
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`[openapi] ${Object.keys(document.paths).length} paths written to ${out}`);
await app.close();
process.exit(0);
