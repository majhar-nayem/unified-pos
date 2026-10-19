# Stream S-F3: pricing engine, price lists and promotions

Slice F3 plus the price-list and promotion API, per [03 §5 F3 and §15](../03-implementation-plan.md). Written 2026-10-18. Everything is uncommitted in the shared working tree, as the shared-files protocol (§15.2) requires. Only packages of this stream were built, typechecked and tested; no repo-wide format, build or test was run.

## 1. Features completed

Status vocabulary: **implemented** (code exists), **tested** (automated tests pass), **simulated** (a stand-in replaces a real dependency), **planned** (not built).

| Feature                                                                                                                                                                                                                                                                                                        | Where                                                     | Status                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `priceOrder(draft, context)` as the `PricingPort`: price resolution (override → price lists → variant default), modifiers, manual line and order discounts with authorisation trace, promotions, largest-remainder allocation, tax, charges, cash rounding on the cash tender only, full ordered trace         | `packages/domain-core/src/price-engine/**`                | implemented, tested                                                                     |
| Promotion DSL v1: `percent_off`, `amount_off` (unit, line, order), `fixed_price` (per unit or bundle / meal deal), `bogo` (same pool or cross-item pool), `multibuy`, `threshold` (tiers), with priority, stack groups, exclusions, exclusive promotions, coupons, schedules, scopes, usage limits and budgets | `price-engine/promotions.ts`, `promotion-types.ts`        | implemented, tested                                                                     |
| Tax through a `TaxRuleResolver` interface declared in this package (inclusive/exclusive, exempt customers, several rates per line, compound rates)                                                                                                                                                             | `price-engine/tax-resolver.ts`, `tax.ts`                  | implemented, tested; the resolver behind it is **simulated** (see §6)                   |
| 308 golden cases (JSON in, totals out) including the brief's burger meal deal                                                                                                                                                                                                                                  | `packages/domain-core/golden/price-engine/`               | implemented, tested                                                                     |
| Property tests: line totals plus charges equal the order total; discounts never exceed the subtotal; allocations sum exactly; determinism; cash rounding bounds; inclusive/exclusive parity; exempt orders carry no tax                                                                                        | `price-engine/__tests__/properties.test.ts`               | implemented, tested                                                                     |
| Mutation testing (Stryker) of the engine                                                                                                                                                                                                                                                                       | `packages/domain-core/stryker.config.json`                | **88.87 %** on the engine (target 85 %), see §4                                         |
| Wire contracts: order draft, preview request, priced order, rules DSL schema, price list / entry / assignment / promotion / scope / coupon DTOs                                                                                                                                                                | `packages/contracts/src/price-engine.ts`, `promotions.ts` | implemented, tested                                                                     |
| Drizzle mirror of `pricing.price_lists`, `price_list_entries`, `price_list_assignments`, `promotions`, `promotion_scopes`, `coupons`                                                                                                                                                                           | `packages/db/src/schema/promotions.ts`                    | implemented, tested (schema diff-check green)                                           |
| API: CRUD with cursor pagination, `If-Match` version concurrency, scope checks, audit and outbox events for price lists, entries, assignments, promotions, scopes and coupons                                                                                                                                  | `apps/api/src/modules/promotions/**`                      | implemented, tested (Testcontainers, RLS role, cross-tenant harness)                    |
| `POST /v1/pricing/preview`: loads the price lists, promotions and coupons in scope for a location and runs the same `priceOrder` the POS runs                                                                                                                                                                  | `pricing-preview.service.ts`                              | implemented, tested; time zone and tax rules are supplied by the caller (**simulated**) |
| Redeeming coupons and counting promotion uses and spend                                                                                                                                                                                                                                                        | order slice (F4)                                          | planned; `uses_count` and `spent_minor` are read by the engine but never written here   |
| Real tax resolver, catalog snapshot and customer-group lookup behind the preview                                                                                                                                                                                                                               | Wave 2 integration                                        | planned                                                                                 |
| Admin console price-list and promotion editors                                                                                                                                                                                                                                                                 | S-F8                                                      | planned (the API and the preview endpoint are ready for it)                             |

## 2. Architectural decisions

No ADR was changed. Decisions taken inside this stream, for the integration lead to ratify:

