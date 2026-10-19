# Implementation Plan

Companion to [01-system-architecture.md](01-system-architecture.md) and [02-database-design.md](02-database-design.md). This plan is organized as **vertical slices**: each slice ships schema, domain logic, API, UI, authorization, tests and docs together, and ends in a demoable state.

---

## 1. Technology stack and rationale

| Layer                | Choice                                                                                                                                                                                        | Reasoning                                                                                                 | Alternative if the choice fails                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Language             | TypeScript end to end (strict)                                                                                                                                                                | One language for server, POS, KDS, admin, Store Hub; shared `domain-core` is the correctness lever        | —                                                       |
| Backend framework    | NestJS 10 on Node 22 LTS                                                                                                                                                                      | Module system maps to bounded contexts; DI makes adapters swappable; mature OpenAPI, guards, interceptors | Fastify + custom module wiring                          |
| Validation/contracts | zod schemas in `packages/contracts`, OpenAPI 3.1 generated from them                                                                                                                          | Single source for request/response types, client SDK, and jsonb column schemas                            | TypeBox                                                 |
| ORM / SQL            | Drizzle ORM + raw SQL migrations                                                                                                                                                              | SQL stays visible (RLS, partitions, exclusion constraints need it); type-safe queries                     | Prisma (loses some SQL control), Kysely                 |
| Database             | PostgreSQL 16 (Aurora PostgreSQL, multi-AZ)                                                                                                                                                   | RLS, exclusion constraints, partitioning, JSONB, proven at scale                                          | Self-managed Postgres on EC2 for cost-sensitive regions |
| Cache / streams      | Redis 7 (ElastiCache) with BullMQ + Streams                                                                                                                                                   | Queues, rate limits, pub/sub for WebSocket hints, locks                                                   | NATS JetStream when fan-out or retention needs grow     |
| Object storage       | S3 (+ Object Lock bucket for audit anchors)                                                                                                                                                   | Receipts, exports, images                                                                                 | —                                                       |
| Admin web            | Next.js 15 (App Router), React 19, TanStack Query/Table, shadcn/ui on our token set                                                                                                           | Fast data-heavy UIs, SSR for first paint                                                                  | Vite SPA                                                |
| POS / KDS / CFD      | React 19 + Vite inside **Tauri 2** (Windows, Android, macOS, iOS); SQLite via `tauri-plugin-sql`/`op-sqlite`; native plugins for USB/serial/Bluetooth                                         | One codebase for terminal, tablet, KDS; small footprint; native where needed                              | Electron (desktop) + React Native (tablets)             |
| Handheld (Phase 3)   | React Native (Expo, dev client) sharing `domain-core`, `ui` primitives                                                                                                                        | Camera scanning, mobile payments SDKs                                                                     | Tauri mobile if plugin ecosystem matures                |
| Store Hub            | Node 22 service, SQLite (better-sqlite3), mDNS (`bonjour-service`), WebSocket; shipped as Docker image and as a signed binary (pkg)                                                           | Same domain code as server, runs on a NUC or the primary register                                         | —                                                       |
| Hardware             | `packages/hardware`: ESC/POS & Star Line printing (`node-thermal-printer`-style implementation), HID scanners, serial scales (NTEP/OIML protocols), drawer kick via printer, Zebra ZPL labels | Device profiles with declared capabilities                                                                | Vendor SDK wrappers per profile                         |
| Payments             | `packages/payments-sdk`: adapter interface + `mock`, `stripe` (Terminal + PaymentIntents), `adyen` (Terminal API), `tyro` (iClient), `linkly` (Cloud)                                         | Australia-first coverage; mock enables full e2e without a bank                                            | —                                                       |
| Auth                 | Own IdP on Keycloak (or Auth0/Cognito if ops prefers managed), OIDC, passkeys, TOTP; POS device sessions with Ed25519 device keys                                                             | Enterprise SSO federation on day one                                                                      | —                                                       |
| Infra                | AWS ap-southeast-2; ECS Fargate; Aurora; ElastiCache; S3; CloudFront + WAF; Secrets Manager; Terraform; GitHub Actions; OpenTelemetry → Grafana Cloud                                         | Managed, multi-AZ, codified                                                                               | EKS if sidecars/mesh needed                             |
| Analytics (Phase 3)  | ClickHouse Cloud + dbt                                                                                                                                                                        | Columnar analytics on event stream                                                                        | BigQuery / Snowflake                                    |
| Testing              | Vitest (unit), Testcontainers (Postgres/Redis integration), Playwright (web e2e), WebdriverIO/Tauri driver (POS e2e), k6 (load), Stryker (mutation on domain-core)                            | Full pyramid; mutation testing on the money code                                                          | —                                                       |

---

## 2. Repository structure (pnpm workspace + Turborepo)

