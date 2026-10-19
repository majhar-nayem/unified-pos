# Competitive Review and Critical Plan Review

Date: 18 October 2026. Reviews [01-system-architecture.md](01-system-architecture.md), [02-database-design.md](02-database-design.md), [03-implementation-plan.md](03-implementation-plan.md), [04-design-plan.md](04-design-plan.md) and the DDL against (a) vendor documentation and current market coverage for Toast, Square, Lightspeed, Shopify POS, Oracle Simphony/Xstore, Clover, Revel, Zeller and Tyro, and (b) a REA static analysis of a shipped open-source competitor, Odoo 18 Point of Sale.

Three kinds of statements appear below and are labelled: **Observed** (read directly from a vendor document or from the shipped artifact), **Inferred** (a conclusion drawn from observations), **Unknown** (not established by the evidence gathered).

---

## 1. Evidence basis

### 1.1 Market and vendor documentation

Web search plus direct reads of vendor documentation pages (Toast platform guide and support centre, Square support, Adyen docs, Stripe Terminal docs, Oracle Simphony configuration guide, Tyro integrated EFTPOS docs). Third-party review sites were used only for positioning and pricing signals and are marked as such. Full source list in §8.

### 1.2 REA analysis of Odoo 18 Point of Sale (shipped artifact)

| Item | Value |
|---|---|
| Target | Point-of-sale addons extracted from the official `odoo:18.0` Docker image (Community Edition) into an isolated directory |
| Addons present | point_of_sale, pos_restaurant, pos_self_order, pos_loyalty, pos_hr, pos_discount, pos_sale, pos_online_payment, pos_adyen, pos_stripe, pos_six, pos_viva_wallet, pos_paytm, pos_razorpay, pos_event, pos_sms, pos_epson_printer, pos_hr_restaurant, pos_restaurant_loyalty, pos_online_payment_self_order |
| Addons absent from the CE image | pos_preparation_display (kitchen display), pos_iot, pos_enterprise, pos_blackbox_be, pos_restaurant_appointment, pos_settle_due (Enterprise-only) |
| REA operation | `analyze-javascript-application` (CLI, static, inert parse; no execution) |
| Evidence ID | `ev_db4a01f007b301b9f00b112b0e37fc40b4ab904a24a117e49bb835032be2681e` |
| Root artifact SHA-256 | `755b721b0c417badbe8f1b9a32dc060ff195cf07b1c79a7386b1bb4dce3b9f61` |
| Statistics | 366 files, 365 parsed, 0 parse failures, 275,749 AST nodes, 4,056 findings; module graph 4,464 nodes / 4,786 edges (3,442 import edges); semantic graph 100,000 nodes (cap reached), 82,570 relations, 41,098 unknowns (mostly dynamic call targets) |
| Limitations (verbatim from REA) | Static imports, endpoints and storage relationships do not prove runtime execution; graph coverage is incomplete and absence of a fact is not evidence of absence; the semantic node cap was reached, so some files are partially projected |
| Retained files | [evidence/odoo18-rea/evidence-summary.json](evidence/odoo18-rea/evidence-summary.json), [evidence/odoo18-rea/odoo18-overview.txt](evidence/odoo18-rea/odoo18-overview.txt), [evidence/odoo18-rea/odoo18-graph.txt](evidence/odoo18-rea/odoo18-graph.txt). The full 200 MB Evidence record is in the session scratchpad, not the repository. |

REA's MCP server could not be used in this session: `rea doctor` reports the Claude Code registration as stale (it points at a path that no longer exists) and no native decompiler installed. The CLI fallback was used, which is the documented path for a JavaScript tree. Proprietary competitors (Toast, Square, Lightspeed) ship as mobile apps whose binaries were not obtained; their behaviour below comes from their own documentation, not from artifacts.

---

## 2. Competitor landscape