1. **Namespaced export.** The Sprint 0 `pricing/` module in domain-core already exports `priceOrder`, `ChargeKind`, `TenderMethod`, `PricedCharge` and more. A flat `export *` would clash, so the engine is exported as `priceEngine` (`priceEngine.priceOrder`, `priceEngine.PricedOrder`, …). Wave 2 should delete the Sprint 0 `pricing/` module once F4 calls the new engine, and may then flatten the export.
2. **Price resolution order** (docs/01 §7.2 step 1). Override first. Then price lists whose assignments reach the sale, in two tiers: customer, customer-group and channel assignments first, then location, org-unit and tenant assignments. Inside a tier: assignment priority (lower wins), list priority, specificity (customer over group, nearer org unit over farther), then id. The first list holding a valid entry for the variant and reached tier quantity wins; within a list the highest reached `min_quantity` wins, then the latest `valid_from`. Then the variant default.
3. **Promotions apply sequentially** in `(priority asc, createdAt asc, id asc)` order, each seeing what earlier ones left on the lines. Same stack group: first wins. `excludesPromotionIds` works in both directions. An exclusive promotion applies alone and stops evaluation. Every skipped promotion is returned with a reason and appears in the trace.
4. **Unit-based effects work on whole units, most expensive first.** `bogo` and `multibuy` discount the cheapest units of a group; bundles allocate the discount over their units with largest remainder, so sums are exact.
5. **Tax.** Inclusive tax with several components is computed once from the combined multiplier and split by largest remainder, so net plus tax equals the amount exactly. Compound components apply on the base plus earlier components. `taxExemptMinor` means tax forgone for an exempt customer in both modes (removed from the price when inclusive, never added when exclusive).
6. **Cash rounding** applies to the cash portion of the tender only (the remainder after non-cash tenders, or the stated cash amount), using the currency rule or the tenant override in the context.
7. **Concurrency without version columns.** `price_list_entries`, `price_list_assignments` and `promotion_scopes` have no `version`. They are children of an aggregate: every write is conditioned on the parent's `If-Match` and bumps the parent's version, and responses carry `priceListVersion` / `promotionVersion`. `coupons` have no version either; updates are guarded by `status = 'active'` and `uses_count <= max_uses` inside the statement, and the only status change allowed is `void`.
8. **Scope checks.** A price list or promotion applies wherever its assignments or scopes point, so writing it needs `pricing.admin` at every one of those places. `org_unit` and `location` targets must exist in the tenant and be within the caller's reach. Tenant-wide targets (`tenant`, `channel`, `customer_group`, `customer`) and "no targets yet" need a tenant-level grant. Out of reach answers 404, as everywhere else.
9. **Promotion lifecycle.** `draft → scheduled|active|archived`, `scheduled → draft|active|paused|archived`, `active → paused|ended|archived`, `paused → active|ended|archived`, `ended → archived`. Anything else is 409. Only drafts can be deleted; price lists likewise.

## 3. Modules and files changed

Owned and created:

- `packages/domain-core/src/price-engine/**` (engine, 7 source files, `__tests__/` with 10 test files), `packages/domain-core/golden/price-engine/**` (308 `NNN-*.json` cases and `generate.mjs`)
- `packages/contracts/src/price-engine.ts`, `promotions.ts` and their two test files
- `packages/db/src/schema/promotions.ts`
- `apps/api/src/modules/promotions/**` (4 controllers, 5 services, rows, SQL helpers, fixtures, module, public index, unit and integration tests)
- `docs/releases/s-f3.md`

Outside the owned list (needed, minimal):

- `packages/domain-core/package.json`: devDependencies and a `mutation` script (§7).
- `packages/domain-core/stryker.config.json`: new, package-local mutation config limited to `src/price-engine`.
- `pnpm-lock.yaml`: one filtered `pnpm install --filter @pos/domain-core`; the diff is additive (82 packages added, 4 lines changed).

### Shared-file lines appended

| File                                | Line(s) appended                                                                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain-core/src/index.ts` | `export * as priceEngine from './price-engine/index.js';` (preceded by a one-line comment)                                                                                                                                                          |
| `packages/contracts/src/index.ts`   | `export * from './price-engine.js';` and `export * from './promotions.js';` (one per owned file)                                                                                                                                                    |
| `packages/db/src/schema/index.ts`   | `export * from './promotions.js';`                                                                                                                                                                                                                  |
| `apps/api/src/app.module.ts`        | `import { PromotionsModule } from './modules/promotions/public/index.js'; // F3 (S-F3)` and the entry `PromotionsModule, // F3 (S-F3)` at the end of the `imports` array (an import cannot work without its entry, so this is one logical addition) |

Nothing else shared was touched: no reordering, reformatting or removal; `roles.ts`, root `package.json` and `db/schema*.sql` untouched.

