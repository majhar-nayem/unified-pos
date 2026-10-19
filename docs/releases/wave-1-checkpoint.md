# Wave 1 integration checkpoint

Date: 18–19 October 2026. Integration lead's report for the Wave 1 fan-out defined in [03-implementation-plan.md §15](../03-implementation-plan.md). Stream reports: [f2.md](f2.md), [s-f3.md](s-f3.md), [s-f4.md](s-f4.md), [s-f5.md](s-f5.md), [s-f8.md](s-f8.md), [s-ui.md](s-ui.md), [s-docs.md](s-docs.md); S-F6a and S-INFRA are still in progress (their notes land as s-f6a.md and s-infra.md).

## 1. Stream status

| Stream | State | Highlights (from the stream's own report, spot-checked here) |
|---|---|---|
| S-F2 catalog & tax | complete | 79 `/v1` operations, migration 0003, AU GST seed on provisioning, menu/tax/modifier resolvers, CSV import, own harness 158 cases green |
| S-F3 price engine & promotions | complete | engine with 308 golden cases, Stryker 88.87 %, price-list/promotion/coupon API, `/v1/pricing/preview`; tax resolver stubbed |
| S-F4 orders & receipts | complete | order aggregate, three statuses, split/merge, returns, receipts (HTML/PDF/ESC-POS); 215 domain + 55 API tests; pricing, catalog and object-store stubbed |
| S-F5 payments core | complete | intent/attempt/event state machine, cash tender, mock provider, webhook inbox, settlement import, offline forwarding lifecycle; Stripe adapter **simulated**; gift-card tender not built |
| S-F8 admin console v1 | complete | F1 entities, 54 unit + 30 Playwright flows against a live API; catalog/promotions screens wait for Wave 2 |
| S-UI design system | complete | tokens build, primitives, POS/KDS composites incl. all PaymentStatusPanel states, Storybook, axe + snapshot runs |
| S-DOCS | complete | threat model, supported devices, payment capability matrix, ADR-001…020, onboarding and provisioning workflows (all marked proposals) |
| S-F6a POS shell | complete | Tauri shell, enrollment, PIN login, hardware layer (ESC/POS TCP driver), command log, local store; 104 + 28 + 22 tests; Rust side of `apps/pos/src-tauri` written but **not compiled** (no `cargo` on this machine): first job for anyone with Rust is `cargo check` ([s-f6a.md](s-f6a.md)) |
| S-INFRA | complete (local verification only) | 13 Terraform modules, three environment stacks (validate, tflint, offline plan), workflows pass actionlint, observability 62 tests, worker relay 23 tests; **nothing applied to AWS or run on GitHub-hosted runners** ([s-infra.md](s-infra.md)) |

## 2. Checkpoint run and fixes applied here

First uncached run (`turbo run typecheck test --force`, excluding the two in-progress streams): 28/32 tasks green; failures in `@pos/api#test` (2 tests), `@pos/testing#test` (1), `@pos/admin-web#build`, `@pos/sync-protocol#build`.

| Failure | Cause | Fix |
|---|---|---|
| `cross-tenant.integration.test.ts` contract completeness | new routes from S-F2/S-F3/S-F4 declared fixture names unknown to the shared registry | registry now spreads `createCatalogFixture`, `createPricingFixture` and `seedOrderFixtures` (owner token at location A); harness now covers all 244 operations |
| `identity.integration.test.ts` cloned cashier permissions | S-F4 added `orders.create`/`orders.view` to cashier; S-F5's payment keys were not in the auth catalog | payments permission keys added to `@pos/auth` catalog and roles (cashier/server: view + take; supervisor: + manage; store manager: all; finance: settlement + reconcile); pinned expectation updated |
| `crypto.test.ts` SecretBox tamper check (flaky) | replacing the last tag character with `A` was a no-op when it already was `A` | flips to a different character deterministically |
| `rls.integration.test.ts` migration list | F2 added migration 0003 | expectation is `['0001','0002','0003']` |
| `@pos/admin-web#build` | Next.js `PageNotFoundError: /_document` only when built concurrently with other tasks | standalone build is clean; final run uses `--concurrency=4`; treat as a parallel-build artefact, not a defect |
| `@pos/sync-protocol#build` | TS7017/TS2304 under the package's build tsconfig | reported to S-F6a (owner) |
| Shared catalogs | event names from S-F3/S-F4/S-F5 missing | `EVENT_CATALOG` += `order.returned`, `payment.reversed`, `refund.succeeded`, `pricing.price_list.changed`, `pricing.promotion.changed`, `pricing.coupon.changed` |
| Webhook raw body | S-F5 needs `rawBody: true` on the API app | set in `apps/api/src/main.ts` and `testing/test-app.ts` |
| OpenAPI document | routes from four streams | regenerated `packages/contracts/openapi/v1.json`: 175 paths, 244 operations |
| Docs conflict (S-DOCS) | Stripe eftpos-offline statement contradicted by Stripe's smart-reader page | qualified in 01 §8.3 and 05 §3; sandbox to settle |

Final run results: see §5.

## 3. Stub inventory (to replace in Wave 2)

| Stub | Owner | Replace with |
|---|---|---|
| `TaxRuleResolver` in-package stub (AU GST 10 % inclusive) | S-F3 price engine | S-F2's `TaxRuleResolver` from `domain-core/tax` |
| `StubPricingPort` (list price, GST, manual discounts only) | S-F4 orders | S-F3 `priceEngine.priceOrder()` |
| `StubCatalogPort` (snapshot from request) | S-F4 orders | S-F2 `CatalogPort` |
| `LocalDiskObjectStore` | S-F4 receipts | S3/MinIO object store client |
| `SqlOrderPortStub` (payments writes order totals directly) | S-F5 payments | S-F4 `OrderPortService`; **the two `OrderPort` shapes differ** (payments pushes aggregates `applyPaymentTotals`/`applyCashRounding`/`reopenForOfflineFailure`; orders exposes incremental `applyPayment`/`markPaid`/`applyRefund`/`reopenOffline`) and need an adapter plus a decision on which side owns "all checks paid completes the order" |
| `EnvPaymentSecrets` | S-F5 | Secrets Manager resolver (S-INFRA) |
| Stripe provider adapter (no key = simulated) | S-F5 | sandbox-tested adapter; first real provider decision |
| `MockTerminalAdapter` as the only terminal driver | S-F5 | Payments Edge drivers (ADR-019) |
| Catalog replica loader, pricing, payments in the POS | S-F6a | live change feed + S-F2/S-F3 contracts |

## 4. Open items carried into Wave 2

1. Wire the ports above (integration slice) and run the retail end-to-end: scan → price → pay (cash + mock) → receipt → report.
2. `OrderPort` shape decision and adapter (S-F4 vs S-F5).
3. S-F2 asks: grant `catalog.view` to floor roles and `catalog.availability.manage` to store manager/supervisor/kitchen in the auth catalog; one-off GST seed for pre-F2 tenants; async import runner.
4. S-F4 asks: approval consumed before a failing order transaction is not restored; schema gaps worked around in `order_lines.metadata` (`_grossOverrideMinor`, rule-based charges) need columns in a later migration.
5. S-F5 asks: cash-tender columns and sweeper claim function (migration); gift-card tender; `fee_mismatch` reconciliation; terminal transaction id from the Edge for crash recovery.
6. S-F8 asks: paginated list endpoints, `order=desc` on audit, invitation list/resend/cancel, device wipe and register reassignment, per-credential revoke; admin catalog/promotion screens.
7. S-DOCS: Drizzle table-ownership architecture test (ADR-001) still open; operator access is a static env token.
8. `cargo check` for `apps/pos/src-tauri` on a machine with Rust; admin-web Playwright and ui visual jobs into CI; first Terraform apply to a dev account.
9. Repository has no commits yet. Recommend an initial commit at this checkpoint so Wave 2 streams can use worktrees instead of a shared tree.

## 5. Final run

Uncached `turbo run build typecheck test --force --continue --concurrency=4`, excluding the two in-progress streams' packages (apps/pos, apps/kds, apps/worker, packages/hardware, packages/observability, packages/sync-protocol), then root `pnpm lint`:

| Result | Detail |
|---|---|
| Tasks | 33 of 34 successful at first; the one failure, `@pos/sync-protocol#build`, was fixed by S-F6a and re-verified uncached (sync-protocol and hardware build green) |
| Tests | 2,252 passing, 0 failing: domain-core 782, ui 875, api 386, admin-web 54, contracts 53, testing 42, auth 23, db 18, payments-sdk 16, payments deployable 3 |
| Cross-tenant harness | all 244 OpenAPI operations covered, 0 failures |
| Builds | api, admin-web (clean at concurrency 4), payments, contracts, db, auth, ui, domain-core, promotions, orders |
| Lint | 3 errors at first (two `consistent-type-imports` in S-F6a files, one `no-constant-condition` in the price-engine golden generator); all fixed, root `pnpm lint` now clean |

Follow-up uncached run over the last two streams' packages (apps/pos, apps/worker, packages/hardware, packages/observability, packages/sync-protocol): 20/20 tasks green, 239 tests passing. Still not covered by any run here: Playwright suites for admin-web and ui (run by their streams), Tauri Rust compile and e2e (no cargo on this machine), Terraform apply, GitHub-hosted workflows, k6. Nothing is committed.
