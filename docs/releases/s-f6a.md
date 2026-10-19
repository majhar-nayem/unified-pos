# Stream S-F6a: POS shell, local store, hardware layer, sync protocol (slice F6, shell part)

Owner paths: `apps/pos/**`, `packages/hardware/**`, `packages/sync-protocol/**`, this file. Written 18 October 2026 on top of Sprint 0 and F1 ([sprint-0.md](sprint-0.md), [f1.md](f1.md)). Nothing is committed. Format: [03-implementation-plan.md §14](../03-implementation-plan.md), as asked by §15.2.

## Summary

The register shell runs: a device enrols with a one-time code, signs its sessions with a key pair, staff sign in with a PIN, and the two-pane terminal layout (plus tablet and handheld variants) works with a placeholder cart and product grid, global scanner capture, connectivity and unsynced badges, a customer display window and a diagnostics screen. Every command is written to a local command log before the UI changes. Checkout, pricing, tax, payments and receipts are **not** part of this stream (F6b, F3, F4, F5).

Verified in a browser build against both a mock of the F1 auth API and the real `apps/api` with docker compose infra. The **Tauri/Rust side was written but not compiled** (no Rust toolchain on the build machine), so the desktop build is untested.

## Status

| Area          | Item                                                                                                                                                                      | Status                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Shell         | Enrolment screen against `POST /v1/auth/device/enroll` (one-time `<slug>.<code>`)                                                                                         | implemented, tested (unit, e2e mock, e2e live)                                                        |
| Shell         | Device key pair: Ed25519, signing in Rust against the OS keychain                                                                                                         | implemented (Rust **uncompiled**); simulated WebCrypto key in browser builds, tested                  |
| Shell         | Device-bound session: challenge/sign/login, token cache, retry once on a rejected device token                                                                            | implemented, tested incl. live signature check                                                        |
| Shell         | PIN login with server lockout UI (423 countdown, keypad disabled), bad PIN, offline, revoked device, device-auth failure with re-enrol                                    | implemented, tested incl. live 423                                                                    |
| Shell         | Staff refresh: scheduled at 80 % of lifetime, offline keeps the session, reuse/revocation returns to PIN, restart resume (online and offline within 14 h)                 | implemented, tested incl. live rotation                                                               |
| Shell         | Register/location context in header (device name, location id prefix, cashier name from `GET /v1/users/me`)                                                               | implemented; location and register **names** need an API a device can read, see stubs                 |
| Shell         | Two-pane terminal (38 % cart), tablet landscape, tablet portrait (cart over grid, collapsible), handheld (single column, sticky pay row)                                  | implemented, tested (layout asserts, axe, touch targets at four viewports)                            |
| Shell         | Placeholder product grid, categories, search, cart lines, inline Remove, Void order (two taps), weighed lines from the scale                                              | implemented (placeholder pricing), tested                                                             |
| Shell         | Global scanner capture hook (keyboard wedge timing, swallows keys and the terminating Enter, native scanners share the handler, F2 focus)                                 | implemented, tested                                                                                   |
| Shell         | Connectivity indicator (probe `GET /v1/health` + browser events) and unsynced/rejected badge                                                                              | implemented, tested                                                                                   |
| Shell         | Customer display: second Tauri window (`?mode=cfd`), BroadcastChannel cart mirror, idle/welcome state                                                                     | implemented; window creation in Tauri **untested**, mirror tested in the browser (two pages)          |
| Shell         | Recovery UI: printer offline banner with Retry/Open diagnostics, offline banner, "Recovered" banner after restart                                                         | implemented, tested (restart recovery tested at store level)                                          |
| Store         | SQLite via `@tauri-apps/plugin-sql`: three table groups of docs/01 §8.1, migrations, WAL                                                                                  | implemented; schema and stores tested on `node:sqlite` with the same SQL, plugin adapter **untested** |
| Store         | Replica loader: `GET /v1/sync/feed` by cursor with idempotent apply; falls back to a documented stub on 404                                                               | implemented, tested (stub path live)                                                                  |
| Store         | Encrypted at rest                                                                                                                                                         | **simulated**: mode recorded in `store_meta` and shown on diagnostics; SQLCipher not wired            |
| Store         | Browser dev build store                                                                                                                                                   | in memory (data lost on reload) by design                                                             |
| sync-protocol | Command log: durable append before UI ack, batching, ack/reject, `init()` crash recovery, uploader with idempotent replay                                                 | implemented, tested (22 tests + SQLite crash recovery)                                                |
| sync-protocol | Feed cursors (never backwards), feed query                                                                                                                                | implemented, tested                                                                                   |
| hardware      | Interfaces and profiles for receipt/kitchen printer, drawer, HID scanner, serial/Bluetooth scale, customer display; manager with diagnostics snapshot (timeouts, latency) | implemented, tested                                                                                   |
| hardware      | Mocks for each peripheral                                                                                                                                                 | implemented, tested                                                                                   |
| hardware      | ESC/POS encoder and network printer driver (TCP 9100) incl. status bytes, drawer kick                                                                                     | implemented, tested over real loopback TCP against a mock printer server and byte-level snapshots     |
| hardware      | USB, serial, Bluetooth drivers; Star Line, ZPL                                                                                                                            | planned (profiles exist; need Tauri plugins after hardware spike R1)                                  |
| hardware      | TCP transport inside Tauri (Rust `tcp_*` commands)                                                                                                                        | implemented (Rust **uncompiled**), TS side tested against the command contract                        |
| POS           | Diagnostics screen: peripheral table, test print, drawer, simulate-offline (mock), store/encryption/key/replica/queue facts                                               | implemented, tested                                                                                   |
| Tests         | Playwright e2e enrolment → PIN → shell with scanner events, offline, printer, revoke, CFD                                                                                 | implemented, 36 passing                                                                               |
| Tests         | axe (WCAG 2.2 AA tags) and touch-target checks from design tokens on every shell screen at four viewports                                                                 | implemented, passing                                                                                  |
| Tests         | Tauri-driven e2e (`tauri-driver`)                                                                                                                                         | planned (needs a compiled app and native WebDriver)                                                   |