```
pos-platform/
├─ apps/
│  ├─ api/               NestJS: HTTP + WebSocket + sync endpoints (all modules)
│  ├─ worker/            Same Nest modules, worker entrypoint: outbox relay, consumers, jobs
│  ├─ payments/          Payments deployable (payments + audit modules only, separate secrets)
│  ├─ admin-web/         Next.js admin console
│  ├─ pos/               Tauri 2 + React: POS, CFD mode, retail & restaurant UIs
│  ├─ kds/               Tauri 2 + React: kitchen display
│  ├─ store-hub/         Node LAN service
│  ├─ handheld/          React Native (Phase 3)
│  └─ kiosk-web/         Web kiosk / QR ordering (Phase 3)
├─ packages/
│  ├─ domain-core/       Pure TS: money, tax, pricing, promotions, order reducers, state machines, recipe explosion, cash rounding
│  ├─ contracts/         zod schemas, OpenAPI spec, event catalog, generated TS client, jsonb column schemas
│  ├─ db/                Drizzle schema (mirrors db/schema*.sql), migrations, seeders, test factories
│  ├─ sync-protocol/     Command/batch/feed types, HLC, local command log, reducers wiring for devices
│  ├─ hardware/          Peripheral interfaces, drivers, device profiles, diagnostics
│  ├─ payments-sdk/      Provider/terminal adapter interfaces + implementations
│  ├─ ui/                Design system: tokens, React components, Storybook
│  ├─ auth/              Token handling, permission keys, policy evaluation (shared server/client for UI gating only)
│  ├─ observability/     OTel setup, logger, metrics helpers
│  └─ testing/           Testcontainers helpers, cross-tenant test harness, golden-file runner
├─ db/                   Canonical SQL (schema.sql, schema_part2.sql, schema_part3.sql), proof-job SQL
├─ infra/
│  ├─ terraform/         Network, Aurora, Redis, ECS, S3, WAF, Secrets, observability
│  ├─ docker/            Local compose: postgres, redis, mock-provider, store-hub
│  └─ github/            Reusable workflows
├─ docs/                 PRD, ADRs (docs/adr/NNN-*.md), runbooks, threat model, API guides
└─ tools/                Codegen, lint rules (module boundaries), schema→contract checks, column-name PCI scanner
```

Module boundary enforcement: `eslint-plugin-boundaries` config lists allowed imports (`apps/* → packages/*`, `modules/<x> → modules/<y>/public` only). An architecture test fails CI if a module imports another module's Drizzle tables.

---

## 3. Team and cadence

| Role                                       | Count | Focus                                                       |
| ------------------------------------------ | ----- | ----------------------------------------------------------- |
| Principal architect / tech lead            | 1     | Boundaries, ADRs, reviews, domain-core                      |
| Backend engineers                          | 3     | Modules, sync, payments, inventory                          |
| POS/KDS frontend engineers                 | 2     | Tauri apps, hardware, offline UX                            |
| Admin web engineer                         | 1     | Next.js console, reporting UI                               |
| Mobile/hardware engineer                   | 1     | Device profiles, printers, terminals, handheld (Phase 3)    |
| SDET                                       | 1     | Test harnesses, e2e, load, chaos                            |
| DevOps/SRE                                 | 1     | Infra, CI/CD, observability, DR                             |
| Product designer                           | 1     | Design system, flows, usability tests                       |
| Product manager                            | 1     | PRD, backlog, acceptance criteria, pilot customers          |
| Payments/compliance specialist (part-time) | 0.5   | Provider onboarding, PCI responsibility matrix, QSA liaison |

Cadence: 2-week sprints, slice-based milestones, demo every sprint to pilot customers (one retailer, one cafe/restaurant) from Phase 1 slice 6 onward.

---

## 4. Phase 0 — Sprint 0 (2 weeks): spikes and foundations

