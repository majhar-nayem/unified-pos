# Stream S-DOCS: operations, security and payments documentation

Stream S-DOCS per [03 §4 and §15](../03-implementation-plan.md). Documentation only: no code, no numbered design document, no shared file and no schema was edited, nothing was committed, no dependency was added. Written 2026-10-18.

## 1. Features completed (status per §14 template)

Status vocabulary: **documented** (text written and cross-linked), **proposal** (statements need validation before they bind anyone). Nothing in this stream is "tested" in the engineering sense; the only automated check run was a relative-link check across the four owned folders (all links resolve).

| Deliverable | Files | Status |
| --- | --- | --- |
| Threat model v1: STRIDE per trust boundary (TB1 device ↔ cloud, TB2 device ↔ Hub, TB3 Hub ↔ cloud, TB4 public API, TB5 webhooks, TB6 admin console, TB7 Edge ↔ terminal), 8 requested abuse cases plus 8 more, likelihood/impact, mitigation with architecture citations and implementation status, gap register G-01…G-30 mapped to slices and streams, PCI DSS responsibility matrix by integration mode | [security/threat-model.md](../security/threat-model.md) | documented; **proposal awaiting security-engineer review** |
| Supported devices and OS matrix: OS minimums, hardware profiles, terminals and firmware policy per provider, printers (ESC/POS, Star Line), scanners, scales, CFD, drawers, Store Hub hardware and network (single subnet, mDNS, static fallback, router guidance), 16 enrollment/heartbeat checks | [operations/supported-devices.md](../operations/supported-devices.md) | documented; **every row `Proposed`** until the Sprint 0 hardware spike |
| Payment capability matrix: Adyen, Stripe Terminal, Tyro, Linkly, Windcave by connection mode, with a source per cell and `unknown` where not established; Australian surcharge ban and its effect; vendor question list; Sprint 0 sandbox test plan T1–T9 | [payments/capability-matrix.md](../payments/capability-matrix.md) | documented from public documentation; **no sandbox result yet** |
| ADR-001…ADR-020 expanded from the one-line index, plus index | [adr/](../adr/README.md) | documented; statuses copied from architecture §14 |
| Store onboarding workflow | [operations/store-onboarding.md](../operations/store-onboarding.md) | documented; API steps cross-checked with F1 routes |
| Device provisioning workflow (enrollment code, device login, Hub, peripherals, revocation) | [operations/device-provisioning.md](../operations/device-provisioning.md) | documented; F1-aligned |

## 2. Architectural decisions (ADR links)

[ADR-001](../adr/ADR-001.md) modular monolith · [002](../adr/ADR-002.md) RLS · [003](../adr/ADR-003.md) UUIDv7 · [004](../adr/ADR-004.md) money · [005](../adr/ADR-005.md) domain-core · [006](../adr/ADR-006.md) outbox · [007](../adr/ADR-007.md) Drizzle · [008](../adr/ADR-008.md) Tauri · [009](../adr/ADR-009.md) command log · [010](../adr/ADR-010.md) payments orchestration · [011](../adr/ADR-011.md) Store Hub · [012](../adr/ADR-012.md) order statuses · [013](../adr/ADR-013.md) ledgers · [014](../adr/ADR-014.md) REST · [015](../adr/ADR-015.md) OpenTelemetry · [016](../adr/ADR-016.md) AWS · [017](../adr/ADR-017.md) read models · [018](../adr/ADR-018.md) promotion DSL · [019](../adr/ADR-019.md) Payments Edge · [020](../adr/ADR-020.md) surcharging. No decision was changed; the ADRs add context, alternatives and consequences, and in places record obligations discovered while writing (see §6).

## 3. Modules and files changed

Created only under `docs/security/`, `docs/operations/`, `docs/payments/`, `docs/adr/` and this file. Stubs left: none. Shared-file lines appended: none. Dependencies added: none. Migrations: none. APIs introduced: none.

## 4. Tests executed

Relative-link check over the four folders (Python, run once after writing): every link target exists; the threat-model anchor `#pci-dss-responsibility-matrix` matches its heading. Section references between documents (for example `supported-devices §8`) were corrected by hand after the check. No claim in the documents was verified on hardware or in a provider sandbox.

## 5. Statements that are proposals awaiting validation