| Platform | Segment and positioning | Retail + restaurant in one product? | Offline model (observed) | KDS | Payments model | Australia |
|---|---|---|---|---|---|---|
| **Toast** | Full-service and multi-location restaurants; hardware + processing bundle; 2-year contracts | No (restaurant only) | Per-device offline; devices do not sync with each other; a hardwired device acts as a LAN hub for KDS only via UPnP multicast; queued card payments; optional per-transaction cap with manager approval | First-party, per-screen | Toast is the processor (2.49 % + 15¢ advertised) | Present (offline payments doc covers AU) |
| **Square** (Restaurants / Retail) | SMB, cafes, QSR, bars, small retail; cheapest entry | Two apps on one platform; KDS now available to retail too | Per-device; merchant-set per-transaction cap; 72 h upload deadline, 24 h sessions on readers; expired payments unrecoverable | First-party, cross-vertical | Square is the processor (1.6 % tap in AU per third-party) | Strong |
| **Lightspeed** (Restaurant "K", Retail "X") | Mid-market; strongest built-in loyalty/marketing per reviewers; pricier | No: two separate products | Vendor claims orders keep flowing to kitchen offline ("TrueSync"); no public detail | Add-on, USD 30–40 per screen per month | Lightspeed Payments or third-party | Strong (acquired Kounta) |
| **Shopify POS** | Retail attached to Shopify online stores | Retail only | Not documented in sources gathered (Unknown) | None | Shopify Payments | Present; POS Pro USD 89/location/month; Stocky inventory app shuts down 31 Aug 2026 |
| **Oracle Simphony / Xstore** | Enterprise hospitality / enterprise retail | No: two products | On-premise shared services (CAPS, KDS controller, print controller, with backup instances) keep the site running when WAN fails; 2025 Xstore adds containerised deployment including edge hardware | Simphony KDS with controller failover | Oracle Payment Interface to PSPs | Enterprise accounts |
| **Clover** | SMB, bank-distributed | One platform, vertical apps | Per-device; offline on by default for up to 7 days (fixed), default USD 500 per transaction cap; no pre-auth/capture offline | Via apps | Fiserv processing | Limited |
| **Revel** | Multi-location chains, franchisors; iPad only | Both verticals on one iPad platform | iPad caching described by reviewers (Unknown detail) | Yes | Multiple processors | Limited |
| **Zeller** | AU SMB; launched POS app June 2026 to challenge Square; no software fee, per-transaction pricing | Both (new) | Unknown | Unknown | Zeller terminals | AU-native |
| **Odoo POS** (analysed) | ERP-attached SMB POS, open source core, Enterprise add-ons | Yes: one app, restaurant as an addon | Per-browser IndexedDB mirror with an in-memory unsynced queue and retry counter; no LAN component; multi-device sync via server websocket bus | Enterprise-only module | Adapter per terminal vendor (Adyen, Stripe, Six, Viva, Paytm, Razorpay); Tyro added 2025 | Growing |

**Inferred positioning for our platform.** Only Square, Revel, Zeller and Odoo put retail and restaurant on one product, and none of them combine that with enterprise multi-entity structure, an on-premise store hub and open payment orchestration. Lightspeed and Oracle, the two vendors with enterprise depth, run two separate products each. The "one platform, two experiences, enterprise hierarchy, Simphony-class resilience" wedge in our architecture is real and uncontested at the mid-market. Where we lose on day one: bundled processing economics (Square, Toast, Zeller), hardware bundles, and app ecosystems.

---

## 3. Offline payments: what the providers actually allow

This is the area where the evidence most changes our plan.