### Migrations

None. The tables already exist in `db/schema_part2.sql` (`pricing.*`). No schema defect blocked this stream; the version-column gaps in §6 are design observations, not blockers.

## 4. Tests executed (all run on 2026-10-18 with Docker)

| Check                                                     | Result                                                                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @pos/domain-core typecheck`, `build`       | green                                                                                                                                                                                                           |
| `pnpm --filter @pos/domain-core test`                     | 26 files, 782 tests green; the engine's share is 406: 311 golden (308 cases plus 3 meta checks), 7 property, 3 reviewed full-output snapshots, 85 unit                                                          |
| `pnpm --filter @pos/contracts typecheck`, `build`, `test` | green; 53 tests, 23 of them new                                                                                                                                                                                 |
| `pnpm --filter @pos/db typecheck`, `build`, `test`        | green; 18 tests                                                                                                                                                                                                 |
| Schema mirror (`packages/testing`, Testcontainers)        | `schema-mirror.integration.test.ts` green with the six new tables mirrored                                                                                                                                      |
| `pnpm --filter @pos/api typecheck`, `build`               | green                                                                                                                                                                                                           |
| API promotions module                                     | 32 tests green: 21 Testcontainers integration (postgres:16, `app_rw` role, real `AppModule`) and 11 unit; `openapi.boot.test.ts` green with the new operations                                                  |
| Cross-tenant harness over the pricing operations          | 27 operations × 2 scenarios = 54 cases green (foreign tenant 404, out-of-scope principal never sees forbidden ids), run from the module's own integration test                                                  |
| ESLint and Prettier on this stream's files                | clean (boundary rules included; one explained `eslint-disable` for the integration test importing the app-level test helper)                                                                                    |
| Stryker mutation test of `src/price-engine`               | **88.87 %** (1689 mutants: 1476 killed, 25 timed out, 172 survived, 16 not covered); per file: arith 95.0, schedule 96.8, tax-resolver 92.3, tax 91.8, price-resolution 90.5, promotions 87.4, price-order 87.4 |

Golden cases by theme (a case can carry several tags): brief and bundles 17, price resolution 32, lists and tiers 22, manual and order discounts 48, allocation 26, promotions by kind and conditions 61, stacking, exclusions, coupons, schedules, scopes and limits about 45, tax and mixed rates 56, inclusive/exclusive parity 40, cash rounding 43, charges and tenders 15, edge and error cases 17, re-pricing 3. Expected values are either hand-worked literals (the description of each case shows the arithmetic) or come from independent integer oracles in `generate.mjs` (half-up division, Hamilton allocation, the RBA 5c rule), never from the engine's own output. Regenerate with `node packages/domain-core/golden/price-engine/generate.mjs`. The runner supports partial `expected`, `$traceIncludes`, `$stepOrder` and `expectError`.

Re-pricing is checked two ways: pricing twice on a deep-frozen input gives identical output for every case, and the three `repricing` cases feed the resolved unit prices back as overrides and must reproduce totals, tax and rounding.

What the mutation survivors are: mostly the text of trace details and skip details, defensive guards whose mutation is equivalent, and iteration-order tie-breaks that cannot differ. The score covers the F3 engine only (7 files); the older Sprint 0 `money`, `pricing`, `tax` and `catalog` code in domain-core was not mutation-tested, so "≥ 85 % on domain-core" in the plan is met for the new engine, not yet for the whole package.

Not run: repo-wide `pnpm build`, `pnpm lint`, `pnpm test` (forbidden while other streams are active); the existing `apps/api/src/cross-tenant.integration.test.ts` (see §6, item 6); any load or performance test.

## 5. APIs introduced

All under `/v1`, tenant-level (`x-scope: tenant`) unless noted. Reads need `catalog.view`; writes need `pricing.admin` (see §6, item 3). Every `POST` that creates takes an `Idempotency-Key`. `If-Match` is the parent version.

| Operation                                                             | Route                                                         | Notes                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pricing.price_list.list` / `create` / `get`                          | `GET, POST /price-lists`, `GET /price-lists/:id`              | cursor pagination, filters `status`, `kind`                                              |
| `pricing.price_list.update` / `delete`                                | `PATCH, DELETE /price-lists/:id`                              | `If-Match`; delete only drafts                                                           |
| `pricing.price_list.entry.list` / `create` / `upsert_bulk`            | `GET, POST /price-lists/:id/entries`, `POST …/entries/bulk`   | `If-Match` on the list; bulk is up to 1000, upsert on (variant, min quantity, validFrom) |
| `pricing.price_list.entry.update` / `delete`                          | `PATCH, DELETE /price-lists/:id/entries/:entryId`             | `If-Match` on the list                                                                   |
| `pricing.price_list.assignment.list` / `create` / `update` / `delete` | `…/price-lists/:id/assignments[/:assignmentId]`               | `If-Match` on the list; scope-checked                                                    |
| `pricing.promotion.list` / `create` / `get` / `update` / `delete`     | `GET, POST /promotions`, `GET, PATCH, DELETE /promotions/:id` | filters `status`, `kind`, `activeAt`; create may carry scopes; status lifecycle enforced |
| `pricing.promotion.scope.list` / `create` / `delete`                  | `…/promotions/:id/scopes[/:scopeId]`                          | `If-Match` on the promotion                                                              |
| `pricing.promotion.coupon.create`                                     | `POST /promotions/:id/coupons`                                | code stored upper-case, unique per tenant                                                |
| `pricing.coupon.list` / `get` / `update`                              | `GET /coupons`, `GET, PATCH /coupons/:id`                     | filters `promotionId`, `status`, `code`; update = limits or `void`                       |
| `pricing.preview`                                                     | `POST /pricing/preview`                                       | dynamic scope: `locationId` in the body; needs `catalog.view` at that location           |

