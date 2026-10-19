# Unified Retail & Restaurant POS Platform — Design Package

Pre-implementation design package produced from the master product prompt. Everything here is a **proposal to validate**, not a description of built software. Status vocabulary used throughout: _planned_ (this package), _implemented_, _tested_, _simulated_.

## Contents

| Document                                                                                                               | What it answers                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [docs/01-system-architecture.md](docs/01-system-architecture.md)                                                       | Shape of the system: modular monolith, deployment profiles (cloud-only / device-autonomous / Store Hub), module boundaries, tenancy & authorization, core domain models and state machines, offline sync protocol, payment orchestration, events & integrations, reporting, security, SLOs, ADR index, risks                                                                                                                   |
| [docs/02-database-design.md](docs/02-database-design.md)                                                               | Conventions, per-domain ERDs, table-by-table invariants, indexing, partitioning, migrations, retention, nightly proof jobs                                                                                                                                                                                                                                                                                                     |
| [db/schema.sql](db/schema.sql), [db/schema_part2.sql](db/schema_part2.sql), [db/schema_part3.sql](db/schema_part3.sql) | Full PostgreSQL 16 DDL (159 tables across 17 schemas) with composite tenant FKs, append-only ledger triggers, partitioned event tables, exclusion constraint for reservations, and automatic Row-Level Security on every tenant table. Applied in order to a clean `postgres:16` container without errors; smoke tests confirm RLS isolation, closure-table maintenance, cross-tenant FK rejection and append-only enforcement |
| [docs/03-implementation-plan.md](docs/03-implementation-plan.md)                                                       | Stack with rationale, monorepo layout, team, Sprint 0 spikes, Phase 1 (F1–F10) and Phase 2 (M1–M12) vertical slices with acceptance criteria, Phase 3/4 scope, testing strategy, CI/CD, timeline, delivery risks, open decisions                                                                                                                                                                                               |
| [docs/04-design-plan.md](docs/04-design-plan.md)                                                                       | Design principles, device classes, design system tokens and components, wireframes for checkout, payment states, restaurant order entry, floor plan, KDS, CFD, admin dashboard, interaction budgets, accessibility, design process and metrics                                                                                                                                                                                 |
| [docs/05-competitive-review-and-plan-critique.md](docs/05-competitive-review-and-plan-critique.md) | Competitor landscape (Toast, Square, Lightspeed, Shopify, Oracle, Clover, Revel, Zeller, Odoo), provider offline-payment rules, REA static analysis of Odoo 18 POS, gaps in this plan and concrete amendments (applied 18 Oct 2026: Payments Edge, offline-card lifecycle, F7 rescope, M8 split, Xero export) |

## The ten decisions that shape everything

1. **One order aggregate** for retail sales and restaurant orders, with `checks` as the billable unit and three orthogonal statuses (commercial, fulfillment, payment).
2. **Shared TypeScript `domain-core`** executes pricing, tax, promotions and state machines identically on server and device; golden files are the contract.
3. **Append-only ledgers** (inventory movements, payment events, cash movements, loyalty, gift cards, audit) with derived balances that are proven nightly, never silently corrected.
4. **Payment intents and attempts** with an explicit `uncertain` state; the platform queries the provider before any retry and never stores PAN/CVV.
5. **Command-log synchronization** rather than row replication; the server re-executes device commands through normal services, so authorization and pricing stay in one place.
6. **Three deployment profiles**, with the optional **Store Hub** giving restaurants shared open checks, KDS and printing while the internet is down.
7. **Row-Level Security + composite tenant foreign keys** make cross-tenant data access a database error, not just an application bug.
8. **Modular monolith** with enforced module boundaries; payments and reporting are the designated first extractions.
9. **Australia first** (GST, AUD rounding, Tyro/Adyen/Stripe/Linkly) with nothing hardcoded: tax rules, currency precision, receipt text, fiscalization are data and adapters.
10. **Vertical slices with acceptance criteria**, each shipping schema, domain, API, UI, authorization, tests and observability together.

## Top risks to validate before committing budget

| Risk                                                                                           | Validation                                                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Hardware access from Tauri (printers, drawers, scales) on Windows and Android                  | Sprint 0 spike with real devices                                                 |
| Australian provider capabilities (offline store-and-forward, tip adjust, surcharging, refunds) | Sandbox capability matrix in Sprint 0                                            |
| Store Hub authority model                                                                      | Lab prototype with failure drills before Phase 2 slice M8                        |
| RLS performance at enterprise scale                                                            | Benchmark with synthetic 10k tenants in Phase 1 slice F10                        |
| PCI scope                                                                                      | QSA review before general availability; no card-data UI anywhere in the platform |

## Suggested reading order

Architecture §1–§3 → Database design §1–§3 → Implementation plan §4–§6 → Design plan §4. Then the DDL for detail.

## What is deliberately not in this package

Product vision and customer segments narrative, full permission matrix (the model is designed; the 21-role × permission table is a Phase 1 F1 deliverable), full OpenAPI spec (generated from code in F1–F5), detailed threat model (Sprint 0), infrastructure Terraform (Sprint 0), and runbooks (Phase 1 F10).

## Getting started (Sprint 0 scaffold)

Prerequisites: Node 22+, pnpm 9 (`corepack enable`), Docker.

```bash
pnpm install
pnpm build          # all packages and app stubs
pnpm test           # unit + golden files + Testcontainers integration (needs Docker)
pnpm lint           # includes module-boundary rules (tools/eslint/boundaries.js)
pnpm dev:infra      # postgres:16, redis:7, MinIO via infra/docker/docker-compose.yml
pnpm db:migrate     # applies db/schema*.sql as migration 0001 to DATABASE_URL
```

Layout follows [docs/03-implementation-plan.md §2](docs/03-implementation-plan.md). What exists, what is
stubbed and what remains from Sprint 0: [docs/releases/sprint-0.md](docs/releases/sprint-0.md).
