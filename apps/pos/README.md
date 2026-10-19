# @pos/pos: register app (Tauri 2 + React)

Slice F6, shell part (stream S-F6a). Release notes with status, stubs and known limits: [docs/releases/s-f6a.md](../../docs/releases/s-f6a.md).

## Run it

Browser development build against the mock API (no Docker, no Rust):

```bash
pnpm --filter @pos/pos dev:mock-api        # fake F1 auth API on :3100 (node e2e/mock-api.ts)
POS_API_URL=http://localhost:3100 pnpm --filter @pos/pos dev   # http://localhost:1420
# enrolment code: curl localhost:3100/__test/seed   (fresh code, user id and PIN per call)
```

Against the real API (docker compose infra running, database migrated, `pnpm --filter @pos/db grants` applied):

```bash
# in apps/api, built output; the operator id must be a UUID
DATABASE_URL=postgres://app_rw:app_rw@localhost:5432/pos PORT=3010 \
  AUTH_OPERATOR_TOKENS="0190f2a0-0000-7000-8000-0000000000aa:op_local_operator_token_000000" node dist/main.js
POS_API_URL=http://localhost:3010 pnpm --filter @pos/pos seed:dev      # tenant, location, register, cashier + PIN, enrolment code (about 30 s: TOTP step)
POS_API_URL=http://localhost:3010 pnpm --filter @pos/pos dev
```

Tauri build (needs the Rust toolchain, not available on every machine): `pnpm --filter @pos/pos tauri dev`.

## Tests

```bash
pnpm --filter @pos/pos test         # Vitest: session, store, cart, hooks, screens, Tauri command contract
pnpm --filter @pos/pos test:e2e     # Playwright (system Chrome) against the mock API: enrolment → PIN → shell, scanner, axe, touch targets
POS_LIVE_API_URL=... POS_LIVE_CODE=... POS_LIVE_USER=... pnpm --filter @pos/pos exec playwright test e2e/live.spec.ts   # real API, one-time code
```

## Layout

| Path | What |
|---|---|
| `src/session` | enrolment, device-bound session, PIN login, refresh (no React, no Tauri) |
| `src/platform` | ports for keychain, secrets and key-value config; Tauri and simulated adapters |
| `src/store` | SQLite schema (replicas, command log, projections), stores, replica loader |
| `src/cart`, `src/catalog` | placeholder cart and catalogue types, marked for replacement by the F2/F3/F4 ports |
| `src/hooks` | scanner capture, connectivity, device class, unsynced badge |
| `src/screens` | enrolment, PIN, shell (two-pane and variants), diagnostics, customer display |
| `src-tauri` | Rust: SQL plugin, OS keychain commands (device key signs in Rust), TCP pipe for printers (**not compiled in this checkout**) |