Every write appends an audit entry with before and after (`pricing.price_list.*`, `pricing.promotion.*`, `pricing.coupon.*`) and one outbox event of type `pricing.price_list.changed`, `pricing.promotion.changed` or `pricing.coupon.changed`, in the same transaction; a failed write leaves neither (tested).

### Promotion rules DSL v1 (`pricing.promotions.rules`)

```json
{
  "version": 1,
  "targets": {
    "variantIds": [],
    "itemIds": [],
    "categoryIds": [],
    "tags": [],
    "all": false,
    "exclude…": []
  },
  "conditions": {
    "channels": [],
    "customerGroupIds": [],
    "requiresCustomer": false,
    "minSubtotalMinor": "0",
    "minQuantity": "0",
    "allowWithManualDiscount": true,
    "excludesPromotionIds": []
  },
  "effect": {
    "kind": "percent_off | amount_off | fixed_price | bogo | multibuy | threshold",
    "…": "per kind"
  }
}
```

The zod schema (`PromotionRulesSchema`) is strict: unknown keys, percentages above 100, negative amounts and a kind that disagrees with the effect are rejected at the API with 422. The engine additionally skips (never throws on) a stored document it cannot evaluate and says why in `skippedPromotions`. Money in the DSL travels as integer strings.

## 6. Stubs, simulations and known limitations