| Item                           | Output                                                                                               | Exit criterion                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Monorepo scaffold              | pnpm/Turbo, lint, tsconfig, Vitest, Storybook, CI skeleton                                           | `pnpm test` and `pnpm build` green on CI                         |
| Local environment              | docker compose (Postgres 16, Redis, MinIO, mock payment provider), `pnpm dev` runs api+admin+pos     | New engineer productive in < 1 hour                              |
| Schema bootstrap               | Apply `db/schema*.sql` via migration 0001; Drizzle schema generated and diff-checked against SQL     | Schema applied in CI; RLS test passes                            |
| Hardware spike (R1)            | Tauri 2 on Windows + Android: ESC/POS USB & network print, drawer kick, HID scanner, Bluetooth scale | Go/no-go on Tauri for hardware; fallback decision documented     |
| Payment capability matrix (R3) | Sandbox tests with Tyro, Adyen, Stripe Terminal, Linkly, recorded per connection mode (local API, SDK, cloud) | Matrix populated: offline by mode, caps and windows, tip adjust, refunds, LCR; surcharging recorded as banned for AU domestic cards from 1 Oct 2026 |
| Payments Edge spike (R11)      | Adyen local Terminal API driven from a Tauri native plugin and from the Store Hub; Tyro iClient inside the Tauri webview | Decision on where terminal adapters run per profile; offline queue design confirmed against provider caps |
| Tyro certification kick-off    | Scoping call, test environment, certification plan with Tyro integration team                        | Certification timeline on the roadmap (mandatory before production)   |
| Supported devices and OS matrix | Minimum OS versions (Windows, Android, iOS), terminal models and firmware, printers, scanners, scales, routers for Store Hub | Published in docs/operations and enforced by device enrollment checks |
| Threat model v1                | STRIDE on the architecture, abuse cases for POS                                                      | Reviewed by security engineer; mitigations mapped to slices      |
| Design foundations             | Tokens, type scale, core components, POS layout grid (see 04-design-plan)                            | Storybook with 20 base components                                |
| Infra baseline                 | Terraform: VPC, Aurora dev, Redis, ECS cluster, S3, Secrets, GitHub OIDC deploy role                 | `dev` environment deployed from CI                               |

---

## 5. Phase 1 — Platform Foundation (~14 weeks to pilot, 16 to exit, slices F1–F10)

Scope change (18 Oct 2026 review): the kitchen display moves out of Phase 1; restaurants pilot with kitchen **printing**, which is how Odoo CE and most SMB competitors ship. Phase 1 therefore has two front-end surfaces under load (POS app, admin console) rather than three.

Each slice lists: scope → acceptance criteria → tests. Authorization and audit are in scope of every slice.

### F1. Tenancy, identity, access (2 weeks)

- Scope: tenants, org units (closure), legal entities, locations, departments, registers, config entries; users, passwords, TOTP, passkeys, sessions; system roles + permissions catalog; role assignments with scopes; permission limits; approval requests; audit log with hash chain; idempotency middleware; outbox + relay skeleton.
- API: `/v1/auth/*`, `/v1/tenants/me`, `/v1/org-units`, `/v1/locations`, `/v1/registers`, `/v1/users`, `/v1/roles`, `/v1/role-assignments`, `/v1/config`, `/v1/audit`.
- Acceptance: a user scoped to Location A receives 404 for Location B resources; RLS blocks a deliberately buggy repository in a test; config resolution returns the nearest override; audit chain verifies.
- Tests: cross-tenant harness runs every endpoint with a foreign tenant token; property test on closure maintenance; chain tamper test.

### F2. Catalog and tax (2 weeks)

- Scope: categories, tax classes, tax rules (AU GST seed), items, variants, barcodes, units, components, modifier groups/modifiers/item links, menus/sections/assignments, availability, suppliers; CSV import with validation report; search.
- Acceptance: barcode lookup p95 < 50 ms at 1M variants (local bench); fuzzy search returns correct top-3 for misspellings; menu resolver picks correct menu for (location, channel, time) in a table of 30 cases.
- Tests: import golden files; resolver table tests; search benchmark in CI (informational).

### F3. Pricing engine in `domain-core` (2 weeks, parallel with F2)

- Scope: money/rounding library, price resolution, manual discounts, promotion DSL v1 (percent_off, amount_off, fixed_price, bogo, multibuy, threshold) with priorities/stacking/exclusions, proportional allocation (largest remainder), tax (inclusive/exclusive, exemptions, multiple rates), charges, cash rounding (AUD 5c), full trace output.
- Acceptance: 150+ golden cases including the brief's burger meal-deal example, mixed-rate baskets, inclusive/exclusive parity, allocation sums exactly, idempotent re-pricing.
- Tests: golden files; property tests (sum of line totals = order total; discount never exceeds subtotal); mutation score ≥ 85 % on domain-core.

### F4. Order engine and receipts (2 weeks)

- Scope: orders/checks/lines/modifiers/taxes/discounts/charges, order events, number sequences, suspend/resume, void with approval, order notes/metadata; receipt templates (HTML → PDF/ESC-POS render), reprint logging; three-status model; `priceOrder()` integration; idempotent commands.
- API: `/v1/orders` (create, add/update/remove lines, apply discount, suspend, resume, place, void), `/v1/orders/:id/receipts`.
- Acceptance: duplicate `Idempotency-Key` returns the same response; concurrent line adds on one order serialize via version check; voids require `orders.void` or approval; receipts show tax breakdown correctly for inclusive pricing.
- Tests: integration with Testcontainers; concurrency test (50 parallel adds); approval flow test.

### F5. Payments core: cash + mock + first real provider (3 weeks)

