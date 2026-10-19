# Stream S-F5 — Phase 1 slice F5: payments core

Status after implementing [03-implementation-plan.md §5 F5](../03-implementation-plan.md) as stream S-F5 under
[§15](../03-implementation-plan.md) (ownership and shared-files protocol). Everything is uncommitted in the working tree.
Design sources: [01-system-architecture.md](../01-system-architecture.md) §7.3 (state machine), §7.4 (adapter interface and
terminal modes), §8.3 (offline payments and the forwarded-then-declined lifecycle), ADR-019 (Payments Edge).

Verified locally on 2026-10-18 with Docker running (only the packages this stream owns, plus `tsc`, as §15.2 requires):

| Check | Result |
|---|---|
| `pnpm --filter @pos/payments-sdk typecheck / test / build` | green, 16 tests |
| `pnpm --filter @pos/contracts typecheck / test` | green, 53 tests (the 7 existing files; payments contracts are exercised by the api scan test) |
| `pnpm --filter @pos/db typecheck / test` | green, 18 tests; the Drizzle mirror of all 12 payments tables is proven against a migrated Postgres in the payments suite |
| `tsc --noEmit` in `apps/api` | no errors (mid-session an error appeared in S-F3's `modules/promotions/shared/sql.ts`, `pg` not declared for `@pos/api`; it was gone by the final run and was never ours) |
| `vitest run src/modules/payments` in `apps/api` | 6 files, **203 tests** green: state machine 110, cash 15, PCI scan 11, config/secrets 5, core integration 40, edge integration 22 |
| `pnpm --filter @pos/payments typecheck / build / test` | green, 3 integration tests (3 consecutive runs) |
| `eslint` over every file this stream owns | clean, boundary rules included |

Not run, on purpose (§15.2): repo-wide `pnpm build`, `pnpm test`, `pnpm format`. The integration lead's `cross-tenant.integration.test.ts` currently fails its completeness step because of **other streams'** unknown fixture names (catalog, orders, pricing); there is not one `payments.*` entry among its problems.

## Features and status

Legend: **implemented** = code in the tree; **tested** = covered by the suites above; **simulated** = answers from a local simulation, not a real provider; **planned** = not in this stream.

| Feature | Status |
|---|---|
| `PaymentProviderAdapter` / `TerminalAdapter` exactly as §7.4, with the amended `Capabilities` (`offlineModes` per connection mode, `offlineExcludedSchemes`, `leastCostRouting`, `certificationStatus`) | implemented, tested |
| Deterministic mock provider, scriptable: approve, decline, timeout, timeout-after-submit, uncertain-then-approved, uncertain-then-declined; signed webhooks; settlement files; per-key idempotency | implemented, tested, simulated |
| Mock terminal (pair by code, progress events, cancel, `lastTransactionResult`, offline approval when allowed and capable) | implemented, tested, simulated |
| Stripe adapter behind the interface (PaymentIntents, refunds, cancel, `getStatus`, `Stripe-Signature` verification, payouts and balance transactions for settlement); test key from `STRIPE_SECRET_KEY` only, `sk_live_…` refused at boot | implemented; **simulated** (no key in CI, so it answers through the internal mock and reports `simulated: true`). Request shapes are unit-tested with a stubbed `fetch`; **nothing has run against the Stripe sandbox** |
| Provider accounts (`credentials_ref` only, validated to look like a reference, never a secret), terminals (pair, status, register), capabilities stored from the adapter | implemented, tested |
| Payment intents with the §7.3 state machine: created, processing, authorized, captured, partially_refunded, refunded, reversed, failed, cancelled, uncertain; exhaustive 10x10 transition test | implemented, tested |
| Attempts with redacted request/response; append-only `payment_events` (DB trigger plus no code path that updates); `payment_intents.status` as projection | implemented, tested |
| `card_payment_details`: masked, scheme-permitted fields only; a unit test fails if any column, contract field or SDK type name matches PAN/CVV/track/expiry patterns; Luhn-aware masking of card-like numbers in everything stored | implemented, tested |
| Capture (tip adjust), cancel/release, same-batch reverse | implemented, tested |
| Refunds (partial/full, over-refund guard, idempotent per client key, cash refunds, `orders.refund.create` with the `orders.refund.max_minor` limit so a breach becomes `LIMIT_EXCEEDED` for the approvals flow) | implemented, tested |
| Webhook inbox: signature over the raw body, replay protection on `(provider, event id)`, idempotent processing in a savepoint, forged signatures stored (metadata only), logged and refused, failed deliveries retried | implemented, tested |
| Uncertain handling: `getStatus` (or the provider's idempotent replay under the same key when no reference was ever seen) before any retry; stuck-`processing` sweeper; `uncertain_aged` escalation; resolves within 60 s in the mock | implemented, tested |
| Crash recovery for submit, capture/cancel/reverse and refund (prepare, call outside the transaction, settle) | implemented, tested |
| Settlement import (idempotent) from the mock and Stripe skeleton; `settlements`, `settlement_lines`, matching, `settlement_status`; reconciliation exceptions `amount_mismatch`, `missing_in_settlement`, `missing_in_platform`, `duplicate_capture_suspected`; resolve queue | implemented, tested (mock); Stripe path **simulated** |
| Offline store-and-forward lifecycle: `offline`, `offline_collected_at`, `offline_expires_at`, `forwarded_at`, `forward_outcome` (pending, approved, declined, expired, rescue_in_progress); decline/expiry fail the intent, reopen the check, raise `offline_declined` / `offline_expired`; expiry sweeper; post-hoc cap detection `offline_cap_exceeded` | implemented, tested |
| Cash tender with change and AUD 5c rounding recorded on the intent's `captured` event and on the order and check through `OrderPort` | implemented, tested |
| Outbox events `payment.authorized`, `payment.captured`, `payment.failed`, `refund.succeeded` (same transaction as the state change) | implemented, tested |
| `PaymentsPort` (`payCash`, `createIntent`, `submitIntent`, `refund`, `getIntent`, `checkSummary`) provided via `PAYMENTS_PORT` | implemented, exercised through the services it wraps |
| `apps/payments`: separate deployable reusing the same module, webhook intake, sweepers, own secrets, rawBody enabled | implemented, tested |
| Gift card tender (ledger), store credit and gift card refunds, loyalty tender, `deposit_applied`, `external` tender | **planned** (answer `METHOD_NOT_SUPPORTED`); the plan lists gift-card tender under F5 |
| First real provider certified against its sandbox, nightly contract tests | **planned** (Stripe skeleton is the starting point) |
| Payments Edge (LAN terminal adapters running in Tauri/Store Hub), real terminal drivers | **planned** (ADR-019, Wave 2 spike); this slice defines the interfaces and the server-side lifecycle they report into |
| Expected-fee rule behind `fee_mismatch` | **planned** (the kind exists in the schema; no rule produces it yet) |
| Surcharging rules, least-cost routing selection, tip adjust after capture, cashback | **planned** (columns and capability flags exist) |

## Architectural decisions

- **Prepare, call, settle.** A provider is never called inside a database transaction. Transaction 1 moves the intent to `processing` and writes an attempt with a stable provider idempotency key (`<intentId>:sale`, `:auth`, `:capture`, `:reverse`, refund `<refundId>:refund`); the provider is called; transaction 2 applies the result. A crash between them leaves `processing` + a `started` attempt, which the sweeper resolves. Settling accepts `processing` and `uncertain`, so a certain late answer still lands.
- **Uncertain is resolved by asking, never by retrying blind.** With a provider reference: `getStatus`. With none (timeout before we saw an answer): the provider's own idempotent replay of the original request under the *same* key, which returns the original outcome and cannot charge twice. A new intent with a new key only ever follows `failed`. A key is renewed for capture/reverse only after a *certain* decline, because providers replay a cached decline for the same key.
- **State machine extensions (both documented in `domain/state-machine.ts`).** `uncertain → authorized` (a pre-auth confirmed by the query). `captured → failed`, only behind the `offlineForwardFailed` guard: §8.3 records an offline sale as captured so the order can complete, and the issuer may still decline it. A refund that leaves the intent partially refunded is an event, not a transition.
- **"Paid only when captured."** Payments computes `Σ captured − refunded` from its own intents and hands the aggregates to `OrderPort`; the order side only stores them. Authorized and processing money never counts.
- **Webhook tenancy without a bypass role.** The schema's RLS blocks `webhook_inbox` rows with no tenant, and the comment says infra would add a bypass role. Instead the route carries `tenantId` and `accountId`: the path only selects the RLS context and the signing secret; authenticity is the signature over the raw body with that account's secret. A forged delivery is stored with `external_event_id = invalid:<uuid>` (never the claimed id, so it cannot burn a real one), as metadata and a body hash only (never the unverified body).
- **Sweepers iterate tenants** (`platform.tenants` is the only table the app role reads across tenants) and run per-tenant under RLS. Time comparisons use a supplied `now`, so tests fast-forward without sleeping.
- **Redaction twice.** `redactForStorage` (field names, secrets, Luhn-valid 13-19 digit runs) runs before every attempt and event write; the name patterns are shared with the scan test.
- **Offline is recorded, never rejected.** If a terminal approved offline the money has moved; an out-of-policy sale (cap, connection mode) is recorded and raises `offline_cap_exceeded`.
- Related: [ADR-019](../01-system-architecture.md) Payments Edge, risks R7 (PCI scope) and R11 (offline card).

## Modules and files changed

Owned and created:

- `packages/payments-sdk/src/`: `adapter.ts` (interfaces; extended, not rewritten), `mock-provider.ts` (scripting, webhooks, settlement), `mock-terminal.ts`, `stripe-provider.ts`, `redaction.ts`, `webhook-signature.ts`, tests; `tsconfig.build.json` now includes Node types (HMAC, Buffer).
- `packages/contracts/src/payments.ts`: DTOs, enums mirroring the CHECK constraints, `PAYMENT_PERMISSIONS`, `PAYMENT_EVENTS`.
- `packages/db/src/schema/payments.ts`: mirror of the 12 `payments.*` tables (`currencies` uses a `bpchar[]` custom type because `information_schema` reports `char(3)[]` that way).
- `apps/api/src/modules/payments/`: `domain/` (state machine, cash maths), `ledger.service.ts` (only writer of status, attempts, events), `intents.service.ts`, `execution.service.ts`, `refunds.service.ts`, `webhooks.service.ts`, `sweepers.service.ts`, `settlement.service.ts`, `provider-accounts.service.ts`, `terminals.service.ts`, `ports/` (`OrderPort` + SQL stub, secrets), `providers/provider-registry.ts`, `http/` (4 controllers), `payments.port.ts` (`PaymentsPort`), `public/index.ts`, tests and `testing/` helpers.
- `apps/payments/`: `package.json`, tsconfigs, `src/main.ts`, `src/payments-app.module.ts`, integration test.
- `docs/releases/s-f5.md` (this file).

### Shared-file lines appended (§15.2)

| File | Line appended |
|---|---|
| `packages/contracts/src/index.ts` | `export * from './payments.js';` |
| `packages/db/src/schema/index.ts` | `export * from './payments.js';` |
| `apps/api/src/app.module.ts` | `import { PaymentsModule } from './modules/payments/public/index.js'; // F5 (S-F5)` and the entry `PaymentsModule, // F5 (S-F5)` in `imports` (the same two-line convention S-F2 and S-F3 used) |

### Dependencies added (§15.2 rule 3, recorded)

- `apps/api/package.json` (not an owned file, but the payments module lives in `apps/api`): `"@pos/payments-sdk": "workspace:*"`. `pnpm install --offline` run once; `pnpm-lock.yaml` gained the workspace link.
- New package `apps/payments` (`@pos/payments`), depending on workspace packages and the versions already pinned by `apps/api`; it imports the payments module through `@pos/api/dist/modules/<module>/public/index.js` (the api package has no `exports` map, so deep imports resolve; the open layout decision from Sprint 0 note 5 is unchanged and the cleaner fix is a `packages/modules` extraction by the lead).

## Stubs left

| Stub | Where | Replaced by |
|---|---|---|
| `OrderPort` stub `SqlOrderPortStub`: reads `orders.orders/checks` directly, writes `paid_minor`, `refunded_minor`, `payment_status`, `settlement_pending`, cash `rounding_minor` and `total_minor`, `metadata.cashTenders`, and reopens a completed order with an `orders.order_events` row `reopened_offline_decline` | `ports/order.port.ts` | S-F4's real `OrderPort` in the Wave 2 integration slice (bind to the `ORDER_PORT` token) |
| `EnvPaymentSecrets` (webhook secrets from `PAYMENTS_WEBHOOK_SECRET__<REF>`, `STRIPE_WEBHOOK_SECRET`; a built-in mock secret outside production) | `ports/secrets.port.ts` | Secrets Manager resolver |
| Stripe adapter simulated without a key | `packages/payments-sdk/src/stripe-provider.ts` | first real provider, sandbox-tested |
| Mock terminal adapter (`MockTerminalAdapter`) is the only terminal driver | `packages/payments-sdk/src/mock-terminal.ts` | Payments Edge drivers (Adyen/Tyro LAN, Stripe SDK) |
| `EXECUTION_FAULTS` / `REFUND_FAULTS` tokens (empty objects in production) | `execution.service.ts`, `refunds.service.ts` | kept: the crash-simulation seam the tests use |

## Migrations applied

None. `db/schema*.sql` and `packages/db/migrations` were not touched (§15.2 rule 4). Defects and gaps worked around, for the integration lead:

1. **`payments.webhook_inbox` RLS vs tenant-less intake**: worked around with tenant and account in the webhook URL (above). A `payments_intake` role is not needed.
2. **No columns for cash tender detail** on `payment_intents` (tendered, change, rounding): recorded in the `captured` event payload and in `orders.metadata.cashTenders`. Suggest `tendered_minor`, `change_minor`, `rounding_minor` columns.
3. **No cross-tenant claim function for sweepers**: the sweeper loops over active tenants. Suggest `SECURITY DEFINER` claim functions like the outbox relay's for large tenant counts.
4. **`payment_events.occurred_at`** is "when it happened": an offline approval predates its record, so order by `recorded_at, id` for the record order.
5. **No `payments.*` permission keys** in the `@pos/auth` catalog (not our package): see Security. **No `refund.succeeded`** in `EVENT_CATALOG` (`uow.emit` accepts any string, so it works; add it for consumers).

## APIs introduced (OpenAPI diff, 30 operations, all under `/v1/payments`)

| Area | Operations |
|---|---|
| Provider accounts | `POST /provider-accounts`, `GET /provider-accounts`, `GET|PATCH /provider-accounts/:accountId` |
| Terminals | `POST /terminals`, `GET /terminals`, `GET|PATCH /terminals/:terminalId`, `POST /terminals/:terminalId/pair` |
| Intents | `POST /intents`, `GET /intents`, `GET /intents/:intentId`, `GET /intents/:intentId/events`, `GET /intents/:intentId/attempts`, `POST /intents/:intentId/submit`, `…/capture`, `…/cancel`, `…/reverse`, `…/forward-outcome` |
| Refunds | `POST /intents/:intentId/refunds`, `GET /intents/:intentId/refunds` |
| Cash and offline | `POST /cash-tenders`, `POST /offline-collections` |
| Webhooks | `POST /webhooks/:provider/:tenantId/:accountId` (public, signature), `GET /webhook-inbox` |
| Settlement | `POST /settlements/import`, `GET /settlements`, `GET /settlements/:settlementId` |
| Exceptions | `GET /reconciliation-exceptions`, `POST /reconciliation-exceptions/:exceptionId/resolve` |

Money is an integer string in minor units. Clients send `clientIntentId` / `clientRefundId` (8-128 URL-safe chars); the stored key is `(device or subject):<client id>`. The optional `Idempotency-Key` header is also honoured by the kernel interceptor.

For the shared cross-tenant harness, path-parameter examples reuse the fixture name `deviceId` and body examples use `$fixture:locationId` plus literal UUIDs, so the harness needs no new fixture names. The payments suite runs the same harness over these routes with real resources (five passes: intent, account, terminal, settlement, exception families), every non-public operation twice (foreign tenant, out-of-scope location), all 404.

## Tests executed

| Level | What |
|---|---|
| Unit | State machine: all 100 ordered pairs plus the guarded edge, terminal states, refund arithmetic, paid rule (110). Cash tender: the RBA table for all ten last digits, rounding down, partial tender, no-rule currencies, 3-4995 property (15). PCI scan: Drizzle mirror, canonical SQL, contract JSON Schemas, SDK types, matcher itself (11). SDK: mock scripting, timeout-after-submit, webhook signing and verification, settlement lines, redaction, Stripe skeleton, terminal (16). Config and secrets (5) |
| Integration (Testcontainers postgres:16, `app_rw` role, RLS forced) | 62 tests in two suites plus 3 for the deployable |
| Brief invariants | **No acknowledged payment lost across a simulated crash**: crash after the provider approved, before recording; too early the sweeper leaves it alone, then it completes with exactly one provider charge and one outbox event; same for timeout-after-submit (no reference known) and for a timeout the provider never saw. **No duplicate charge from an internal retry**: five concurrent submits reach the provider once; same-key replays; a submit racing the sweeper; refunds and captures replayed under the same key. **Paid only when captured**: authorized and processing money leaves the order unpaid (asserted from inside the crash window). |
| Webhooks | valid → processed; replay and 6 concurrent deliveries → one effect; forged, tampered, missing, stale, malformed → 401 with evidence stored and an audit row; unknown account, wrong provider, foreign tenant → 404 and nothing stored; unknown payment → ignored; contradictions and unrecorded refunds → exceptions; failed processing retried |
| Uncertain | getStatus confirms; provider declined; **resolves within 60 s in the mock** (sweep every 10 s of virtual time with the provider unknown for the first two queries: resolved at 30 s, bounded by 60 s); escalation after 15 min raises `uncertain_aged` once |
| Offline | record; forward approved/declined/rescue; decline reopens the check, writes the order event, raises the exception; expiry sweeper (including rescue extension); caps and connection-mode detection; terminal approves offline only when allowed and capable; no refund before forward |
| Settlement | match, totals, idempotent re-import, four exception kinds, resolve queue, tenant scope |
| Data integrity | `payment_events` append-only, redaction of stored attempts and events, DB CHECK constraints, Drizzle mirror vs `information_schema` |
| Isolation | foreign tenant and out-of-scope manager get 404 on every intent route; lists never leak; per-account webhook secrets; the cross-tenant harness over all payments routes |
| Not run | Chaos at network level, load/k6, provider sandbox contract tests (nightly, planned), Playwright |

## Known limitations

- **Provider limits.** Stripe is a skeleton: unverified against the sandbox, `getStatus` maps only the main PaymentIntent states, settlement uses payouts and balance transactions without fee reconciliation, no 3-D Secure or redirects. Stripe offline needs the native SDK; the JS SDK and server-driven mode cannot (modelled in `offlineModes`).
- **Hardware limits.** No real terminal driver exists. LAN/SDK adapters belong to the Payments Edge; this slice receives their results (`offline-collections`, `forward-outcome`) but the Edge's cap enforcement from `devices.health` counters is not built. Cap detection here is post-hoc.
- **Provider references.** A provider that offers no idempotent replay and no lookup by reference would leave a ref-less `uncertain` payment unresolvable; the sweeper then raises `uncertain_aged` for manual handling.
- **Terminal recovery** accepts `lastTransactionResult` only when its amount equals the charge; two identical amounts in quick succession could be confused. Needs the terminal's own transaction id from the Edge.
- `missing_in_settlement` treats a capture inside the import window as due in that batch; a provider that settles late will raise it spuriously. `fee_mismatch` is not produced.
- Authorized intents are not swept for provider-side expiry; a crashed capture/cancel/reverse is recovered (open attempt older than the threshold), an abandoned authorization is not.
- Cash refunds record the intent change only; the cash drawer movement belongs to the cash module.
- The webhook route needs the raw body: the app must be created with `rawBody: true` (done in `apps/payments` and the test apps). **`apps/api/src/main.ts` and `testing/test-app.ts` are not ours and do not set it**: the webhook route inside the API process answers 500 until they do. Webhooks should point at the payments deployable.
- The sweeper's `getStatus` for refunds replays the refund instead of querying, which is safe but depends on provider idempotency.

## Security considerations

- **No PAN, CVV, track data or expiry** anywhere: not in columns (scan test over the mirror and the SQL), contracts, SDK types, logs (the logger already redacts `pan`/`cvv`), attempts, events or webhook payloads (redacted on the way in; a Luhn-valid run in free text is masked to its last four).
- **Webhook signatures** are verified over the raw bytes with HMAC-SHA256 and a 5 minute tolerance, constant-time comparison; per-account secrets resolved from the process environment by reference; a forged delivery cannot claim a real event id.
- **Secrets**: `credentials_ref` must look like a reference; the API never accepts a secret field (unknown fields are stripped and a test proves they are not stored); the Stripe adapter reads only `sk_test_` keys from the environment and refuses `sk_live_`.
- **Authorization**: every service call checks permission at the intent's location (404 when out of scope, 403 when permitted nowhere). Refunds use `orders.refund.create` with the amount against `orders.refund.max_minor`. **Permission keys to add to `@pos/auth`** (the catalog and system roles are not ours): `payments.view`, `payments.intent.create` (cashier: take payments), `payments.intent.manage` (capture, cancel, reverse: supervisor), `payments.provider.manage`, `payments.terminal.manage`, `payments.settlement.manage`, `payments.reconcile.manage` (finance). Until then only principals constructed with these keys (tests) pass the checks; no system role holds them.
- **Failure-path writes survive the error** (the F1 lesson): declined captures, timeouts and rejected webhooks commit their records before the error is raised.
- The `payments` deployable has no identity module, so no login surface and authenticated routes fail closed; it needs `DATABASE_URL`, `REDIS_URL` (public rate limiting) and its own provider secrets.

## Deployment instructions

```bash
pnpm install && pnpm --filter @pos/api build && pnpm --filter @pos/payments build
DATABASE_URL=… REDIS_URL=… \
PAYMENTS_WEBHOOK_SECRET__STRIPE_MAIN_AU=whsec_… STRIPE_SECRET_KEY=sk_test_… \
node apps/payments/dist/main.js        # PORT=3100, sweepers on
```

Point each provider's webhook at `https://<payments-host>/v1/payments/webhooks/<provider>/<tenantId>/<providerAccountId>`.

| Variable | Meaning | Default |
|---|---|---|
| `PAYMENTS_SWEEPERS_ENABLED` | run the sweepers in this process (on in `apps/payments`; set on exactly one process) | `false` in the API |
| `PAYMENTS_STUCK_AFTER_MS` | a `processing` intent older than this is treated as a crashed submit | 30000 |
| `PAYMENTS_SWEEP_INTERVAL_MS` | sweep period; uncertain intents resolve within one period plus a provider round trip | 10000 |
| `PAYMENTS_UNCERTAIN_ESCALATE_AFTER_MS` | raise `uncertain_aged` | 900000 |
| `PAYMENTS_OFFLINE_WINDOW_HOURS` | offline window when the account sets none | 24 |
| `PAYMENTS_WEBHOOK_SECRET__<REF>` | webhook secret for `credentials_ref` (non-alphanumerics become `_`, upper case) | none |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe test credentials; without a key the adapter is simulated | none |
| `PORT` | listen port of `apps/payments` | 3100 |

The API process also mounts the payments routes (authenticated). Accounts are created per tenant with `POST /v1/payments/provider-accounts`; offline behaviour comes from the account `settings.offline` (`enabled`, `windowHours`, `maxTransactionMinor`, `maxCountPerDevice`, `maxSumPerDeviceMinor`).

## Remaining tasks

1. Integration lead: add the seven permission keys and `refund.succeeded` to the shared catalogs; set `rawBody: true` where the API should receive webhooks; extend the cross-tenant fixture registry for the other streams (not payments).
2. Replace the `OrderPort` stub with S-F4's implementation; decide the cash-tender columns and the sweeper claim function (migrations).
3. Gift card tender (ledger), store credit and gift card refunds, loyalty tender.
4. First real provider: Stripe sandbox run, nightly contract tests, fee reconciliation, 3-D Secure.
5. Payments Edge: LAN/SDK terminal drivers, offline queue counters, cap enforcement, terminal transaction ids.
6. `fee_mismatch` rule, authorization expiry sweep, tip adjust after capture, surcharge and least-cost routing.
7. Threat model entry for webhook intake and the deployable (docs/security is S-DOCS).

## Recommended next steps

- Run the full pipeline once the permission keys and fixtures land; the payments suites are self-contained and need no change.
- Do the Wave 2 wiring in this order: `OrderPort`, POS checkout screens against `cash-tenders` and `intents/submit`, then the Edge spike against `offline-collections` and `forward-outcome`.
- Pick the first real provider from the R3 matrix; Stripe's adapter already compiles against the interface, so the work is sandbox verification rather than design.
