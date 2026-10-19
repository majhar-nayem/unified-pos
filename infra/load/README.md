# infra/load

k6 scripts for the F10 load profile ([docs/03-implementation-plan.md §5 F10, §9](../../docs/03-implementation-plan.md)):
1k registers, 200 orders/s sustained, and a 10x catalog sync burst at store open. Thresholds are the SLOs in
[docs/01-system-architecture.md §12.1](../../docs/01-system-architecture.md):

| Tag (`kind`) | Requests                          | Threshold            |
| ------------ | --------------------------------- | -------------------- |
| `lookup`     | `GET /v1/variants/by-barcode`     | p95 < 200 ms         |
| `api`        | order create, catalog sync pages  | p95 < 300 ms         |
| `commit`     | `POST /v1/orders/{id}/place`      | p95 < 500 ms         |
| all          | failed requests                   | < 0.05 % (99.95 %)   |
| orders       | dropped iterations (rate not met) | none                 |

## Run

```bash
# local stack: pnpm dev:infra && pnpm db:migrate && pnpm --filter @pos/db grants, then start the api with
# AUTH_OPERATOR_TOKENS="0a1b2c3d-0000-4000-8000-000000000f08:op_local_operator_token_0001" RATE_LIMIT_ENABLED=false
k6 run -e BASE_URL=http://localhost:3000 -e OPERATOR_TOKEN=op_local_operator_token_0001 -e PROFILE=smoke infra/load/f10.js

# staging (a fraction of the target), then the full profile
k6 run -e BASE_URL=https://api.staging.example.com -e OPERATOR_TOKEN=... -e PROFILE=staging infra/load/f10.js
k6 run -e BASE_URL=https://api.staging.example.com -e OPERATOR_TOKEN=... -e PROFILE=full --summary-export k6-summary.json infra/load/f10.js
```

Profiles are `smoke`, `staging` and `full`; every number in [lib/config.js](lib/config.js) can be overridden with an
environment variable (`REGISTERS`, `ORDERS_PER_SECOND`, `HOLD`, `USERS`, ...).

`setup()` provisions a throwaway tenant through the same calls the admin console uses (operator creates the tenant,
first admin accepts the invitation, enrols TOTP, signs in), then creates a location, a catalog and cashier accounts.
Tenants are named `load-<suffix>` so an operator can purge them. Each VU holds its own cashier session and signs in
again before the 15 minute access token expires.

## Notes for the full profile

- The api rate limiter keys by tenant, token kind and user: 200 orders/s over the cashier pool needs `USERS` large
  enough that no principal exceeds its bucket (default 100 users, 300 burst and 100/s each), or the limiter relaxed
  on the target. Report any 429 as a finding rather than raising the limit silently.
- Payments are excluded from the commit measurement (§12.1: "excluding external payment"); add a mock-provider
  tender step when the payments stream ships its mock provider.
- Self-test of the TOTP implementation: `k6 run infra/load/lib/totp.selftest.js` (RFC 6238 vectors).
- Not covered yet: sync feed lag and Store Hub kitchen delivery (need the M1 sync endpoints), reporting reads (F9).