- Scope: provider accounts, terminals, intents/attempts/events, refunds, card details (masked only), webhook inbox with signature + dedupe, uncertain-state resolver job, settlement import (mock + first provider), reconciliation exceptions, stuck-payment sweeper; cash tender with change and rounding; gift card tender (ledger); payments deployable with separate secrets.
- First real provider: chosen from R3 matrix (recommendation: Adyen Terminal API or Stripe Terminal for breadth; Tyro for AU eftpos economics; pick one, second in Phase 2).
- Acceptance: the brief's invariants are tests: "no acknowledged transaction lost", "no duplicate charge from retry", "paid only on captured"; webhook replay is a no-op; forged signature is rejected and logged; `uncertain` resolves via `getStatus` within 60 s in the mock.
- Tests: state machine exhaustive transition tests; chaos tests injecting timeouts; contract tests against provider sandbox (nightly).

### F6. POS app shell — retail checkout online (3 weeks, parallel from week 5)

- Scope: Tauri app, device enrollment, PIN login, local SQLite catalog/config replica via change feed, barcode scan → line add, quantity/price override (with approval UX), discounts, customer attach (basic), suspend/resume, cash & card (terminal) payment, receipt print/email, X report; CFD second-window mode.
- Acceptance: scan-to-line < 100 ms local; checkout of 10 items + cash payment in ≤ 12 taps; printer offline shows recovery UI; register-local order ref printed.
- Tests: Tauri e2e with mock scanner events; snapshot tests for receipts; accessibility checks on touch targets.

### F7. Restaurant basics online: menus, modifiers, tables list, kitchen printing (3 weeks, parallel)

- Scope: menu grid, modifier flow with validation, dine-in order with table session (simple list, no floor plan yet), send/fire, kitchen stations + routing rules, tickets/items/events model, **kitchen ticket printing per station** (ESC/POS via the hardware layer; voids and modifications print as change tickets), item-level status, cancellation propagation. The KDS screen itself ships in M8a.
- Acceptance: modifier combos validated before add; fired lines produce a ticket at the right station printer in < 2 s online; a voided fired item prints a VOID chit; no ticket item disappears without an event.
- Tests: routing table tests; print-spool e2e with a mock ESC/POS printer; event replay test.

### F8. Admin console v1 (3 weeks, parallel)

- Scope: org/locations/registers, users/roles/assignments, catalog editor (items, variants, barcodes, modifiers, menus, availability), tax, price lists, promotions v1 editor with preview, devices & enrollment codes, receipt templates, audit browser, config editor with versions/rollback.
- Acceptance: every write shows in audit with before/after; bulk CSV import with downloadable error report; promotion preview uses the same engine as POS.
- Tests: Playwright flows; permission-gated UI matches server policies (shared `auth` package).

### F9. Core reporting and business day (2 weeks)

- Scope: business day open/close, X/Z reports, `rm_sales_daily`, `rm_item_sales_daily`, `rm_payment_method_daily`, freshness, dashboard (today, by location), exports (CSV/PDF async), nightly proof jobs 3, 4, 7, 8.
- Acceptance: dashboard totals equal raw sums per business date (proof job green); time-zone correctness across two locations in different zones.

### F10. Hardening and release readiness (2 weeks)

- Scope: OTel tracing everywhere, dashboards/alerts, k6 load profile (1k concurrent registers, 200 orders/s), security tests (cross-tenant, IDOR, replay), dependency and container scanning, DR drill (restore from PITR), runbooks, pilot onboarding guide.
- Exit: SLOs in §12.1 of the architecture doc met on the load profile for implemented endpoints; zero P1 security findings; pilot stores onboarded.

Phase 1 deliverable: both a retailer and a cafe can trade online with cash and one card provider, with real receipts, kitchen printing, real audit, real reports.

---

## 6. Phase 2 — Retail and Restaurant MVP (~18 weeks, slices M1–M13)