| Provider / product | Which integration modes support offline card | Caps and windows | Excluded methods | After reconnect |
|---|---|---|---|---|
| **Adyen** (observed, docs.adyen.com) | Terminal API over **local** network, standalone terminals, Mobile SDK. **Cloud Terminal API: "not very useful"**, works only if the link drops after the terminal received the request | Merchant-configured per-transaction maximum and maximum count per terminal, set by Adyen Support; mobile: 24 consecutive hours after online attestation; does not work during an Adyen platform outage | Most local schemes, QR wallets, magstripe, cashback; **American Express does not accept offline payments in Australia**; mobile supports offline PIN only | Stored payments forwarded; response carries no auth data or PSP reference; issuer can decline later; Auto Rescue retries for one calendar month; only unreferenced refunds offline |
| **Stripe Terminal** (observed, docs.stripe.com) | Mobile SDKs (iOS/Android/React Native) with Bluetooth or smart readers, Apps on Devices. **JavaScript SDK and server-driven integrations do not support offline.** Smart readers still need a working LAN between POS and reader | Stripe-enforced USD 10,000 (or equivalent) per transaction; merchant may set lower amount/count limits via `offlineBehavior`; reader must have been connected online within 24 h on the same LAN and updated within 30 days | Swipe disallowed; contactless not allowed in SCA markets; EFTPOS-only cards (per Stripe's offline FAQ; its smart-reader page lists eftpos co-branded cards as supported offline, so confirm in the sandbox) not accepted; no refund or cancel until forwarded | Reader forwards automatically; PaymentIntent has null id until forwarded; webhooks reconcile via metadata; merchant bears decline and tamper risk |
| **Square** (observed, support page) | Square hardware and apps only | Merchant-set per-transaction cap; 72 h upload deadline; 24 h sessions on readers; expired payments cannot be retrieved | Physical contactless cards (wallet taps allowed), gift cards, Tap to Pay, manual entry, Clearpay | No notifications for declines; review in reports; merchant liable |
| **Toast** (observed, platform guide) | Toast devices with "background card processing" enabled | Optional dollar cap with manager approval above it; in some countries the cap must be set before the outage | Gift cards, loyalty, house accounts, text-to-pay; cannot close checks, declare tips or clock out | Queue drains on reconnect; declined card → check tagged "Backgrounded" and reopened; data lost if app uninstalled while pending |
| **Clover** (observed via Clover docs and a Lightspeed-hosted guide) | Clover devices | Up to 7 days (fixed), default USD 500 per transaction (editable per device) | Pre-auth and capture | Device-level settings per terminal |
| **Tyro** (observed, docs) | iClient JS over LAN, .NET TTA, iOS/Android SDKs, Pay@Table REST; **certification mandatory before production**; offline behaviour not documented on the pages read (Unknown) | Unknown | Unknown | Unknown |

**Inferred consequences for our architecture.**

1. Our ADR-010 and §7.4 assume "cloud terminal API (Adyen cloud, Stripe server-driven)" as a primary mode. Both vendors state those modes do **not** give offline card acceptance. If offline card is a requirement for profile B/C stores, the terminal adapter must run **on the LAN side**: Adyen local Terminal API (needs the terminal's TLS certificate and local key handling), Stripe mobile/smart-reader SDK (native, not the JS SDK), Tyro iClient (browser JS over LAN, suited to a webview). This moves adapter execution out of the cloud `payments` deployable and into the Tauri native layer or the Store Hub.
2. Every provider makes the merchant liable for later declines. Our schema has `offline boolean` and `settlement_pending` but no lifecycle for *forwarded then declined*. Toast's "Backgrounded check" pattern (reopen the check, collect again) is the right UX; our order/payment model needs explicit states and a manager queue for it.
3. Caps are per transaction **and** per count/sum per device, with expiry windows (24 h, 72 h, 7 days). Our offline policy table (§8.3) mentions caps and queue age but the schema has no `offline_expires_at`, no per-device offline count/sum counters, and the sync protocol has no "forward now or expire" urgency signal.
4. Amex refusing offline in Australia, EFTPOS-only cards (per Stripe's offline FAQ; its smart-reader page lists eftpos co-branded cards as supported offline, so confirm in the sandbox) refused by Stripe offline, and "offline PIN only" rules mean the POS must know the card product before promising offline acceptance. The terminal decides, so the UI copy must be "the terminal may decline offline", never "card payments work offline".

---

## 4. REA findings on Odoo 18 Point of Sale

All items below are **Observed** from the shipped artifact unless marked otherwise. Paths are relative to the extracted addon root; Evidence ID as in §1.2.

### 4.1 Module footprint (module graph, `semantic_role: source-module`)

| Addon | Source modules | What it tells us |
|---|---|---|
| point_of_sale | 168 | Core: screens (product, payment, receipt, ticket), models, data service, printers, hardware proxy, barcode, scale, customer display |
| pos_self_order | 47 | Kiosk / QR ordering is the second-largest surface, larger than the restaurant addon itself |
| pos_restaurant | 40 | Floor screen, table model, bill screen, split-bill screen, tip receipt, device synchronisation override |
| pos_loyalty | 23 | Coupons, gift cards, loyalty programs woven into product, payment, partner and ticket screens via overrides |
| pos_hr | 15 | Employee login by PIN/barcode on a shared till (manifest: "unlimited number of employees can log on to that till") |
| pos_event, pos_sale, pos_online_payment | 13, 10, 8 | Event tickets, sales-order pickup, online payment for checks |
| Payment terminal adapters | pos_viva_wallet 7, pos_six 5, pos_adyen 4, pos_paytm 3, pos_razorpay 3, pos_stripe 2 | Each terminal integration is a 2–7 file plug-in over one interface |

Inferred: Odoo's "extend the core by overriding components" model keeps each vertical small, but 1,386 intra-POS import edges plus 144 into self-order and 66 into restaurant show tight coupling: the restaurant and kiosk addons patch core screens rather than compose them. Our module-boundary rule (public interfaces and events only) is the opposite choice and is the right one for a multi-tenant SaaS where tenants mix verticals.

### 4.2 Offline storage and synchronisation

- Storage nodes: IndexedDB wrapper `app/models/utils/indexed_db.js` creates one object store per model keyed by `id`; `localStorage` keys `pos.sequenceNumbers`, `floorPlanStyle`, `productListView`, `p2pRequestId`, `referenceId`; `sessionStorage` key `pos_reload_recovery`.
- `app/models/data_service.js`: a `network` object with `offline`, `unsyncData[]` and a per-entry `try` counter; `browser` `online`/`offline` events flip the flag and trigger `syncData()`, which drains `unsyncData` FIFO and increments `try` on failure; failed RPCs are detected via `ConnectionLostError`; every record set is mirrored into IndexedDB (`syncDataWithIndexedDB`) and reloaded at start (`readAll`).
- `app/store/devices_synchronisation.js`: multi-device consistency for restaurant tables is achieved by calling `pos.config.notify_synchronisation` on the server and receiving a `SYNCHRONISATION` websocket message, then re-reading from the server. Inferred: there is no LAN peer path; two devices in one restaurant cannot see each other's open tables while the internet is down.
- Order sequencing offline: `pos.sequenceNumbers` in localStorage (Inferred: a register-local sequence, the same approach as our `client_order_ref`).

Inferred lesson: Odoo's offline is a browser-local mirror plus a retry queue, the same shape as competitors' per-device modes. Our command-log protocol is more rigorous (idempotent commands, server re-execution), and our Store Hub addresses the exact gap Odoo has.

### 4.3 Payment adapter interface

`app/payment/payment_interface.js` exposes `send_payment_request(uuid)`, `send_payment_cancel(order, uuid)`, `send_payment_reversal(uuid)`, `enable_reversals()`, `close()`; payment lines carry a status including `retry`. `pos_adyen/static/src/app/payment_adyen.js` builds `SaleToPOIRequest` messages with a `ServiceID`, cancels by referencing the previous `ServiceID`, polls server-side notifications via `silentCall`, and treats a response as successful only when its `ServiceID` matches the pending line. The server stores on `pos.payment`: `card_type`, `card_brand`, `card_no` (last 4), `cardholder_name`, `payment_ref_no`, `payment_method_authcode`, `payment_method_issuer_bank`, `transaction_id`, `payment_status`, `ticket`.

Inferred: Odoo's interface has three verbs and no explicit uncertain state; correlation by `ServiceID` is the equivalent of our idempotency key. Our intent/attempt/event model with `uncertain` and `getStatus()` is stronger; Odoo's receipt-field list is a good checklist for our `card_payment_details` (we lack `issuer_bank` and a free-text `ticket` from the terminal, which is what gets printed on EMV receipts).

### 4.4 Order state and accounting coupling

`pos_order.py` has a single `state` selection: draft, cancel, paid, done, invoiced. Payments create accounting moves (`_create_payment_moves`), orders create stock pickings (`_create_order_picking`), and `sync_from_ui` is the single server entry point for orders from devices.

Inferred: Odoo folds payment and fulfilment into one enum because its ERP owns accounting and stock. Our three orthogonal statuses are justified for a platform that integrates with external accounting rather than being it. However, Odoo's deep stock/accounting integration is what its SMB customers buy; our plan defers accounting integration to Phase 3, which is late for the SMB segment (see §6).

### 4.5 Restaurant and kitchen

`pos_restaurant` provides `transferOrder(orderUuid, destinationTable)`, a floor screen with table linking, a split-bill screen and a bill screen; the manifest advertises bill printing, bill splitting and kitchen **printing** to kitchen or bar printers. The kitchen display (`pos_preparation_display`) is not in the Community image. Hardware access runs through an HTTP "hardware proxy" (`/hw_proxy/...`, IoT Box) or direct Epson ePOS network printing, and the cash drawer is kicked via the printer.

Inferred: printers-as-KDS-fallback and drawer-via-printer are industry-standard and are already in our design. Odoo has no course firing, seat-level ordering or station routing in CE; these remain differentiators for us.

### 4.6 Unknowns

REA's static analysis cannot show how Odoo behaves at runtime (what is actually retried, how conflicts are surfaced), and 41,098 dynamic call targets were unresolved. Nothing above should be read as a measurement of Odoo's reliability.

---

## 5. Where competitors expose gaps in our plan

| # | Gap or correction | Source of evidence | Severity |
|---|---|---|---|
| G1 | **Offline card requires LAN-side adapters, not cloud terminal APIs.** ADR-010 and §7.4 list cloud modes first. | Adyen and Stripe docs (§3) | High: changes where payment code runs |
| G2 | **No "forwarded then declined" lifecycle** for offline card payments; no reopen-check flow; no offline expiry or per-device offline counters. | Toast post-outage guide, Square 72 h expiry, Adyen Auto Rescue | High: money correctness |
| G3 | **Surcharging is banned in Australia from 1 October 2026** for eftpos, Mastercard and Visa (Amex/others outside the ban). Our schema and adapter capabilities feature `surcharge_minor` and `surcharging` prominently; the plan has no least-cost-routing (LCR) reporting even though the RBA cites ~20 % lower debit costs with LCR. | RBA review coverage, CommBank, AP+ | Medium: wasted scope and a missed selling point |
| G4 | **Phase 1 is too wide.** F6 (POS app), F7 (restaurant + KDS web), F8 (admin console) and F9 run in parallel across three front-end surfaces with two POS engineers and one admin engineer. Competitors with far larger teams ship one vertical at a time. | Team table vs slices | High: schedule risk |
| G5 | **Accounting integration deferred to Phase 3.** Odoo's SMB pull is ERP integration; Square/Lightspeed ship Xero/QuickBooks connectors in base tiers. | Odoo artifact, vendor feature lists | Medium |
| G6 | **Shopify's Stocky retires 31 Aug 2026**: Shopify POS Pro merchants lose transfers/forecasting. Our retail inventory plus a Shopify connector in Phase 3 misses a time-limited opening. | Shopify coverage | Medium: opportunity |
| G7 | **Store Hub hardening lessons** from Toast: router power-cycle during an outage breaks printing until the ISP returns; all devices must share one subnet; discovery depends on UPnP multicast; vendor refuses support on non-vendor routers. Our Hub design lacks static-address fallback, subnet guidance and a hub failover (Simphony ships Backup CAPS and Backup KDS Controller). | Toast support, Oracle shared services | Medium |
| G8 | **Device OS support matrix is unspecified.** Shopify requires Android 13+/iOS 18+ from 2027; Square excludes older readers from offline. Our Tauri targets name platforms but not minimum OS versions or supported terminal firmware. | Shopify, Square docs | Low |
| G9 | **KDS and per-screen monetisation** is standard (Lightspeed USD 30–40/screen, Toast per device). Our plan has no packaging model, which affects tenancy entities (per-location vs per-device licensing) and feature flags. | Lightspeed pricing pages | Low for architecture, high for product |
| G10 | **Receipt fields from terminals.** Odoo persists issuer bank and the raw terminal `ticket` text for EMV receipts; we do not. | Odoo `pos_payment.py` | Low |
| G11 | **Tyro certification is mandatory and takes time**; Tyro iClient is browser JS over LAN, which fits a webview, but offline behaviour is undocumented. R3 must include certification lead time and an explicit Tyro offline finding. | Tyro docs | Medium: schedule |
| G12 | **Closing checks offline.** Toast forbids closing checks, declaring tips and clock-out offline. Our plan allows closing cash checks offline (correct) but has no stated rule for card-paid checks or tip declaration offline. | Toast support | Low |

---

## 6. Critical review of the plan

### 6.1 What the evidence supports

- **Single order aggregate with checks** (ADR-012): Odoo uses one order model for both verticals; Square's cross-vertical KDS and Revel's single iPad platform show the market accepts one engine. Keep.
- **Payment intent/attempt/event with `uncertain`** (ADR-010): every provider's offline and timeout semantics (null ids, late declines, ServiceID correlation) need exactly this. Keep, extend per §7.
- **Command-log sync** (ADR-009): more rigorous than Odoo's retry queue and Toast's per-device queue. Keep.
- **Store Hub** (ADR-011): the Simphony shared-services model is the enterprise reference and Toast's KDS-only LAN hub shows mid-market demand. Keep, but see sequencing below.
- **Shared schema with RLS and composite tenant FKs**: no competitor evidence against it; proven to apply cleanly on PG 16.
- **Promotion DSL in domain-core**: Odoo ships loyalty as 23 modules of screen overrides, confirming that a central engine is the cleaner design.

### 6.2 Where the plan is weak

1. **Payments edge placement (G1).** The architecture puts adapters in a cloud `payments` deployable and says the POS "never receives PAN". Both remain true, but for Adyen local Terminal API, Stripe SDK and Tyro iClient the *driver* must run at the store. Required change: introduce a **Payments Edge** component (Tauri native plugin for single-register stores, Store Hub module for profile C) that executes terminal adapters, holds the offline queue, and reports attempts to the cloud via the same command log. The cloud `payments` deployable keeps webhooks, settlement, reconciliation and card-not-present flows.
2. **Offline card lifecycle (G2).** Add states and fields; see §7.1. Add a manager queue "Offline payments awaiting outcome" and the Toast-style reopen flow.
3. **Phase 1 scope (G4).** Three realistic options: (a) keep both verticals but ship restaurant with kitchen *printing* only (Odoo CE's choice) and move KDS web to Phase 2; (b) ship retail only in Phase 1 and restaurant in Phase 2; (c) extend Phase 1 to 18–20 weeks. Recommendation: (a). It preserves the unified-platform pilot while cutting the riskiest surface (real-time KDS routing) from the first release.
4. **Surcharging (G3).** Keep `surcharge_minor` in the schema (other markets, Amex), remove surcharge UI from Phase 1, add **LCR/debit routing** visibility to payment reporting and to the adapter capability matrix (`leastCostRouting`), because from October 2026 processing cost, not surcharge recovery, is what Australian merchants compare.
5. **Accounting integration (G5).** Pull a minimal Xero journal export (daily sales, tax, tenders, tips, cash variance) from Phase 3 into Phase 2, after M6 cash management. It is a read-only export and small.
6. **Store Hub sequencing (G7).** M8 bundles hub, KDS app and printer fallback in four weeks. Split: M8a "KDS LAN hub" (hub owns kitchen tickets and printers only; checks stay device-owned, like Toast) and M8b "shared open checks on hub" (full authority). Add static IP/hostname fallback to mDNS, a "one subnet" preflight check in device enrollment, and a Phase 3 item for hub failover (secondary hub or primary-register takeover), mirroring Backup CAPS.
7. **Hardware and OS matrix (G8, G11).** Sprint 0 must output a supported-devices document: OS minimums, terminal models and firmware, printers, and the Tyro/Adyen/Stripe certification timeline. Tyro certification should start in Sprint 0, not F5.
8. **Schema details (G2, G10).** See §7.1 and §7.2.
9. **Over-engineering watch-list.** Customer PII envelope encryption with blind indexes in Phase 1 (F1/F2) is heavier than any competitor evidence demands for a pilot; it is right for GA but could move to Phase 2 behind the repository interface. Audit hash-chaining is cheap and should stay. ClickHouse in Phase 3 remains correctly deferred.
10. **Design plan.** The payment status panel already shows an "Approved offline" amber state; add the "Declined after reconnect" banner and the reopened-check flow, and change all copy from "card payments work offline" to "the terminal may accept card payments offline up to your limit".

---

## 7. Recommended amendments (concrete)

**Status: applied on 18 October 2026** to `db/schema_part2.sql`, `db/schema_part3.sql`, [01-system-architecture.md](01-system-architecture.md) (Payments Edge component, §7.4 terminal-mode table, §8.3 provider table and offline lifecycle, §12.2 rows, ADR-019/020, R3/R11), [03-implementation-plan.md](03-implementation-plan.md) (Sprint 0 items, F7 rescoped to kitchen printing, M8a/M8b, M11, M13, Phase 3 items, milestones, risks, decisions) and [04-design-plan.md](04-design-plan.md) (payment states, KDS banners, copy guideline). The amended DDL applies cleanly on PostgreSQL 16 and the `forward_outcome` constraint is tested.

### 7.1 Schema (`db/schema_part3.sql`, `payments` and `orders`)

- `payments.payment_intents`: add `offline_collected_at timestamptz`, `offline_expires_at timestamptz`, `forwarded_at timestamptz`, `forward_outcome text CHECK (forward_outcome IN ('pending','approved','declined','expired','rescue_in_progress'))`, `offline_device_seq integer`; add status value `declined_after_forward`? No: keep `failed` and record `forward_outcome = 'declined'`, so the state machine stays small.
- `payments.card_payment_details`: add `issuer_bank text`, `terminal_receipt_text text` (printable EMV ticket from the terminal).
- `payments.payment_provider_accounts.capabilities` contract: add `offlineModes: ['local_terminal_api','sdk','none']`, `offlineExcludedSchemes[]`, `leastCostRouting boolean`, `certificationStatus`.
- `orders.orders`: add `reopened_reason text` and allow `completed → open` transition only for `forward_outcome = 'declined'` (recorded in `order_events.kind = 'reopened_offline_decline'`).
- `devices.devices.health`: document `offline_payment_count` and `offline_payment_sum_minor` keys; enforce caps in the Payments Edge, prove nightly.
- `payments.reconciliation_exceptions.kind`: add `offline_declined`, `offline_expired`.

### 7.2 Architecture document

- §4: add **Payments Edge** component; §7.4: reorder terminal modes to local/SDK first, cloud second, with the offline capability column per mode; §8.3: replace the "card present" row with a per-provider table derived from §3 above; §12.2: add "router restart during outage" and "hub loss" rows; ADR-010 amended; new ADR-019 "Payments Edge placement"; R3 expanded with certification lead times.

### 7.3 Implementation plan

- Phase 1: F7 becomes "restaurant order entry + kitchen printing"; KDS web moves to M8a. Phase 1 target 14 weeks for pilot, 16 for exit.
- Sprint 0: add "supported devices and OS matrix" and "start Tyro certification" deliverables.
- Phase 2: M8 split into M8a/M8b; add M13 "Xero daily journal export"; M11 acceptance adds the offline-decline drill using Adyen test cards that enforce limits and Stripe's simulated offline reader.
- Phase 3: add "Shopify connector early" flagged against the Stocky retirement date, and "Store Hub failover".

### 7.4 Design plan

- Payment status panel: add "Declined after reconnect" and "Expired offline payment" states and the reopened-check banner.
- Floor plan and KDS: add the "KDS hub degraded, printing fallback active" banner.
- Copy guideline: never promise offline card acceptance.

---

## 8. Sources

Vendor documentation read directly: [Toast offline payments overview](https://doc.toasttab.com/doc/platformguide/platformOfflinePaymentsOverview.html), [Toast post-outage experience](https://doc.toasttab.com/doc/platformguide/platformPostOutage.html), [Toast offline mode support article](https://support.toasttab.com/article/Offline-Mode-Using-Toast-During-a-ISP-Outage), [Square offline payment time limits](https://squareup.com/help/gb/en/article/8106-offline-payments-time-limits), [Adyen offline payments](https://docs.adyen.com/point-of-sale/offline-payment), [Stripe Terminal: collect card payments offline (smart readers, Android)](https://docs.stripe.com/terminal/features/operate-offline/collect-card-payments.md?terminal-card-present-integration=terminal&reader-type=internet&terminal-sdk-platform=android), [Oracle Simphony shared services](https://docs.oracle.com/en/industries/food-beverage/simphony/19.5/simcm/c_shared_services.htm), [Tyro integrated EFTPOS](https://docs.integrated-eftpos.tyro.com/integrated-eftpos), [Clover offline payments](https://docs.clover.com/docs/handling-offline-payments).

Market and regulatory coverage (secondary): [NerdWallet Toast review](https://www.nerdwallet.com/business/software/reviews/toast-pos), [NerdWallet Toast vs Square](https://www.nerdwallet.com/article/small-business/toast-vs-square), [ExpertMarket Square vs Toast vs Lightspeed](https://www.expertmarket.com/pos/square-vs-toast-vs-lightspeed), [Lightspeed Restaurant pricing](https://www.lightspeedhq.com/restaurant//pricing), [Lightspeed KDS](https://www.lightspeedhq.com/restaurant/kitchen-display-system/), [Shopify POS pricing guide](https://www.stylefactoryproductions.com/blog/shopify-pos-pricing), [Prediko on Shopify POS and Stocky](https://www.prediko.io/blog/can-shopify-be-used-as-a-pos-system), [Oracle Xstore 2025 redesign](https://erp.today/oracle-brings-xstore-factor-to-retail-in-2025/), [Cleverence Xstore architecture guide](https://cleverence.com/articles/oracle-documentation/introduction-to-oracle-retail-xstore-pos-3947), [Square purchase orders](https://squareup.com/help/gb/article/6240), [Square retail features press release](https://squareup.com/us/es/press/new-retail-features-speed-customization), [Lightspeed Retail review](https://www.toolsforhumans.ai/ai-tools/lightspeed-retail), [Clover offline credit payments guide](https://shopkeep-support.lightspeedhq.com/support/advanced/offline-credit-payments), [Revel enterprise](https://hospitalitytech.com/revel-systems-adds-2-pos-systems), [Zeller POS launch](https://ecommercenews.com.au/story/zeller-launches-pos-app-to-challenge-square-in-australia), [DineOpen AU restaurant POS 2026](https://www.dineopen.com/blog/best-restaurant-pos-australia-2026), [Airwallex AU POS guide](https://www.airwallex.com/en-au/blog/best-pos-system-for-small-business), [CommBank on the surcharge ban](https://www.commbank.com.au/articles/newsroom/2026/08/commbank-reduces-fee-card-surcharging.html), [AP+ eftpos zero-surcharge](https://www.auspayplus.com.au/?p=8684), [HSF Kramer on the RBA review](https://www.hsfkramer.com/insights/2026-04/rba-releases-conclusions-of-its-review-of-merchant-card-payment-costs), [Cybrosys Odoo 18 kitchen display](https://www.cybrosys.com/blog/an-overview-of-odoo-18-kitchen-display-in-point-of-sale), [Odoo partners with Tyro](https://www.aap.com.au/aapreleases/cision20250714ae29376), [Stripe Terminal offline FAQ](https://support.stripe.com/questions/terminal-offline-mode-faq), [Stripe Terminal for POS partners](https://docs.stripe.com/extensibility/terminal-for-pos-partners).

Shipped artifact: official Docker image `odoo:18.0`, addons under `/usr/lib/python3/dist-packages/odoo/addons`, analysed with `rea-agents@6.5.0 analyze-javascript-application` (Evidence `ev_db4a01f0…81e`).