## Tests executed

| Command                                                                                                | Result                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @pos/sync-protocol test`                                                                | 22 passed (HLC 5, command log 14 incl. ordering/replay/crash, cursors 3)                                                                                                                         |
| `pnpm --filter @pos/hardware test`                                                                     | 28 passed (encoder 8, driver over TCP 8, peripherals, wedge, manager, profiles 12)                                                                                                               |
| `pnpm --filter @pos/pos test`                                                                          | 104 passed in 8 files: session 15, store 19, cart 13, hooks 22, screens 20, sync 5, staff 3, Tauri command contract 7                                                                            |
| `pnpm --filter @pos/pos test:e2e`                                                                      | 36 passed against the mock API, 1 skipped (live)                                                                                                                                                 |
| live e2e against `apps/api` (compose Postgres/Redis, isolated database `pos_f6a`)                      | 1 passed: real enrolment code (reuse refused 404), real PIN login, refresh rotation, signed device login verified by the server, cashier name from the server, 5 wrong PINs → 423 lockout screen |
| `tsc --noEmit` (`typecheck`) for the three packages, plus `@pos/kds` as a consumer of sync-protocol    | clean                                                                                                                                                                                            |
| `eslint` on the three owned directories, `prettier --check` on them                                    | clean                                                                                                                                                                                            |
| `pnpm --filter @pos/sync-protocol --filter @pos/hardware build`, `pnpm --filter @pos/pos build` (vite) | green                                                                                                                                                                                            |

Scan-to-line: asserted below 100 ms at the 95th percentile and maximum over 200 scans on both the in-memory and the SQLite store (it is a few milliseconds in practice). This is the store and cart path only, not UI paint time on a register.

Not run: root `pnpm build/test/lint` (forbidden while streams are active, §15.2), Rust `cargo check/test`.

## Stubs and placeholders (all marked in code)

| Stub                                                                                                                                                                                                                                                                                                                | Where                                                       | Replaced by                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Catalogue replica: the server has no change feed, so the loader applies a 10-product demo catalogue (`stub: true`, version 1) and the UI says "Demo catalogue". Payload mapping (`name`, `defaultPriceMinor`, `barcodes[].code`, `categoryId`, `soldBy`) is **assumed** and must be checked against the F2 contract | `src/catalog/placeholder.ts`, `src/store/replica-loader.ts` | `CatalogPort` / `VariantLookupDto` (S-F2), real `/v1/sync/feed` |
| Pricing: prices are variant list prices, totals show Subtotal = TOTAL, Discounts and Tax as "—"; the cart reducer is local, not the shared domain-core reducer                                                                                                                                                      | `src/cart/cart.ts`                                          | `PricingPort.priceOrder()` (S-F3), `OrderPort` (S-F4)           |
| Payments: CASH, CARD, Split, Other are disabled with an explanation; offline card label copy follows docs/04 §4.2                                                                                                                                                                                                   | `src/screens/Shell.tsx`                                     | F5/F6b checkout                                                 |
| Sync upload: `POST /v1/sync/batches` does not exist yet (404). Commands stay pending, the badge keeps counting and diagnostics says why. Response shape assumed to be `{ clientBatchId, outcomes[] }` per docs/01 §8.2                                                                                              | `src/app/sync.ts`                                           | M1 server sync (Wave 2)                                         |
| Location and register names: a device token cannot read `/v1/locations/:id`; the header shows the device name and a location id prefix ("Demo store" while on stub data)                                                                                                                                            | `src/screens/Shell.tsx`                                     | a device-scoped context endpoint, or the config replica         |
| Staff list for the PIN screen: devices cannot list users, so staff appear after their first sign-in (name from `GET /v1/users/me`) or are entered by id                                                                                                                                                             | `src/app/staff.ts`, `src/screens/PinScreen.tsx`             | staff replica from the feed                                     |
| Hardware in browser builds and when `VITE_MOCK_HARDWARE=1`: mock peripherals (stable 0.842 kg scale). In Tauri only network printers listed in kv `hardware.config` are created                                                                                                                                     | `src/hardware/setup.ts`                                     | register setup UI, USB/serial/Bluetooth drivers                 |
| Encryption at rest                                                                                                                                                                                                                                                                                                  | `src/store/schema.ts`                                       | SQLCipher (`bundled-sqlcipher`, `PRAGMA key` from the keychain) |

## Decisions

- Ports first: keychain, secrets, key-value config, SQL and TCP are interfaces in `src/platform`, `src/store/sql.ts` and `@pos/hardware`, so session, store and cart logic run under Vitest without Tauri. Simulated adapters are labelled as such on the diagnostics screen and the enrolment screen.
- The device private key never reaches JavaScript in Tauri: Rust generates it, keeps the seed in the OS keychain and signs `${nonce}.${deviceId}.${tenantId}` (the message the F1 server verifies).
- `@pos/hardware` main entry is browser-safe; the Node TCP transport and the mock printer server live at `@pos/hardware/node`.
- Command ids are UUIDs because `SyncCommandSchema` requires `uuid`, although docs/01 §8.1 writes ULID. HLC node id is the device id.
- Replica apply is idempotent (newer version wins) and runs before the cursor advances, so a crash between the two re-applies a page harmlessly. The Tauri SQL plugin has no multi-statement transaction across calls, so atomicity relies on this.
- Printer connection per job; unreachable printer returns `retryable: true` (nothing sent), failure mid-write returns `retryable: false` (may be partly printed).
- Scanner capture leaves text fields alone unless they carry `data-scan-target`, and disables itself on the PIN screen, so a scanner cannot type into a PIN or staff-id field.
- A device token the server rejects (401 other than the known auth codes) triggers one fresh challenge/sign/login and one retry; `DEVICE_REVOKED` wipes the identity and key and shows a notice.
- Viewport meta no longer has `user-scalable=no` (axe `meta-viewport`); `touch-action: manipulation` prevents double-tap zoom instead.
- App-local components (`src/ui`, screens) are used instead of `@pos/ui` components because the design system is still landing. Only `tokens`, `touch` and `breakpoints` are imported, in one file (`src/ui/tokens.ts`).

## Modules and files changed

- `packages/sync-protocol/src`: `commands.ts`, `command-log.ts`, `cursor.ts` (+ tests), `index.ts` exports. `hlc.ts` untouched.
- `packages/hardware/src`: `types.ts`, `escpos.ts`, `escpos-printer.ts`, `node.ts`, `mock-printer-server.ts`, `wedge.ts`, `mocks.ts`, `profiles.ts`, `manager.ts` (+ tests). The Sprint 0 `MemoryReceiptPrinter` is kept as an alias of `MockReceiptPrinter`.
- `apps/pos`: `src/**`, `e2e/**`, `scripts/seed-dev.mjs`, `index.html`, `vite.config.ts` (proxy `/v1`), `vitest.config.ts`, `playwright.config.ts`, `tsconfig.json`, `README.md`, `.gitignore`, `src-tauri/**` (Cargo.toml, `keychain.rs`, `tcp.rs`, `lib.rs`, capabilities, CSP).
- No migrations, no API changes, no OpenAPI diff.

## Dependencies added (§15.2 rule 3)

| Package                       | Added                                                                                                                                                                               | Why                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@pos/hardware`               | devDependencies `vitest 3.2.7`, `@types/node 22.20.5`                                                                                                                               | tests and the Node TCP transport (versions already in the lockfile)                                                                                                               |
| `@pos/pos`                    | `@pos/hardware`, `@pos/sync-protocol` (workspace), `@tauri-apps/plugin-sql 2.6.0`                                                                                                   | local SQLite via the Tauri SQL plugin (required by the task)                                                                                                                      |
| `@pos/pos`                    | devDependencies `vitest 3.2.7`, `jsdom 30.1.3`, `@testing-library/react 16.3.3`, `@testing-library/dom 10.4.2`, `@playwright/test 1.64.1`, `axe-core 4.14.0`, `@types/node 22.20.5` | hook/component tests, e2e, accessibility checks                                                                                                                                   |
| Rust (`src-tauri/Cargo.toml`) | `tauri-plugin-sql` (sqlite), `keyring 3`, `ed25519-dalek 2`, `rand 0.8`, `base64 0.22`                                                                                              | SQL plugin, keychain, device key. **Not resolved or compiled**: no `Cargo.lock` yet; `keyring 3` chosen over the newer 4.x because its API is the one the code is written against |

`pnpm install --filter` was run for each package; `pnpm-lock.yaml` changed accordingly (shared file, not hand-edited).

## Shared-file lines appended

None. `apps/api/src/app.module.ts`, `packages/contracts/src/index.ts`, `packages/db/src/schema/index.ts`, `packages/domain-core/src/index.ts`, `packages/db/src/roles.ts` and the root `package.json` were not touched.

## Defects and surprises for the integration lead

1. **F1 doc example is wrong**: `AUTH_OPERATOR_TOKENS="op-1:op_..."` boots, but provisioning then fails with a generic 404, because the operator id is written to `audit.audit_log.actor_id` (uuid). Use a UUID operator id. (Postgres log: `invalid input syntax for type uuid: "op-1"`; the error filter maps 22P02 to 404, which hides the cause.)
2. **`pnpm --filter @pos/api dev` (tsx) cannot run the API**: esbuild does not emit decorator metadata, so Nest reports undefined dependencies. The built output (`node dist/main.js`) works.
3. The shared compose database `pos` is only migrated to 0001; running the API against it fails on `identity.fn_seed_access_catalog`. I used an isolated database `pos_f6a` in the same Postgres container (migrated 0001 to 0003, grants applied) instead of migrating the shared one. It can be dropped with `DROP DATABASE pos_f6a`.
4. `GET /v1/sync/feed`, `/v1/sync/snapshot` and `POST /v1/sync/batches` do not exist; the POS handles the 404 (see stubs). Device principals only hold `devices.self, sync.upload, sync.download`, so a device-scoped "who am I / where am I" and staff list endpoint is needed before the PIN screen and header can show real names without a prior sign-in.
5. The API sends no CORS headers; the browser dev build proxies `/v1` through Vite. The Tauri webview calls the API from `tauri://localhost` and needs either CORS for that origin or a Rust-side HTTP client; the CSP already allows the connection.
6. PIN lockout is shared per user/location (`pin:<tenant>:<location>:<user>`): five wrong PINs from any register lock that cashier at the whole location for the configured window. The POS shows the server's `retryAfterSeconds`.
7. Playwright 1.64 expects a newer Chromium than the cached one, so e2e uses the system Chrome (`channel: 'chrome'`); set `PW_CHANNEL=chromium` after `playwright install` to use the bundled build.

## Security considerations

- Device private key: OS keychain, signing in Rust (not in webview). Browser dev build uses a non-extractable WebCrypto key in IndexedDB (simulated).
- Staff refresh token: OS keychain via `secret_*` commands in Tauri; localStorage in the dev build (simulated, plain text). The access token is held in memory only.
- The local database is **not encrypted** yet; the diagnostics screen says so. Replicas contain no PIN hashes or secrets in this slice.
- Scanner capture is disabled on credential screens. The test hook `window.__pos` exists only in the Vite dev build (`import.meta.env.DEV`).
- CSP `connect-src` allows `http:` and `https:` for the configured server address; tighten to the tenant's API origin when the server address becomes managed configuration.
- Enrolment, PIN and refresh failures use the server's codes; the UI never reveals which of user, PIN or device failed beyond "Wrong PIN".

## Known limitations

- **Rust not compiled**: `src-tauri` (SQL plugin registration, keychain and TCP commands, capabilities for the second window and SQL) is unverified. Expect a first-build round of fixes; run `cargo check` in `apps/pos/src-tauri` first.
- ESC/POS driver verified against a loopback mock and the Epson command reference, not a physical printer; status-byte handling and code page (WPC1252) need a real-device pass (hardware spike R1). The drawer kick uses pin 2 with 100 ms pulses.
- No USB, serial or Bluetooth transport; no scale driver beyond the mock; customer display hardware (VFD) is not supported, only the second-window CFD.
- Browser dev build loses the store on reload, so restart recovery ("Recovered" banner) is only proven at store level and in the Tauri build once it compiles.
- Receipt printing, email receipts, X report, suspend/resume, customer attach, discounts, price override approval UX and quantity edit are F6b scope and appear as disabled controls.
- CFD in Tauri prefers a second monitor and falls back to a movable window; the multi-monitor path is untested.
- Offline card limits, tip prompts and loyalty opt-in on the CFD (docs/04 §4.6) are not implemented; the CFD mirrors lines and total only.
- Touch targets are verified in Chrome at four viewports; physical touch hardware was not available.

## Deployment and running

See [apps/pos/README.md](../../apps/pos/README.md). Local run against the real API: start compose infra, migrate a database, `grants`, start `apps/api` from its build with a UUID operator id, run `pnpm --filter @pos/pos seed:dev` (prints the one-time code, cashier id and PIN), then `pnpm --filter @pos/pos dev` with `POS_API_URL` pointing at the API. Production packaging (`bundle.active`, icons, signing) is still off.

## Remaining tasks

1. `cargo check` and a first `tauri dev` run; fix what the Rust side needs (plugin permissions, keyring features per OS).
2. Replace stubs when ports land: catalogue replica and payload mapping (S-F2), pricing and orders (S-F3/S-F4), payments (S-F5); wire `PricingPort` into `CartService` and the shared reducers into the local projection.
3. Server sync endpoints (feed, snapshot, batches) and a device-scoped context/staff endpoint (Wave 2).
4. Checkout flow (F6b): tender, receipt print and reprint, X report, suspend/resume, customer attach, approval UX.
5. SQLCipher; USB/serial/Bluetooth drivers; hardware config UI; real-printer pass.
6. `tauri-driver` e2e once a compiled app exists; run the Playwright suite in CI (needs Chrome or `playwright install`).

## Recommended next steps

Run `cargo check` first (small, unblocks the desktop build), then agree the catalogue feed payload with S-F2 and the device-scoped endpoints with the identity owner, because those two decide how much of the stubbed shell survives unchanged.