| Slice                                                           | Scope                                                                                                                                                                                                             | Key acceptance                                                                                                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M1. Offline sync (device-autonomous) (4 wks)                    | Command log, HLC, upload/download protocol, conflict table, offline order refs, server re-pricing with `pricing_mismatch`, offline cash/gift card policy, storage quota handling, crash recovery, sync monitor UI | 24 h offline trading on a device then sync: zero loss, zero duplicates, correct business dates; chaos test "kill app mid-payment" passes |
| M2. Inventory ledger + adjustments + counts (3 wks)             | Inventory locations, balances, movements on sale/return/void, adjustments with reasons, cycle & blind full counts, reservations, low-stock alerts, proof jobs 1–2, inventory UI in admin + POS stock lookup       | Balance drift job finds planted drift; count approval writes variance movements                                                          |
| M3. Returns, exchanges, refunds (2 wks)                         | Return orders linked to original lines, no-receipt returns under policy, exchange flows, refund to original tender/cash/store credit, RMA basics, loyalty reversal hooks                                          | Refund over limit requires approval; refund reconciles against original intent                                                           |
| M4. Purchasing (3 wks)                                          | Suppliers detail, PO lifecycle with approvals, goods receipts (partial), supplier invoices refs, cost updates (weighted average), replenishment suggestions v1 (min/max/lead time)                                | Receipt posts movements with cost; suggestion math table-tested                                                                          |
| M5. Promotions v2 + coupons + price lists (2 wks)               | Scheduled promos, coupons, customer-group lists, employee discount, markdowns, promotion reporting from `order_discounts`                                                                                         | Same results POS offline vs server (golden set)                                                                                          |
| M6. Cash management (2 wks)                                     | Drawers, sessions, float, paid in/out, drops, blind counts, variance approval, Z integration, cash variance alerts, proof job 5                                                                                   | Every shift has an accountability report; variance thresholds page a manager                                                             |
| M7. Floor plan + table operations (3 wks)                       | Visual floor plan editor and live map, seat/merge/split/transfer, guest counts, timers, reservations (basic) with exclusion constraint, waitlist                                                                  | Double booking impossible at DB; transfer preserves checks and kitchen tickets                                                           |
| M8a. KDS LAN hub + KDS app (3 wks)                              | Store Hub service owning **kitchen tickets and printers only** (checks stay device-owned, as Toast does), mDNS discovery with static-address fallback, one-subnet preflight in enrollment, KDS Tauri app with station cursors/replay, printer fallback, expo view, all-day counts | Internet cut in lab: KDS and printing continue for 4 h then sync cleanly; router restart during outage does not stop printing          |
| M8b. Shared open checks on the Hub (3 wks)                      | Hub becomes authoritative for live store state (open checks, table map), device↔hub protocol for check ownership, hub↔cloud sync, conflict policy for unreachable hub, Payments Edge module on the Hub                  | Two devices edit one table offline through the Hub; hub failure drill passes; no check is lost or duplicated                             |
| M9. Split checks, seats, courses, tips, service charges (2 wks) | Split by item/seat/amount, shared items (fractional), course firing/holds, tips on terminal (adjust where supported), service charge rules, tip distribution record                                               | Split totals reconcile to the cent; course fire updates stations                                                                         |
| M10. Recipes and basic food cost (2 wks)                        | Recipes, modifier effects, consumption on completion/fire, waste records, theoretical vs actual report v1, ingredient low-stock                                                                                   | Consumption reflects voids/comps/staff meals separately                                                                                  |
| M11. Payment reconciliation + second provider + offline card (3 wks) | Settlement import for both providers, matching, exceptions UI, disputes import; offline store-and-forward through the Payments Edge for the modes that support it (Adyen local, Stripe SDK), caps and expiry, forward-outcome tracking, reopened-check flow and manager queue for declines | Daily settlement reconciles with explained exceptions only; offline-decline drill passes with Adyen test cards that enforce limits and Stripe's simulated offline reader; an expired offline payment reopens its check |
| M12. Multi-store ops + essential reports (2 wks)                | Transfers between stores, store comparison dashboard, product/menu performance, refunds/voids analysis, payment cost report with least-cost-routing visibility, scheduled email reports, saved filters           | Regional manager sees only their org unit's stores                                                                                       |
| M13. Accounting export v1 (1 wk)                                 | Daily journal export to Xero (sales by tax code, tenders, tips, rounding, cash variance, gift card liability) with account mapping UI; CSV fallback                                                                | Exported journal balances to the Z report for the same business date                                                                     |

Phase 2 deliverable: full MVP for independent and small multi-store retailers and restaurants, offline-capable, with two payment providers.

---

## 7. Phase 3 — Enterprise Operations (~24 weeks)

Grouped by dependency:

