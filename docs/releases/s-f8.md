# Stream S-F8: Admin console v1, F1-entity part

Slice F8 of [03-implementation-plan.md §5](../03-implementation-plan.md), scoped by §15 to the F1 entities. Catalog, tax, price lists, promotions and receipt templates wait for Wave 2.
Everything lives under `apps/admin-web/**` and is uncommitted in the working tree.

Verified on 2026-10-18 against a real `apps/api` (Postgres 16 and Redis 7 from the compose file, migrations 0001 to 0003 applied):

| Check                                                 | Result                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @pos/admin-web typecheck` (and `tsc`)  | clean                                                                                                    |
| `pnpm --filter @pos/admin-web build`                  | green                                                                                                    |
| `pnpm --filter @pos/admin-web test` (Vitest, jsdom)   | 54 tests in 12 files, green                                                                              |
| `pnpm --filter @pos/admin-web test:e2e` (Playwright)  | 30 tests in 12 files, green, 3 workers, about 25 s                                                       |
| `eslint apps/admin-web` (root config, boundary rules) | clean                                                                                                    |
| axe-core (WCAG 2.0/2.1/2.2 A and AA tags)             | 0 violations on 12 pages in light and dark, on the login and invitation pages, and on 4 drawers or forms |

The root pipeline (`pnpm build`, `pnpm test`, `pnpm lint`) was not run, as §15.2 asks while other streams are active.

## Features and status

Legend: **Implemented** = built and typechecked. **Tested** = exercised by an automated test that asserts behaviour (not only an axe scan). **Simulated** = the UI is real but the effect is not. **Planned** = not built.

| Feature                                                                                                                                                                        | Implemented | Tested                                                           | Notes                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Login: tenant + email + password, then TOTP, enrolment when required, `next` redirect, logout                                                                                  | yes         | e2e                                                              | Tokens never reach page scripts (httpOnly cookies, asserted)                                                                     |
| Passkey as second factor (login) and passkey enrolment                                                                                                                         | yes         | e2e with a Chromium virtual authenticator                        | Needs `AUTH_WEBAUTHN_ORIGINS` to include the console origin                                                                      |
| Session refresh, tenant context, expiry                                                                                                                                        | yes         | unit (client 401 event)                                          | The proxy rotates the refresh token once on 401 and retries. Rotation itself is not asserted in e2e                              |
| Permission-gated navigation and page guard, from `@pos/auth` keys                                                                                                              | yes         | e2e + unit                                                       | Store manager sees the server-consistent subset; direct URL shows a "no access" notice; the same keys get 403 from the API       |
| Organisation tree: expand/collapse, create, edit, reparent                                                                                                                     | yes         | e2e (reparent, descendants excluded); create/edit by hand only   | Reparent sends `If-Match` and `Idempotency-Key`                                                                                  |
| Legal entities: list, create, edit                                                                                                                                             | yes         | e2e (create); edit not asserted                                  |                                                                                                                                  |
| Locations: list, create, edit, deployment profile, time zone (validated), business day boundary, business days list and open                                                   | yes         | e2e (create, validation, conflict, stale edit 412)               | Edit happy path and "open business day" are not asserted. Business day close is not built (planned)                              |
| Departments: list per location, create                                                                                                                                         | yes         | e2e (create)                                                     | API has no update or archive                                                                                                     |
| Registers: list, filter, create, edit                                                                                                                                          | yes         | e2e (create); edit not asserted                                  |                                                                                                                                  |
| Users: list, filters, invite (one-time link), create with password, profile edit, status                                                                                       | yes         | e2e (invite, accept, active); create and edit not asserted       | Invitation list is "users with status Invited"; email is not sent (see limitations)                                              |
| Credentials: list, admin password reset, per-location PIN, sign out everywhere                                                                                                 | yes         | e2e (reset, sign out); PIN not asserted                          | Self-service "My account": change password, replace TOTP, add passkey (e2e)                                                      |
| Roles: list, view permissions by module, create, clone, edit permissions and limits on custom roles                                                                            | yes         | e2e (clone, edit, save, system role read-only)                   |                                                                                                                                  |
| Role assignments: scope picker (tenant, org unit, location, register), limits editor with role default shown, expiry, reason, revoke with confirm                              | yes         | e2e (assign with limit, verify stored, revoke); units for editor | Effective limits are previewed with `mergeLimits` from `@pos/auth`                                                               |
| Approval requests queue: status tabs, detail, approve, reject                                                                                                                  | yes         | e2e (approve, reject, appears first on Home)                     | Uses the web session's MFA as the second factor. PIN or passkey factor on `factor` is not offered here                           |
| Devices: list, health, filters, enrolment code generation, revoke with reason                                                                                                  | yes         | e2e (code, enrol, revoke), unit (health rules)                   | Health uses `lastSeenAt` only                                                                                                    |
| Device wipe request                                                                                                                                                            | simulated   | e2e (audit reason recorded)                                      | No wipe endpoint exists. The checkbox prefixes `[wipe requested]` to the revoke reason in the audit log. The device is not wiped |
| Config editor: key and scope picker, resolution preview along the tenant to register path, version history, compare diff, rollback, schema validation                          | yes         | e2e (rollback, nearest wins, validation); unit (diff)            | Rollback saves the old value as a new version. Keys come from `CONFIG_KEYS` (5 scalar keys today)                                |
| Audit browser: filters, cursor paging, detail drawer with before/after diff and resource timeline, jump to latest, verify chain                                                | yes         | e2e (filter, diff, verify, paging forward and back)              | API lists oldest first (see limitations)                                                                                         |
| Home: "needs attention" (approvals, devices, invitations, onboarding locations), device summary                                                                                | yes         | e2e (approval appears first, links to queue)                     | Polls every 30 s                                                                                                                 |
| Home: sales tiles                                                                                                                                                              | placeholder | n/a                                                              | Shows "arrives with reporting (F9)"                                                                                              |
| Shared UX: data table (TanStack Table), filter bar and chips, saved views per user, density and column toggles, detail drawers, confirm-only-destructive, empty states, toasts | yes         | unit (11 table tests, cursor hook) + e2e                         | Saved views are in localStorage under `pos-admin:views:<tenant>:<user>:<table>`; storage failures are swallowed                  |
| Inline validation from zod contracts                                                                                                                                           | yes         | unit (7 form tests) + e2e                                        | The same schemas the API uses; zod defaults are rewritten to plain language; server 422 trees map onto fields                    |
| Accessibility: axe clean, skip link, drawer focus trap and focus return, arrow-key row navigation, status never colour only, reduced motion                                    | yes         | e2e axe + keyboard test                                          | Light and dark via `prefers-color-scheme`                                                                                        |
| API clients (create, revoke), business day close, org unit archive                                                                                                             | planned     |                                                                  | Endpoints exist; no screens yet                                                                                                  |

## What waits for Wave 2

- Catalog editor (items, variants, barcodes, modifiers, menus, availability), tax, price lists, promotions editor with engine-backed preview, receipt templates, CSV import with error report. These depend on S-F2 and S-F3 contracts and APIs that are still landing.
- Pairing a device to a register after enrolment. The API only binds a register when the enrolment code is issued (supported in the Devices screen). There is no endpoint to move an enrolled device.
- Swapping the app-local components for `@pos/ui` composites (DataTable, FilterBar, DetailDrawer, AuditTimeline, ConfigDiff) once S-UI publishes them.
- Sales tiles and drill-downs, after F9 reporting.
- Real remote wipe, after the POS shell can act on revocation.

## Architectural decisions

1. **Tokens stay server-side.** The browser holds httpOnly cookies set by Next route handlers (`app/api/session/*`). A same-origin proxy (`app/api/v1/[...path]`) attaches the access token, rotates the refresh token once on 401, and forwards `ETag`, `If-Match`, `Idempotency-Key` and `Idempotency-Replayed`. Page scripts never see a credential, and the API needs no CORS.
2. **UI permission checks reuse `@pos/auth`.** `usePermissions()` rebuilds a `Principal` from `GET /v1/auth/me` and calls `can()`. `has(key)` honours validity windows, so an expired assignment hides the control the way the server would refuse it. Navigation maps each page to the permission its list endpoint requires (`lib/nav.ts`, with a test that every key exists in the catalogue).
3. **Contracts drive validation.** Forms call `useZodForm(schema, initial, { toInput })`. `toInput` maps flat form state to the wire payload, so the schema that validates is the one the API enforces. The location form extends `TimezoneSchema` with an IANA check, which the contract does not do.
4. **Optimistic concurrency is visible.** PATCH and reparent send `If-Match` from the loaded `version`. A 412 shows "Someone else changed this record" without losing the user's edits (tested).
5. **Server-side cursor paging is a table contract, not an assumption.** `ResourceTable` takes either local rows or a `CursorPaging` object. `useCursorPages` keeps a cursor stack so Previous works against forward-only APIs. Only the audit log uses it today because it is the only paginated list (see limitations).
6. **No `@pos/ui` import.** S-UI changed the package root to export client-only modules, which broke the server layout. The console uses its own CSS variables (light default, dark by media query) in `app/globals.css`. Nothing here edits `packages/ui`.
7. **Components stay app-local** under `apps/admin-web/components`, as §15.1 requires.

## Modules and files

All under `apps/admin-web/` (over 11,000 lines including tests):

- `app/`: root layout and providers; `login/`, `accept-invite/`; `(shell)/` with the 12 console pages and `account/`; `api/session/*` and `api/v1/[...path]` route handlers.
- `components/`: `ui/` (Button, Field, Badge, Drawer, ConfirmDialog, EmptyState, Toast, Misc), `data-table/` (ResourceTable, FilterBar, `useCursorPages`), `forms/` (AssignmentsPanel, CredentialsPanel), `scope/ScopePicker`, `limits/LimitsEditor`, `audit/` (DiffView, AuditTimeline).
- `lib/`: API client, resource hooks, session and permissions, nav model, saved views, zod form hook and message rewriting, diff, device health, tree helpers, formatting; `lib/server/*` for the cookie and proxy code.
- `e2e/` (Playwright specs and a seed helper that provisions an isolated tenant per test through the real API, including TOTP enrolment), `test/` (Vitest setup), `vitest.config.ts`, `playwright.config.ts`, `.env.example`, `.gitignore`.
- `package.json` scripts: `test`, `test:unit`, `test:e2e` added.

## Shared files, dependencies, stubs

- **Shared-file lines appended:** none. No edits to `app.module.ts`, `contracts/src/index.ts`, `db/schema/index.ts`, `domain-core/src/index.ts`, `db/roles.ts` or the root `package.json`.
- **`pnpm-lock.yaml` (shared) changed** because dependencies were added to `apps/admin-web/package.json` (§15.2 rule 3), with `pnpm add` run a few times in sequence. Added runtime: `@pos/auth` (workspace), `@tanstack/react-table` 8.x, `@tanstack/react-query` 5.x, `zod` 4.6.7 (same pin as the other packages), `@simplewebauthn/browser`. Added dev: `vitest` 3.2.7, `@vitejs/plugin-react` 5.2.0, `@testing-library/{react,jest-dom,user-event}`, `jsdom`, `@playwright/test`, `@axe-core/playwright`, `otpauth` 9.5.2 (seed helper). TanStack Table v9 resolved first and was pinned back to v8 for stability. Playwright's Chromium (build 1248) was downloaded to the user cache.
- **Stubs left:** none in code. Simulated behaviour is limited to the wipe request above.
- **Defects found for the integration lead (no API files were changed):**
  - Operator ids in `AUTH_OPERATOR_TOKENS` must be UUIDs. A non-UUID id makes `POST /v1/tenants` return 404 (Postgres 22P02 mapped to NOT_FOUND), which is hard to diagnose. A startup check would help.
  - `PUT /v1/users/:id/password` and similar routes carry `idempotent: true` in their contract, but the interceptor only enforces keys on POST. Harmless; noted for the OpenAPI consumer.

## Migrations applied

None. This stream is front-end only. The test database had migrations 0001 to 0003 applied with `pnpm --filter @pos/db migrate` and the `grants` script.

## APIs consumed (none introduced)

`/v1/auth/{login,mfa/totp,mfa/passkey/options,mfa/passkey/verify,refresh,logout,me}`, `/v1/tenants/me`, `/v1/org-units` (+ reparent), `/v1/legal-entities`, `/v1/locations` (+ departments, registers, business-days), `/v1/registers`, `/v1/config` (+ history), `/v1/users` (+ invite, accept-invite, me/\*, credentials, password, pin, sessions), `/v1/roles` (+ clone, permissions, limits), `/v1/role-assignments`, `/v1/approvals` (+ approve, reject), `/v1/devices` (+ enrollment-codes, revoke), `/v1/audit` (+ head, verify).

## Tests executed

| Layer                       | Count          | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component and unit (Vitest) | 54 in 12 files | Table: render, client filters and chips, sort with `aria-sort`, local and cursor paging, server filter callback, empty and error states, saved views (save, apply, delete, storage failure), column toggle, arrow keys. Cursor hook: forward, back, reset. Form hook: blur validation, submit guard, 422 mapping, 412 message, `toInput`. Message rewriting, diff, API client, permissions and nav against `@pos/auth`, limits editor, confirm dialog, drawer focus trap, device health, org tree.                                                                                       |
| End to end (Playwright)     | 30 in 12 files | Login and enrolment, bad credentials, contract validation; create location (and duplicate code); assign role with limit then revoke; approve and reject; config rollback, resolution preview, schema validation; audit filter, diff, verify, paging; org reparent; legal entity, register, department create; invite and accept; password reset and sign-out-everywhere; device code, enrol, revoke; permission gating; passkey enrol and login; My account; roles clone and edit; stale-edit 412; proxy dot-segment refusal; axe on every page, both colour schemes, drawers; keyboard. |

Each e2e test provisions its own tenant, so tests are independent and parallel. Tests exposed real defects during development, all fixed: the list limit input swallowed commas while typing, the Roles link showed for roles that cannot list roles, and zod's default error text reached the screen.

## Known limitations

Mostly API gaps. The UI is built to use the right call once each exists.

1. **Lists are not paginated by the API.** Users, locations, org units, legal entities, registers, roles, devices and approvals (capped at 200) return whole arrays. Those tables filter, sort and page in the browser. Fine for pilot sizes; revisit before a tenant with thousands of rows. `useCursorPages` is ready to switch them over.
2. **Audit lists oldest first** and offers no descending order. "Jump to latest" uses `GET /audit/head` to start near the end, but Previous cannot walk back past that start because sequence numbers have gaps. An `order=desc` parameter would fix it.
3. **No invitation management:** no list, resend or cancel endpoint, and no email is sent. The invite link is shown once for the administrator to share.
4. **No per-credential revoke, passkey rename or removal.**
5. **No device wipe command**, no enrolment-code list or cancel, no move of an enrolled device to another register.
6. **Departments** have create and list only. **No delete** exists for any entity.
7. **Config editor handles scalar keys only** (string, number, boolean). Object and list values need a JSON editor when such keys appear in `CONFIG_KEYS`.
8. **Health is `lastSeenAt` only.** Printer, battery and sync backlog arrive with the POS shell.
9. **The e2e run sends no email, uses no SSO, and does not exercise the refresh-token rotation path in a browser.**
10. Behaviour not asserted by a test (see the status table): location edit success, business day open, org unit create and edit, legal entity edit, register edit, user create and profile edit, POS PIN. They are typechecked and covered by the axe scans where the page is listed.

## Security considerations

- Access and refresh tokens live only in httpOnly, SameSite=Lax cookies (Secure in production builds; `POS_COOKIE_SECURE=false` for plain http). A test asserts `document.cookie` does not expose them.
- The proxy forwards only whitelisted request and response headers, always sends to the configured `POS_API_URL`, and never reflects a caller-supplied host. Same-origin means no CORS configuration is needed on the API.
- State-changing proxy calls rely on SameSite=Lax cookies plus JSON bodies; there is no separate CSRF token. If the console is ever hosted on a sibling subdomain of another app, add an origin check in the proxy.
- The login redirect only accepts same-site relative paths (`next=/…`, not `//…`).
- Secrets entered in forms (passwords, PINs) are never logged or placed in URLs. Invitation tokens appear in the invite link by design; they are single use.
- UI permission checks are advisory. Every action is enforced again by the API, and tests confirm the two agree for a store manager.
- The device wipe checkbox is clearly labelled as recorded-only so nobody assumes data was erased.

## Deployment and running locally

Compose default ports were already taken on this machine by an unrelated project, so the verified run used a separate compose project on 55432 and 56379. On a clean machine the defaults work.

```bash
# 1. Infra and schema
pnpm dev:infra                                  # postgres, redis, minio
pnpm db:migrate && pnpm --filter @pos/db grants

# 2. API (the operator id must be a UUID)
export AUTH_OPERATOR_TOKENS="0a1b2c3d-0000-4000-8000-000000000f08:op_local_operator_token_0001"
export AUTH_WEBAUTHN_ORIGINS=http://localhost:3001,http://localhost:3101
DATABASE_URL=postgres://app_rw:app_rw@localhost:5432/pos REDIS_URL=redis://localhost:6379 \
  pnpm --filter @pos/api dev                    # listens on 3000

# 3. Console (dev on 3001; POS_API_URL defaults to http://localhost:3000)
pnpm --filter @pos/admin-web dev

# 4. First tenant (then open http://localhost:3001/login and use the invite flow)
curl -s -X POST localhost:3000/v1/tenants -H 'authorization: Bearer op_local_operator_token_0001' \
  -H 'content-type: application/json' -H 'idempotency-key: first-tenant-0001' \
  -d '{"slug":"acme","name":"Acme","admin":{"email":"owner@acme.test","displayName":"Acme Owner"}}'
# accept the invite at /accept-invite?token=<inviteToken>, then sign in; enrol TOTP when asked.
```

Tests:

```bash
pnpm --filter @pos/admin-web typecheck
pnpm --filter @pos/admin-web test                 # Vitest, no network
pnpm --filter @pos/admin-web build
E2E_API_URL=http://localhost:3000 E2E_OPERATOR_TOKEN=op_local_operator_token_0001 \
  pnpm --filter @pos/admin-web test:e2e           # needs the API above, serves a production build on 3101
```

First Playwright run on a new machine: `pnpm --filter @pos/admin-web exec playwright install chromium`.

Production notes: `output: 'standalone'` is set. Set `POS_API_URL` to the internal API address. Serve the console over https so cookies are Secure. WebAuthn needs `AUTH_WEBAUTHN_RP_ID` and `AUTH_WEBAUTHN_ORIGINS` on the API to match the console's public origin.

## Remaining tasks and next steps

1. Wave 2: catalog, tax, price-list, promotion and receipt-template screens on the S-F2 and S-F3 contracts; CSV import with a downloadable error report.
2. Ask the API owners for: paginated lists, `order=desc` on audit, invitation list/resend/cancel, device wipe and register reassignment, per-credential revoke.
3. Replace app-local primitives with `@pos/ui` composites when S-UI ships them (keep the `ResourceTable` API as the adapter).
4. Add e2e coverage for the untested edit paths listed in limitation 10, and a refresh-rotation test (lower the access token lifetime in a test API).
5. Screens for API clients and business day close.
6. Add `apps/admin-web` to CI: typecheck, Vitest, then Playwright against compose (the integration lead owns `.github/**`).