1. **Tax resolver stub.** The engine consumes tax only through `TaxRuleResolver` (`price-engine/tax-resolver.ts`). The in-package stand-ins are `auGstResolver` (AU GST 10 %, inclusive; the rate is data in that file, not in the engine), `StaticTaxRuleResolver` (a table, used by the golden files and by the preview's optional `taxRules`) and `FixedTaxRuleResolver`. S-F2's real resolver is never imported. **Wave 2:** implement `TaxRuleResolver` over S-F2's rules and pass it as `context.taxResolver`.
2. **Preview inputs supplied by the caller.** The location's time zone (UTC when absent) and the tax table come from the request, because neither a location read nor a tax resolver is a public port yet. The catalog facts of each line (default price, tax class, categories, tags) and the customer's groups and tax-exempt flag also come from the draft; the server does not verify them. **Wave 2:** resolve them server-side from the catalog and customer modules.
3. **Permissions.** The catalog in `packages/auth` has no price-list or promotion keys, and it is not this stream's file. Reads and the preview use `catalog.view`, writes use `pricing.admin` (administrators and tenant owners; MFA-gated). The mapping lives in one file, `modules/promotions/permissions.ts`. Proposed keys for the lead to add: `pricing.price_list.view|manage`, `pricing.promotion.view|manage`, `pricing.coupon.manage`, `pricing.preview`, plus a store-manager grant for location-scoped promotions.
4. **Event names.** `pricing.price_list.changed`, `pricing.promotion.changed`, `pricing.coupon.changed` are declared as `PRICING_EVENTS` in `contracts/src/promotions.ts`. They must be added to `EVENT_CATALOG` (shared file) by the integration lead, as the payments stream did for its events.
5. **No version columns** on `price_list_entries`, `price_list_assignments`, `promotion_scopes` and `coupons` (§2, item 7). A `version` column on `coupons` would give strict `If-Match` there; it is optional, not blocking.
6. **The existing global cross-tenant test fails until fixtures are added.** `apps/api/src/cross-tenant.integration.test.ts` (the lead's file) now reports 94 missing-fixture problems, from this stream's routes and S-F2's catalog and tax routes. For this stream the lead needs to add the output of `createPricingFixture(db.admin, hierarchy)` (exported from `modules/promotions/public`) to `fixturesA`: `variantId`, `priceListId`, `draftPriceListId`, `priceListEntryId`, `priceListAssignmentId`, `promotionId`, `draftPromotionId`, `promotionScopeId`, `couponId`. `variantId` is also a name S-F2's routes use. The stream's own suite already runs the harness over the pricing operations with these fixtures and passes.
7. **Usage accounting.** `promotions.uses_count`, `spent_minor` and `coupons.uses_count` are enforced by the engine (limits, budget, coupon uses) but only the order slice may increment them. The API never writes them.
8. **Whole units only** for `bogo`, `multibuy` and bundles: a weighed quantity of 2.9 is two units. Percentage and amount effects work on any decimal quantity.
9. **Schedules** use the wall clock of the supplied zone through `Intl`; a nonexistent or repeated local time at a daylight-saving change is not treated specially.
10. **Sprint 0 `pricing/` module is untouched** and still exported flat from `@pos/domain-core`. Two engines coexist until F4 switches over.
11. `priceOrder` rejects a draft with a duplicate line id, a negative quantity, a missing price everywhere, a discount over 100 %, a charge with both or neither of amount and percent, and non-cash tenders above the total; the API maps these to 422.

## 7. Dependencies added

`packages/domain-core/package.json` devDependencies: `fast-check` 4.10.2 (already in the lockfile through `packages/testing`), `@stryker-mutator/core` 9.6.1, `@stryker-mutator/vitest-runner` 9.6.1, and the script `mutation` (`stryker run`). One filtered `pnpm install --filter @pos/domain-core` was run. Nothing else.

## 8. Security considerations

- Tenant isolation is by RLS plus explicit `tenant_id` predicates; the cross-tenant harness proves 404 across tenants for all 27 operations, and the preview test proves another tenant's price lists and promotions never reach a sale.
- A narrower administrator cannot change or reach wider than their grant: assigning, scoping, editing entries or issuing coupons for a tenant-wide list or promotion needs a tenant-level grant (tested with a location manager).
- Every price override and discount carries `authorizedBy`, `approvalId` and `method` through the engine into the trace and the response. The preview does not verify the authorisation (that is the order slice's job with the approvals module); it only reports it.
- The preview runs the engine in-process on caller input with bounded sizes (500 lines, 20 charges and discounts, 10 coupon codes, schemas are strict). Arithmetic is exact (bigint), never floating point.
- Coupon codes are stored upper-case and unique per tenant; they are not secrets in the sense of tokens, but listing coupons needs the view permission.

## 9. Deployment instructions

No new service, environment variable or migration. Register order is irrelevant: `PromotionsModule` imports `TenancyModule` only. To run mutation tests: `pnpm --filter @pos/domain-core mutation` (about one minute; `stryker.config.json` breaks the build below 85 %).

## 10. Remaining tasks and recommended next steps

1. Integration lead: add the fixtures (§6, item 6), the event names (item 4) and, if wanted, the fine-grained permission keys (item 3) to the shared files; ratify the namespaced export (§2, item 1).
2. Wave 2 integration: wire `TaxRuleResolver` to S-F2, `CatalogPort` to the preview (so lines need not carry catalog facts), customer groups and exemptions from the customer module; make F4's `priceOrder()` call the new engine and delete the Sprint 0 `pricing/` module.
3. F4 (orders): persist `PromotionApplication` records and the trace, increment `uses_count`, `spent_minor` and coupon redemptions in the order transaction, and call the engine with the `tenders` of the sale.
4. F8 (admin console): price-list grid on `entries/bulk`, promotion editor on `PromotionRulesSchema`, live preview on `pricing/preview`.
5. Optional: a `version` column on `coupons`; a nightly job that moves `scheduled` promotions to `active` and `active` ones past `valid_to` to `ended` (the engine already ignores out-of-window promotions, so this is housekeeping).
6. Mutation-test the older domain-core code (money, tax, catalog) if the plan's "≥ 85 % on domain-core" is meant package-wide.