| Statement | Validated by |
| --- | --- |
| Every threat rating (L/I), every proposed control and the gap priorities | Security-engineer review (Sprint 0 exit criterion) |
| PCI responsibility matrix, candidate SAQ paths, whether the Edge/Hub is in a merchant's CDE or makes the platform a service provider | QSA, before GA (architecture §11) |
| All OS minimums, hardware profiles, printer/scanner/scale/terminal candidates, Hub appliance spec, network figures (uplink, ports) | Sprint 0 hardware spike (R1) and Payments Edge spike (R11); M8a lab for Hub and network |
| Every cell of the capability matrix | Sprint 0 sandbox tests T1–T9 and vendor answers (§6 of that document); Tyro certification kick-off for lead time |
| Enrollment-time checks E2–E16 and the override policy | Implementation in F6/F8; contract change for `osVersion`, model, attestation fields |
| Hub identity pinned at enrollment, device-signed requests, signed replicas | Hub design in M8a |
| Offline integrity controls (per-device monotonic sequence, clock bounds, command whitelist per device kind) | M1 design |
| Surcharge-ban scope outside eftpos, Mastercard and Visa (American Express, others) | Legal review; the RBA conclusions paper was not read directly (secondary sources only) |
| Onboarding timings (hypercare, option for unused-code revocation, interim "owner-only role grants" rule) | Pilot (F10) |

## 6. Known limitations and findings for other streams

**Sources I could not read** (so the related cells say `unknown` or are graded R in the matrix): Tyro certification criteria PDF (404; the pre-auth page also 404), Adyen local card routing page (404), Linkly Cloud Development Guide (403; search excerpts only), the second 205,000 characters of the Linkly TCP/IP page, the RBA conclusions paper itself, Windcave REST pages. Windcave's offline statement comes from an old operating guide (v2.3) seen only in a search excerpt.

**Conflict with an earlier document:** [05 §3](../05-competitive-review-and-plan-critique.md) and [01 §8.3](../01-system-architecture.md) say Stripe refuses EFTPOS-only cards offline. The current Stripe smart-reader offline page lists eftpos as supported (co-branded cards routed through the international scheme) and supports American Express offline. Only the sandbox can settle this. I did not edit docs 01 or 05; the integration lead may want to qualify those rows.

**Facts I believe but did not verify:** Windows 10 IoT Enterprise LTSC 2021 end date (January 2032), Australian trade-measurement approval for scales, candidate printer/scanner model names (market practice, not sourced), provider SDK OS minimums (not read).

**Findings that affect other streams (no edits made by me):**

| Finding | Stream / slice |
| --- | --- |
| `AssignmentsService.grant` checks `access.assignment.grant` at the scope but does not compare the role being granted with the granter's own permissions; dual approval for admin role grants is not implemented (threat model AC-8, G-19) | F1 follow-up / S-F8 |
| No device wipe endpoint exists although `wiped` status and `wipe_requested_at` do (G-15); no way to revoke an unused enrollment code | S-F6a, S-F8 |
| Enrollment request has no OS version, model, WebView version, attestation or storage fields, so most proposed checks cannot be enforced yet | S-F6a with contracts owner |
| Operator access is a static env token (`AUTH_OPERATOR_TOKENS`) (G-26) | Integration lead, plan §13 decision 2 |
| Inbound webhook verification, outbound webhook SSRF controls, nightly proof jobs and audit-chain anchoring are not built (G-03, G-05, G-06) | S-F5, Integration |
| Promotion rows have only a row `version`; no DSL version inside `rules` (ADR-018) | S-F3 |
| Drizzle table-ownership architecture test is still open (ADR-001) | Integration lead |
| One-subnet rule vs PCI network segmentation: needs a dedicated store VLAN (G-30) | Onboarding docs (done), S-F6a preflight |

## 7. Security considerations

The documents contain no secrets, tokens or real credentials. Enrollment-code format and token lifetimes are quoted from the F1 implementation and release note. The threat model recommends controls that are not yet implemented; reading it as a statement of current protection would be wrong, and each row labels its status (Impl, Design, Gap).

## 8. Deployment instructions

None (documentation).

## 9. Remaining tasks and recommended next steps

1. Security-engineer review of the threat model; agree priorities of G-01…G-30.
2. Run the Sprint 0 spikes with the matrices open and flip rows to `Confirmed` or amend them; send the vendor questions in capability matrix §6, and start Tyro certification to learn its lead time.
3. Fix the P1 gaps before pilot: G-19 grant ceiling, G-26 operator tokens, G-05 webhook verification (F5), G-22 PCI/PII scanner and log-redaction test, G-23 update signing, G-14 enrollment hygiene, G-27 admin step-up, G-03 chain anchoring.
4. Decide open plan decisions this documentation depends on: IdP (13.2), Hub packaging (13.4), Payments Edge host for single-register stores (13.8), first provider (13.1).
5. Engage a QSA early to decide the Edge/Hub scope question in the PCI matrix.
6. After the spikes, reconcile docs 01 and 05 with the capability matrix (Stripe eftpos offline; per-mode capability) and promote the onboarding documents into the F10 pilot guide.