1. **Advanced inventory & warehouse**: FIFO cost layers, lots/serials end to end, expiry workflows, quarantine, multi-warehouse, click-and-collect/ship-from-store fulfillments, endless aisle. Depends on M2, M4.
2. **Advanced purchasing**: landed cost, backorders, supplier performance, PO matching, automatic replenishment with approval queue.
3. **Franchise & multi-entity**: reporting boundaries, entity-level consolidation, intercompany transfers, entity-specific receipts/fiscal settings.
4. **Promotion engine v3**: bundles, tiered/volume, minimum-margin controls, price matching, competitor price feed integration.
5. **Loyalty & CRM**: programs, tiers, rewards, store credit, gift card programs, consent-based messaging integrations, cross-brand programs, liability reporting.
6. **Omnichannel**: Shopify connector **first and early** (Shopify's Stocky inventory app retires on 31 August 2026, leaving POS Pro merchants without transfers/forecasting), then WooCommerce, delivery aggregators (Deliverect/direct Uber Eats), order routing, cross-channel returns, QR ordering, web kiosk.
7. **Advanced restaurant**: reservations platform integrations, catering/banquet orders with deposits, central kitchen/commissary production, kitchen capacity management, drive-through.
8. **Workforce integrations**: Deputy/Tanda clock-ins, labor cost in reports, tasks/checklists/inspections.
9. **Accounting integrations**: MYOB and NetSuite journal exports (Xero v1 ships in M13), settlement/fee posting, inventory valuation export.
10. **Central configuration management**: config rollout waves, scheduled changes, rollback, diff view.
11. **Analytics tier**: ClickHouse pipeline, dbt models, BI connector, basket analysis, inventory turnover, benchmarking.
12. **Handheld app** (React Native): line busting, mobile ordering, stock counts with camera.
13. **Platform**: public API GA, developer portal, sandbox tenants, webhook console, OAuth apps.
14. **Reliability**: second-region warm standby (RTO 1 h), chaos program, capacity model, **Store Hub failover** (secondary hub or primary-register takeover, mirroring Simphony's backup CAPS and backup KDS controller).

## 8. Phase 4 — Advanced Platform (ongoing)

AI layer (forecasting, replenishment recommendations, anomaly detection, natural-language analytics, daily summaries) built on the analytics tier with mandatory evidence/assumption/confidence output and no autonomous financial actions; advanced payment routing where permitted; fraud detection; app marketplace with sandboxed server functions; multi-country expansion packs (tax, fiscalization, payment providers, languages); advanced observability automation.

---

## 9. Testing strategy

| Level                           | What                                                                                                                                                                                                                                 | Gate                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Unit (Vitest)                   | `domain-core` (pricing, tax, promotions, rounding, allocation, state machines, recipe explosion), policy evaluation, adapters' mappers                                                                                               | 100 % of money paths covered; mutation score ≥ 85 % |
| Golden files                    | Pricing and tax scenarios as JSON; same files run on server and inside the POS app build                                                                                                                                             | Any diff fails CI                                   |
| Integration (Testcontainers)    | Repositories with RLS, transactions, outbox, idempotency, migrations up/down, proof jobs                                                                                                                                             | Required on every PR                                |
| Cross-tenant harness            | Every route invoked with (a) foreign tenant token, (b) same tenant out-of-scope location → expects 404; generated from OpenAPI so new routes are auto-covered                                                                        | Required                                            |
| Contract tests                  | Provider sandboxes (nightly), webhook fixtures, Store Hub ↔ device protocol, sync protocol versions                                                                                                                                  | Nightly; blocking before release                    |
| E2E (Playwright / Tauri driver) | Retail: scan → promo → customer → pay → print → inventory → return → reconcile. Restaurant: open table → items → modifiers → routing → KDS status → split → pay → consumption → reconcile                                            | Required on main                                    |
| Reliability                     | Network partition, app kill mid-checkout, duplicate requests, delayed/out-of-order webhooks, payment timeout, DB failover, queue failure, printer failure, terminal disconnect, conflicting inventory updates, 72 h offline recovery | Nightly chaos suite; blocking before release        |
| Load (k6)                       | 1k registers, 200 orders/s sustained, 10× catalog sync burst at store open                                                                                                                                                           | Nightly; SLO report                                 |
| Security                        | SAST, dependency/OSV, container scan, secrets scan, PCI column-name scanner, DAST on staging, annual pentest, QSA review before GA                                                                                                   | Blocking on high/critical                           |
| Accessibility                   | axe on admin and POS screens; manual keyboard runs                                                                                                                                                                                   | Blocking on serious                                 |

Definition of done for a slice: migrations reviewed as SQL; domain tests + golden files; API in OpenAPI with examples; authorization + cross-tenant tests; UI with empty/error/offline states; observability (spans, metrics, alerts) added; runbook updated; feature flag; acceptance criteria demoed.

---

## 10. CI/CD and environments

```
PR  → lint, typecheck, unit, golden, integration (Testcontainers), cross-tenant, build images, Storybook, preview env (ephemeral)
main→ all above + e2e + migrate dev → deploy dev → smoke
tag → migrate staging → deploy staging → e2e + k6 + DAST → manual approval → migrate prod (expand only) → blue/green deploy → canary 10 % → SLO watch 30 min → 100 % → contract-phase migrations later
```

Environments: `dev` (shared), `preview-<pr>` (ephemeral, seeded), `staging` (prod-like, provider sandboxes, synthetic tenants), `prod-au` (first region). Device apps: internal track → pilot track → general; Tauri auto-updater with signed bundles and staged rollout by tenant; a kill-switch flag can pin devices to a previous version.

Rollback: blue/green swap for services; migrations are expand-only so code rollback never needs schema rollback; contract phase runs one release later behind a flag.

---

## 11. Milestones and timeline (indicative)

| Week | Milestone                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------- |
| 2    | Sprint 0 exit: spikes decided, dev env, schema applied, design tokens                                               |
| 6    | F1–F3: tenancy/identity, catalog, pricing engine with golden suite                                                  |
| 10   | F4–F5: orders, receipts, cash + mock + first provider; invariants tested                                            |
| 14   | F6–F9: POS retail online, restaurant order entry + kitchen printing, admin v1, core reports — **pilot stores live (online mode)** |
| 16   | F10: hardening, SLO validation, DR drill — **Phase 1 complete**                                                     |
| 22   | M1–M3: offline, inventory, returns                                                                                  |
| 28   | M4–M7, M8a: purchasing, promotions v2, cash, floor plan, KDS LAN hub + KDS app                                      |
| 34   | M8b–M13: shared checks on Hub, splits/tips, recipes, reconciliation + offline card, multi-store, Xero export — **Phase 2 / MVP GA** |
| 58   | Phase 3 enterprise capabilities complete                                                                            |

---

## 12. Risk register (delivery)

| Risk                                               | Likelihood | Impact | Response                                                                                                    |
| -------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Hardware integration in Tauri fails on a target OS | Medium     | High   | Sprint 0 spike; Store Hub-owned printing as fallback; Electron fallback path documented                     |
| Provider certification/onboarding delays           | High       | High   | Start merchant onboarding in Sprint 0; mock provider keeps development unblocked; two providers in parallel |
| Offline edge cases exceed estimates                | High       | Medium | M1 is 4 weeks with chaos tests defined first; scope offline card to providers with native store-and-forward |
| Store Hub authority model is hard to get right     | Medium     | High   | Prototype early (M8 starts design in M1); lab with real devices; failure drills as acceptance               |
| RLS + partitioning performance                     | Low        | Medium | Benchmarks in F10 with synthetic 10k tenants; tenant-hash partitioning plan ready                           |
| Scope pressure from enterprise prospects           | High       | Medium | Phase gates; feature flags; "implemented / tested / simulated / planned" status on every feature            |
| Key-person dependency on domain-core               | Medium     | High   | Pairing rotation; golden files as executable spec                                                           |
| Offline card depends on LAN-side integration and provider certification (Tyro mandatory; Adyen store-and-forward enabled by Support) | High | High | Payments Edge spike and Tyro kick-off in Sprint 0; offline card scoped to Adyen local and Stripe SDK modes first; honest UI copy |
| Phase 1 still carries two restaurant surfaces (order entry, printing) plus retail | Medium | Medium | KDS moved to M8a; if F6/F7 slip past week 13, pilot retail first and restaurant two weeks later |

---

## 13. Open decisions requiring stakeholder input

1. First payment provider (economics vs breadth): Tyro vs Adyen vs Stripe Terminal. Needs merchant pricing and the R3 matrix.
2. Identity provider: self-hosted Keycloak vs managed (Auth0/Cognito).
3. Target hardware profiles for GA (Windows 11 all-in-one terminals, Android tablets, iPad): drives Tauri plugin work.
4. Store Hub packaging: dedicated appliance vs "primary register runs hub" vs both.
5. Second market after Australia (NZ is the natural candidate: GST 15 %, Windcave/Verifone, no fiscalization) to shape localization work in Phase 3.
6. Accounting integration order: Xero first (AU SMB), then MYOB, then NetSuite for enterprise.
7. Whether to adopt ClickHouse in Phase 3 or defer to Phase 4 depending on reporting demand.
8. Payments Edge host for single-register stores: Tauri native plugin on the register (default proposal) or a mandatory small Hub appliance even for profile B.
9. Packaging: per-location vs per-device (KDS per screen is the market norm at USD 30–40/screen) affects feature flags and device entitlements in tenancy.

---

## 14. Phase-end reporting template

At the end of each phase, produce `docs/releases/phase-N.md` with: features completed (with implemented/tested/simulated/planned status), architectural decisions (ADR links), modules and files changed, migrations applied, APIs introduced (OpenAPI diff), tests executed and results (unit/integration/e2e/load/security), known limitations (including provider and hardware limits), security considerations, deployment instructions, remaining tasks, recommended next steps.

---

## 15. Parallel execution plan (agent fan-out)

Added 18 October 2026 so that several agents (or engineers) can work on Phase 1 at the same time in one checkout without stepping on each other. The slices in §5 stay the unit of acceptance; this section says **who owns which paths**, **what may be edited concurrently**, and **in which wave** each stream can start.

### 15.1 Ownership boundaries

Each stream owns the paths listed and may create anything beneath them. A stream never edits another stream's paths. Integration between streams happens through TypeScript interfaces ("ports") declared in the owning package and stub implementations, replaced in an integration slice.

| Stream | Slice(s) | Owns (exclusive) | Ports it provides / consumes |
|---|---|---|---|
| S-F2 Catalog & tax | F2 | `apps/api/src/modules/catalog/**`, `apps/api/src/modules/pricing/**` (tax only), `packages/contracts/src/catalog.ts`, `packages/contracts/src/pricing.ts`, `packages/db/src/schema/catalog.ts`, `packages/db/src/schema/pricing.ts`, `packages/domain-core/src/catalog/**`, `packages/domain-core/src/tax/**`, `packages/domain-core/src/pricing/**` | Provides `CatalogPort` (variant lookup, snapshot), `TaxRuleResolver` |
| S-F3 Price engine & promotions | F3 (+ price lists/promotions API) | `packages/domain-core/src/price-engine/**`, `packages/domain-core/golden/price-engine/**`, `packages/contracts/src/price-engine.ts`, `packages/contracts/src/promotions.ts`, `packages/db/src/schema/promotions.ts`, `apps/api/src/modules/promotions/**` | Provides `PricingPort.priceOrder()`; consumes `TaxRuleResolver` through an interface with an in-package stub |
| S-F4 Orders & receipts | F4 | `packages/domain-core/src/orders/**`, `packages/contracts/src/orders.ts`, `packages/db/src/schema/orders.ts`, `apps/api/src/modules/orders/**`, `apps/api/src/modules/receipts/**` | Consumes `PricingPort`, `CatalogPort` via stubs (list price only) until the integration slice; provides `OrderPort` (check totals, payment applied) |
| S-F5 Payments core | F5 | `packages/payments-sdk/**`, `packages/contracts/src/payments.ts`, `packages/db/src/schema/payments.ts`, `apps/api/src/modules/payments/**`, `apps/payments/**` | Consumes `OrderPort` via stub; provides `PaymentsPort` |
| S-F6a POS shell | F6 (shell, enrollment, PIN login, hardware, local store) | `apps/pos/**`, `packages/hardware/**`, `packages/sync-protocol/**` | Consumes F1 device/auth APIs (live), catalog contracts (types only) |
| S-F8 Admin console v1 | F8 (F1 entities first) | `apps/admin-web/**` | Consumes F1 APIs; catalog editor added in Wave 2 |
| S-UI Design system | Design plan §3 | `packages/ui/**` | Consumed by admin and POS; admin may keep app-local components until components land |
| S-INFRA Delivery | Sprint 0 infra, §10 | `infra/**`, `.github/**`, `packages/observability/**`, `apps/worker/**` (worker bootstrap only) | — |
| S-DOCS Operations & security | Sprint 0 docs | `docs/security/**`, `docs/operations/**`, `docs/payments/**`, `docs/adr/**` | — |
| Integration (lead) | F2+F3+F4 wiring, F7, F9, F10 | shared files below, `apps/api/src/*.integration.test.ts` | Replaces stubs with real ports |

### 15.2 Shared files protocol

Shared files: `apps/api/src/app.module.ts`, `packages/contracts/src/index.ts`, `packages/db/src/schema/index.ts`, `packages/domain-core/src/index.ts`, `packages/db/src/roles.ts`, root `package.json`, `pnpm-lock.yaml`.

1. Read the file immediately before editing and **append only** your import/export line; never reorder, reformat or remove lines.
2. Do not run repo-wide formatting (`pnpm format`), repo-wide `pnpm build` or root `pnpm test` while other streams are active; run `pnpm --filter <your package> test` and `tsc --noEmit` for your packages. The integration lead runs the full pipeline at checkpoints.
3. Do not add dependencies unless essential; if you must, add to your own package.json, run `pnpm install` once, and record it in your release notes.
4. Do not edit `db/schema*.sql`; if a defect blocks you, work around it and record it in your release notes for the integration lead.
5. No git commits, no branch switches, no stashes.
6. Write `docs/releases/<stream>.md` in the §14 format, including every stub you left and every shared-file line you appended.

### 15.3 Waves

| Wave | Streams | Start condition | Exit checkpoint |
|---|---|---|---|
| 1 (now) | S-F2, S-F3, S-F4, S-F5, S-F6a, S-F8, S-UI, S-INFRA, S-DOCS | Sprint 0 + F1 green | Integration lead runs full build/lint/typecheck/test uncached; shared-file conflicts resolved; stubs inventoried |
| 2 | Integration (wire `PricingPort`, `CatalogPort`, `OrderPort`, `PaymentsPort`), F7 restaurant + kitchen printing, F9 reporting, POS checkout screens on live APIs, admin catalog editor, M1 server-side sync endpoints, Payments Edge spike | Wave 1 checkpoint | Retail sale end to end: scan → price → pay (cash + mock) → receipt → report |
| 3 | F10 hardening, pilot onboarding, first real provider adapter, offline device mode (M1 client) | Wave 2 checkpoint | Phase 1 exit criteria |

### 15.4 Why this works

The database schema is already complete and applied, so every stream codes against real tables with FK fixtures rather than waiting for upstream schema. The ports keep compile-time coupling inside one package per stream. The cost is a deliberate integration slice in Wave 2, which is cheaper than serialising nine streams.
