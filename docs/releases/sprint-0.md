# Sprint 0 — bootstrap release notes

Status of the Phase 0 items from [03-implementation-plan.md §4](../03-implementation-plan.md) after the
monorepo bootstrap. Everything below is uncommitted in the working tree for review (git is initialised,
no commits yet).

Verified locally on 2026-10-18 with Docker running:

```bash
pnpm install && pnpm build && pnpm test
```

| Check                             | Result                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm build`                      | 16 tasks green (10 packages, 6 apps incl. `next build` and two `vite build`s)            |
| `pnpm typecheck`                  | 22 tasks green                                                                           |
| `pnpm lint`                       | clean; boundary rules verified to fire on four deliberate violations (then removed)      |
| `pnpm test:unit`                  | 105 tests: 91 in domain-core (incl. 5 golden files), plus contracts, db, auth, sync, pay |
| `pnpm test:integration`           | 6 tests on a `postgres:16` Testcontainer: RLS isolation, WITH CHECK, composite tenant FK |
| `pnpm db:migrate` (compose stack) | migration 0001 applied 159 tables; second run is a no-op                                 |

## What was created

### Workspace

- `pnpm` workspace + Turborepo (`turbo.json`: build → typecheck/test depend on `^build`; integration tests uncached).
- `tsconfig.base.json` (strict, ES2022, NodeNext ESM); every package ships `dist/` with declarations; apps are ESM too.
- Root ESLint 9 flat config with `typescript-eslint`, Prettier, and `eslint-plugin-boundaries` v6.
- `.github/workflows/ci.yml`: install → lint → build → typecheck → unit + golden → integration (Testcontainers on ubuntu runners).
- `infra/docker/docker-compose.yml`: `postgres:16`, `redis:7`, MinIO (+ one-shot bucket init). `pnpm dev:infra` / `pnpm dev:infra:down`.
- `.env.example` with the local defaults.

Version pins chosen deliberately on the stable majors rather than the newest (TypeScript 5.9, ESLint 9,
Vitest 3, Vite 7, Next 15.5, NestJS 11, React 19, Tauri 2, Drizzle 0.45, Testcontainers 11, zod 4). Each
can be bumped independently; the newest majors (TS 7, ESLint 10, Vitest 5, Next 16, Nest 12) were not
validated.

### `packages/domain-core` (pure TypeScript, no workspace imports)

- `money/decimal.ts`: exact decimals on bigint (`parseDecimal`, `divRound` with HALF_UP / HALF_EVEN / HALF_DOWN / DOWN / UP / FLOOR / CEIL, `mulDecimal`).
- `money/currency.ts`: ISO 4217 precision table (15 seed currencies incl. 0- and 3-decimal ones) with per-currency cash rounding rules, in a `CurrencyRegistry` tenants can extend at runtime.
- `money/money.ts`: `Money` = bigint minor units + code; add/subtract/sum/compare, `multiply` by exact decimal, `percentage`, major-unit string conversion, JSON codec (bigint as string).
- `money/allocate.ts`: largest-remainder allocation (sums exactly, deterministic tie-break, negative totals), plus even allocation.
- `money/cash-rounding.ts`: AUD 5c rounding (and NZD/CAD/CHF rules), symmetric for refunds, applied only to cash tenders.
- `pricing/price-order.ts`: deterministic `priceOrder()` implementing pipeline steps 2, 4, 5, 6, 7, 8 of [01-system-architecture.md §7.2](../01-system-architecture.md): line discounts, order-discount allocation, inclusive/exclusive tax per line, charges with their own tax, cash rounding, ordered trace. Steps 1 (price-list resolution) and 3 (promotions) are Phase 1 F3.
- `golden/runner.ts`: pure golden-file runner (JSON in → totals out, structural diff). Five seed cases in `golden/*.json`, hand-computed before the code ran:
  1. single GST-inclusive line, card
  2. mixed GST rates + manual line discount + weighed quantity (1.2550 kg)
  3. order-level 10 % discount allocated by largest remainder (333/333/334 → 33/33/34)
  4. tax-exclusive USD basket with a taxed surcharge
  5. restaurant check with 10 % service charge and AUD cash rounding (+2c)
- Vitest suites for every money path, pricing invariants (allocations sum exactly, totals reconcile, idempotent re-pricing, inclusive/exclusive parity) and a 500-round property test on allocation.

### `packages/db`

- `migrate()` + `pnpm db:migrate`: hand-written SQL migrations tracked in `public.schema_migrations` with checksums and an advisory lock. Migration `0001_initial_schema` applies `db/schema.sql`, `db/schema_part2.sql`, `db/schema_part3.sql` verbatim, in order, in one transaction. The SQL files remain the canonical source and were not modified.
- `withTenant(pool, tenantId, fn)`: `BEGIN; SET LOCAL app.tenant_id; …; COMMIT` as in §5.1. `withoutTenant()` for operator paths.
- `createPool()` parses `int8` to native bigint so money never becomes a float.
- First Drizzle table (`platform.tenants`) to establish the pattern.

### `packages/testing`

- `startPostgresWithSchema()`: `postgres:16` Testcontainer, runs migration 0001, creates the non-superuser `app_rw` role with the grants from the schema header (RLS is `FORCE`d, so tests must not run as a superuser).
- `createTenantFixture()`.
- `rls.integration.test.ts`: schema applied (≥150 tables, RLS forced), tenant A sees only A, tenant B sees only B even when filtering by A's ids, missing `app.tenant_id` → zero rows, insert stamped with another tenant → `42501`, composite FK across tenants → `23503` (both as `app_rw` and as superuser), same-tenant reference succeeds.

### Other packages (thin but real)

- `contracts`: zod schemas for `Money` (string minor units), `HealthResponse`, `TenantSettings`, sync batch/command; event catalog seed.
- `sync-protocol`: hybrid logical clock with tests (monotonic, merge on receive, drift guard, sortable string form); command/batch/feed types.
- `payments-sdk`: provider adapter interface from §7.4 and a deterministic `MockPaymentProvider` (idempotent, decline/uncertain hooks) with tests.
- `auth`: permission keys, scoped assignments, `can()` with ABAC limits, tests.
- `hardware`: peripheral interfaces, device profile, in-memory printer.
- `observability`: pino logger with PCI redaction paths, `withSpan()` placeholder until OpenTelemetry.
- `ui`: design tokens and a `Button` primitive.

### App stubs (all build and typecheck)

- `apps/api`: NestJS 11, `GET /v1/health`, first module `platform` with the `modules/<name>/public/` convention.
- `apps/worker`: Nest application context with an `outbox` module whose relay is a no-op tick.
- `apps/admin-web`: Next.js 15 App Router page using `@pos/ui` tokens.
- `apps/pos`, `apps/kds`: Vite + React shells; the POS shell prices golden case 5 on-device and toggles cash/card to show rounding. Each has a Tauri 2 `src-tauri/` scaffold (`tauri.conf.json`, `Cargo.toml`, `lib.rs`), **not compiled by CI** (no Rust toolchain assumed; bundle icons absent, `bundle.active: false`).
- `apps/store-hub`: Node HTTP service with `/health` stamped by an HLC.

### Module-boundary lint (`tools/eslint/boundaries.js`)

Element types `module-public`, `module`, `app`, `package`, `tools`. Rules: apps → packages + own modules' `public/`;
module internals → packages + any module's `public/` (never internals); a module's `public/` → its own internals;
package-to-package allowed matrix (domain-core imports nothing; contracts → domain-core; db → contracts; testing → db,
contracts, domain-core; …). `@pos/*` imports resolve to source via `tsconfig.eslint.json`, so lint needs no build.

## What is stubbed or partial

- Pricing steps 1 and 3 (price lists, promotions) — F3.
- Drizzle schema covers one table; the "generated and diff-checked against SQL" exit criterion is open.
- Worker does not yet import the API's domain modules; where shared Nest modules live (inside `apps/api` vs a `packages/modules`) is an open layout decision — the boundary rules work either way.
- Hardware drivers, provider adapters other than mock, Store Hub state/mDNS/WebSocket, admin screens, POS/KDS UIs.
- Observability is a logger; no OpenTelemetry exporter.
- Mock payment provider service in docker-compose (the SDK mock exists in-process; the compose entry is a TODO).
- Architecture test that parses Drizzle table ownership per module (plan §2) — not written; lint covers import paths only.
- `pnpm dev` orchestration of api + admin + pos is per-app `dev` scripts only.

## Remaining from the Sprint 0 table

| Item                           | Status                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| Monorepo scaffold              | Done except Storybook                                                                        |
| Local environment              | Compose + `db:migrate` done; mock payment provider service and `pnpm dev` orchestration open |
| Schema bootstrap               | Migration 0001 + RLS test done; Drizzle generation/diff-check open                           |
| Hardware spike (R1)            | **Not started** (out of scope for this bootstrap)                                            |
| Payment capability matrix (R3) | **Not started** (out of scope)                                                               |
| Threat model v1                | **Not started** (out of scope)                                                               |
| Design foundations / Storybook | Tokens seeded; Storybook and the 20 components open                                          |
| Infra baseline (Terraform)     | **Not started** (out of scope); placeholder README in `infra/terraform`                      |

## Notes for reviewers

- The Prettier pass used to normalise the new code also reformatted `README.md` and `docs/0*.md` (markdown table padding and list markers; no content changes). Those paths are now in `.prettierignore` so it will not happen again. The SQL files were never touched.
- `next build` rewrites `apps/admin-web/next-env.d.ts`; the committed version matches what Next 15.5 writes.
- `pnpm install` logs a failed optional native build for `ssh2` (pulled in by Testcontainers); it is optional and everything works without it.
- Integration tests need Docker. On this machine the suite runs in about 12 s once the image is cached.
