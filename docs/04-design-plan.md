# Product Experience & Design Plan

Scope: design system, device classes, key screens with wireframes, interaction rules, accessibility, localization, and the design process that runs alongside the implementation plan.

---

## 1. Design principles (ranked)

1. **Speed of the common path.** A retail sale of N scanned items and a cash payment is N scans + 2 taps. A restaurant order of one item with required modifiers is ≤ 4 taps. Measure taps and seconds; design reviews cite them.
2. **State is always visible.** Connectivity, payment state (`processing`, `uncertain`), unsynced sales, kitchen ticket age, drawer open: all surfaced persistently, never only in a toast.
3. **Mistakes are cheap, fraud is expensive.** Undo for line edits; approval for voids, refunds, overrides; confirmation only for truly destructive actions.
4. **Role-specific screens.** Cashier, server, host, kitchen, expo, manager each get a home screen with only their verbs. Admin is a different product surface, not a bigger POS.
5. **Touch first, keyboard fast.** Every POS action reachable by touch with ≥ 48 px targets, and by keyboard/scanner for power users.
6. **Honest about offline and money.** "Recorded, not yet settled" is said in words. Never show a green tick for a payment that is not captured. Never promise offline card acceptance: the terminal decides, so copy reads "the terminal may approve offline, up to your limit".
7. **Operational over decorative.** Dashboards show what to act on; no vanity charts.

---

## 2. Device classes and layouts

| Class                       | Example hardware                               | Viewport    | Layout rule                                                                 |
| --------------------------- | ---------------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| Fixed terminal (retail/QSR) | 15.6" Windows all-in-one, landscape, 1920×1080 | ≥ 1366 wide | Two-pane: cart (left 38 %) + action area (right); bottom tender bar         |
| Tablet (restaurant/retail)  | 10–13" Android/iPad, landscape and portrait    | 800–1366    | Landscape as terminal; portrait stacks cart over grid with collapsible cart |
| Handheld                    | 6" Android with scanner, portrait              | 360–430     | Single column, bottom primary action, scan-first flows                      |
| Customer-facing display     | 10" second screen or tablet                    | 1280×800    | Read-only cart, totals, tip/sign prompts, loyalty opt-in                    |
| KDS                         | 21–27" landscape, often wall-mounted, bump bar | 1920×1080   | Ticket columns, 4–6 visible, big type (≥ 20 px), color by age               |
| Kiosk / QR ordering         | Portrait 32" or phone                          | any         | Guided single-task flow                                                     |
| Admin console               | Laptop/desktop                                 | ≥ 1280      | Sidebar nav, data tables, drawers for detail                                |

Breakpoints (CSS tokens): `--bp-handheld 480`, `--bp-tablet 800`, `--bp-terminal 1366`, `--bp-wide 1920`.

---

## 3. Design system (`packages/ui`)

### 3.1 Tokens

| Group         | Values                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spacing       | 4-pt grid: 4, 8, 12, 16, 24, 32, 48, 64                                                                                                                                                                                                                                                    |
| Touch targets | POS minimum 48×48, primary tender buttons 72 high, keypad keys 64×64, KDS bump area ≥ 96                                                                                                                                                                                                   |
| Type scale    | POS: 14 (meta), 16 (body), 20 (line item), 28 (totals), 40 (grand total). Admin: 12/14/16/20/24. KDS: 20 (modifiers), 24 (items), 32 (ticket header)                                                                                                                                       |
| Font          | System UI stack (SF/Segoe/Roboto) for speed and localization coverage; tabular numerals everywhere money appears                                                                                                                                                                           |
| Color roles   | `surface`, `surface-raised`, `text`, `text-muted`, `brand`, `success`, `warning`, `danger`, `info`, `offline`, plus **status palettes**: table (available/occupied/reserved/dirty/blocked), KDS age (fresh/aging/late/critical), payment (processing/authorized/captured/uncertain/failed) |
| Contrast      | AA minimum 4.5:1 text, 3:1 UI; status never conveyed by color alone (icon + label)                                                                                                                                                                                                         |
| Theming       | Light default for POS/admin, dark default for KDS (kitchen glare), tenant brand color constrained to accents and receipts                                                                                                                                                                  |
| Motion        | ≤ 150 ms, reduced-motion respected; no animation on the checkout critical path                                                                                                                                                                                                             |
| Density       | Admin tables have compact/comfortable toggle; POS has fixed density per device class                                                                                                                                                                                                       |

### 3.2 Component inventory (Storybook)

Primitives: Button (primary/secondary/danger/ghost, sizes incl. `tender`), IconButton, Keypad, Toggle, Segmented, Input, Search (with scanner capture), Select, Combobox, Checkbox, Radio, Badge/StatusPill, Tag, Tooltip, Toast, Dialog, Sheet/Drawer, Tabs, Table (virtualized), Card, EmptyState, Skeleton, Banner (offline/warning), Stepper.

POS composites: CartLine, CartSummary, ProductTile, ProductGrid (configurable pages), ModifierPicker, QuantityStepper, DiscountPanel, CustomerChip, TenderBar, PaymentStatusPanel, ReceiptPreview, ApprovalPrompt (manager PIN/passkey), SuspendedOrdersList, ConnectivityIndicator, SyncQueueBadge.

Restaurant composites: FloorPlanCanvas, TableTile, SeatSelector, CourseBar, CheckSplitter, TipPrompt, GuestCountPicker, OpenChecksList.

KDS composites: Ticket, TicketItem, StationHeader, AllDayCountBar, BumpBar mapping, RecallDrawer.

Admin composites: DataTable with saved views, FilterBar, DetailDrawer, AuditTimeline, ConfigDiff, BulkActionBar, ImportWizard, PromotionRuleBuilder, MenuScheduler, FloorPlanEditor.

---

## 4. Key screens

### 4.1 Retail checkout (fixed terminal, landscape)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ● Online  Store: Newtown  Reg 1  Cashier: Priya   Unsynced: 0   12:41        ☰  ?   │
├────────────────────────────────┬─────────────────────────────────────────────────────┤
│ CART (4 items)        Suspend ▾│ 🔍 Scan or search products…                  [F2]  │
│────────────────────────────────│─────────────────────────────────────────────────────│
│ Oat Milk 1L            2 × 4.50│ [Favourites] [Dairy] [Bakery] [Produce] [Drinks] ▸  │
│   PROMO 2-for-8          -1.00 │ ┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐ │
│ Sourdough Loaf         1 × 8.00│ │Sourdo..││Bagels  ││Croiss..││Banana  ││Coffee  │ │
│ Bananas 0.842 kg       @ 3.99  │ │ 8.00   ││ 6.50   ││ 4.80   ││ /kg    ││ 4.50   │ │
│   Weighed                 3.36 │ └────────┘└────────┘└────────┘└────────┘└────────┘ │
│ Coffee Beans 250g      1 ×14.00│ ┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐ │
│                                │ │ …      ││        ││        ││        ││        │ │
│ ┌ Customer: Alex T. ★ 1,240 pts│ └────────┘└────────┘└────────┘└────────┘└────────┘ │
│────────────────────────────────│─────────────────────────────────────────────────────│
│ Subtotal              33.86    │ [ Qty ] [ Discount ] [ Price ▲ ] [ Note ] [ Void ]  │
│ Discounts             -1.00    │ [ Customer ] [ Returns ] [ Gift card ] [ Lookup ]   │
│ GST (incl.)            2.99    │                                                     │
│ TOTAL                 32.86    │                                                     │
├────────────────────────────────┴─────────────────────────────────────────────────────┤
│ [      CASH  32.85      ] [      CARD  32.86      ] [ Split ] [ Other ▾ ]  Round -0.01│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Rules: scanner input is captured globally (no focus needed); last-added line highlighted 1.5 s; cash button pre-computes rounded amount and shows the rounding delta; tapping a cart line opens an inline action strip (qty/discount/price/void) rather than a modal; price override and void over the cashier's limit open ApprovalPrompt; quantities for weighed items show unit and scale status.

### 4.2 Payment status panel (all tenders)

```
┌──────────────────────────────────────────────┐
│ CARD  32.86                                   │
│ ◐ Waiting for terminal… (Tyro T2, Reg 1)      │
│   Present card on the terminal               │
│ [ Cancel on terminal ]                        │
└──────────────────────────────────────────────┘
→ states: Processing ◐ · Approved ✓ (captured) · Declined ✕ (reason, retry/other tender)
→ Uncertain ⚠ "Confirming result with provider… do not re-charge" → auto-resolves or "Call manager" after 60 s
→ Offline store-and-forward: "Approved offline — will be submitted when online" (amber, not green); card button label while offline: "Card (terminal may approve offline, up to limit)"
→ Forwarded and approved: amber turns to green on the check and in the manager queue, no staff action
→ Declined after reconnect: red banner on the check "Offline card payment declined by the issuer — check reopened"; the check moves to the manager queue "Offline payments awaiting outcome" with actions Collect again · Contact customer · Write off (approval)
→ Expired offline payment: same banner with "could not be submitted within the provider window" and the same actions; expiry is shown as a countdown on the unsynced-payments badge while the device is offline
→ Caps reached: card button disabled with "Offline limit reached (count/amount) — reconnect to continue taking cards"
```

### 4.3 Restaurant order entry (tablet, landscape)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ● Online (Hub)   Table 12 · 4 guests · Server: Marco · Opened 19:02 (23 min)   ☰     │
├──────────────────────────────┬───────────────────────────────────────────────────────┤
│ Seat ▸ [All] [1] [2] [3] [4] │ [Dinner menu] Starters · Mains · Sides · Drinks · Kids │
│ Course ▸ [1●] [2] [3] [+]    │ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐      │
│──────────────────────────────│ │ Burger   ││ Steak    ││ Risotto  ││ Fish     │      │
│ C1 S1 Burger (Lg)      18.00 │ │ 18.00    ││ 34.00    ││ 24.00    ││ 29.00    │      │
│      + Cheese, No onion  1.00│ └──────────┘└──────────┘└──────────┘└──────────┘      │
│      Side: Fries             │ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐      │
│ C1 S2 Risotto          24.00 │ │ …        ││          ││          ││          │      │
│ C2 S1 Brownie           9.00 │ └──────────┘└──────────┘└──────────┘└──────────┘      │
│ ── Sent 19:05 (Grill, Pass) ─│                                                       │
│ C1 S3 Fish        29.00  NEW │ Modifier flow (sheet):                                │
│                              │  Size*  [Reg] [Lg ●]       Side*  [Fries ●] [Salad]   │
│ Subtotal              81.00  │  Extras  [Cheese +1 ●] [Bacon +2] [Egg +1.5]          │
│ Service 10%            8.10  │  Remove  [Onion ●] [Pickle] [Sauce]                   │
│ TOTAL                 89.10  │  Note: ________________________   [ Add to order ]    │
├──────────────────────────────┴───────────────────────────────────────────────────────┤
│ [ SEND ▶ ]  [ Fire course 2 ]  [ Split / Pay ]  [ Transfer ]  [ Print bill ]  [ ⋯ ] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Rules: required modifier groups block "Add" with inline reason; price updates live as modifiers are chosen; "SEND" only enabled when there are unsent lines, and shows count; sent lines are locked with a "Void (manager)" affordance; seat and course chips are sticky filters.

### 4.4 Floor plan (host / server)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Floor: [Main ●] [Patio] [Bar]      Waitlist (3) · Reservations next: 19:30 ×2   ☰    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│   ┌────┐  ┌────┐   ┌──────┐       ╭────╮     Legend                                   │
│   │ 1  │  │ 2  │   │  3+4 │       │ 5  │     ▢ Available  ▣ Occupied 23m  ◪ Reserved  │
│   │ ▢  │  │ ▣18│   │ ▣ 41 │       │ ◪  │     ▤ Needs attention (bill asked / late)    │
│   └────┘  └────┘   └──────┘       ╰────╯     ◫ Dirty       ⊠ Blocked                 │
│                                                                                       │
│   ┌────┐  ┌────┐   ┌────┐  ┌────┐                                                    │
│   │ 6  │  │ 7  │   │ 8  │  │ 9  │     Tap table → actions sheet:                     │
│   │ ▤ 55│  │ ▢  │   │ ◫  │  │ ▣ 7 │     Seat party · Open check · Merge · Transfer ·  │
│   └────┘  └────┘   └────┘  └────┘     Mark clean · Reserve · Split party               │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Rules: table tile shows number, status glyph, minutes seated, and a small amount due when a bill has been printed; merge is drag table-to-table with confirmation; status never by color alone.

### 4.5 Kitchen display (station: Grill)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ GRILL   Open 7 · Late 1 · Avg 6:40   All-day: Burger 14 · Steak 6 · Fish 3    ● Hub │
├────────────────┬────────────────┬────────────────┬────────────────┬──────────────────┤
│ #231 T12  3:12 │ #232 TA  5:50  │ #228 T4  9:31 ⚠│ #233 T7  0:45  │ #234 DEL  0:10   │
│ Marco · 4 gst  │ Takeaway       │ Lena · 2 gst   │ Course 2 FIRED │ Uber Eats        │
│────────────────│────────────────│────────────────│────────────────│──────────────────│
│ 1 Burger Lg    │ 2 Burger Reg   │ 1 Steak MR     │ 1 Fish         │ 3 Burger Reg     │
│  + cheese      │  ALLERGY: nut  │ 1 Steak W      │  no lemon      │  1 no cheese     │
│  no onion      │ 1 Fish         │                │                │ 1 Steak M        │
│ 1 Fish         │                │                │                │                  │
│ [In progress]  │ [In progress]  │ [ READY ]      │ [Start]        │ [Start]          │
├────────────────┴────────────────┴────────────────┴────────────────┴──────────────────┤
│ Recall last ▲        Bump bar: 1-5 select · B bump · R recall · ← → page             │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Rules: ticket header color by age thresholds (configurable per station); allergy flags in high-contrast band; voided item strikes through with a red "VOIDED 19:12" line and audible alert; modification shows "UPDATED" badge with changed lines highlighted; a ticket cannot be removed, only bumped (recallable for N minutes). Connectivity banners: "● Hub" (normal), "KDS hub degraded — printing fallback active at Grill" (amber, shown on every POS and KDS in the location), "Cloud routing — hub unreachable" (amber), "Offline — tickets from this device only" (red, profile B).

### 4.6 Customer-facing display

Cart mirror with large totals, loyalty prompt ("Enter phone to earn points" with consent copy), tip selection (preset percentages + custom + none, no dark patterns: "No tip" is the same size), signature/PIN prompt handled by terminal, and "Payment approved / Thank you" with digital receipt QR.

### 4.7 Admin dashboard (store manager, today)

```
┌ Sidebar ┐┌──────────────────────────────────────────────────────────────────────────┐
│ Home    ││ Newtown · Today (Sydney) · data as of 12:41:05 ● live                   │
│ Orders  ││ Net sales 4,812.30 ▲12% vs last Tue │ Orders 212 │ Avg 22.70 │ Refunds 3  │
│ Catalog ││─────────────────────────────────────────────────────────────────────────│
│ Menus   ││ Needs attention                                                          │
│ Invent. ││ ⚠ 2 payments uncertain > 5 min (Reg 2)            [Open]                 │
│ Purch.  ││ ⚠ Reg 1 cash variance -42.50 awaiting approval    [Review]               │
│ Custom. ││ ⚠ 6 items low stock · 1 KDS offline (Dessert)     [View]                 │
│ Staff   ││─────────────────────────────────────────────────────────────────────────│
│ Reports ││ Sales by hour (bars)        │ Top items (table)   │ Payment mix (table)  │
│ Devices ││                             │                     │                      │
│ Settings││ Registers: R1 ● R2 ● R3 ○ offline since 11:58    Devices: 7/8 healthy     │
└─────────┘└──────────────────────────────────────────────────────────────────────────┘
```

Rules: "Needs attention" is first; every number is a link to its drill-down; freshness is explicit; comparisons state the baseline.

### 4.8 Retail inventory (admin + POS stock lookup)

Admin: variant table with on-hand/reserved/available per inventory location, movement ledger drawer (filter by reason, reference link), adjustment form with mandatory reason, count workflow (plan → count on handheld → review variances with thresholds → approve). POS: "Lookup" shows availability at this store and nearby stores with a "Reserve for pickup" action (Phase 3).

### 4.9 Handheld flows (Phase 3)

Line busting (scan → cart → hand off to register via QR), stock count (scan → quantity → next, offline-safe), stock lookup, table-side ordering (compact modifier sheet), pay at table (terminal pairing).

---

## 5. Interaction specifications

| Flow                                   | Budget                        | Notes                                                                    |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| Retail sale, N items, cash             | N scans + 2 taps (Cash, Done) | Done auto-advances after receipt choice if configured                    |
| Retail sale with card                  | N scans + 1 tap + terminal    | No confirmation dialog before sending to terminal                        |
| Attach customer                        | 1 tap + phone/scan + 1 tap    | Loyalty card scan attaches directly                                      |
| Manual discount within limit           | 2 taps + value                | Over limit → approval prompt, not failure                                |
| Void sent item                         | 2 taps + manager auth         | Reason required (configurable list)                                      |
| Restaurant item with 2 required groups | ≤ 4 taps                      | Defaults pre-selected where configured                                   |
| Split check by seat                    | 2 taps                        | Preview before confirming                                                |
| KDS bump                               | 1 tap / 1 key                 | Undo (recall) within window                                              |
| Open cash session                      | 1 tap + count                 | Blind count hides expected                                               |
| Offline transition                     | 0 taps                        | Banner + unsynced counter + offline-payment countdown; card button relabelled to "terminal may approve offline, up to limit" or disabled when caps are reached |
| Offline payment declined after reconnect | 1 tap to open the manager queue | Check is reopened automatically; actions Collect again · Contact customer · Write off (approval) |

Error recovery patterns: printer failure → "Reprint / Email / Skip" with the sale already complete; terminal disconnect → "Retry on terminal / Other tender / Check last result"; sync rejection → manager queue with both versions; app restart → resumes the exact order with "Recovered" banner.

Confirmation policy: confirm only for void after send, refund, cash paid-out, closing a session with variance, deleting configuration. Everything else is undoable or trivially re-doable.

Copy guideline for payments: never write "card payments work offline". Use "terminal may approve offline", show the tenant's cap and the remaining count, and show "pending" on receipts for offline-collected card payments (as Toast and Stripe require), with "settled" only after capture.

---

## 6. Accessibility requirements

- WCAG 2.2 AA for admin and POS web layers; large-text mode (×1.25) for POS without layout breakage.
- Full keyboard operation on POS (F-keys for tenders, arrows in cart, Enter to confirm, Esc to back) and admin.
- Screen reader support on admin (ARIA grid for tables, live regions for status); POS announces totals and payment state changes.
- Status with icon + text, never color alone; KDS has a high-contrast theme and a color-vision-safe age palette.
- Minimum target sizes as in tokens; spacing between destructive and primary actions ≥ 16 px.
- Reduced motion respected; no flashing above 3 Hz (KDS alerts use steady band + sound).
- Localization-ready: no text in images, RTL-safe layouts, ICU message format, currency/number/date via Intl with location locale.

---

## 7. Design process and deliverables

| Phase              | Weeks | Activities                                                                                                                                              | Deliverables                                                                                         |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Discovery          | 0–2   | 6 contextual inquiries (3 retail counters, 3 restaurant services), task analysis, competitive teardown of Xstore/Simphony/Square/Toast/Lightspeed flows | Journey maps for cashier, server, host, kitchen, manager, admin; top-20 tasks with current time/taps |
| Foundations        | 1–3   | Tokens, grid per device class, core components, naming, Storybook                                                                                       | `packages/ui` v0.1; design tokens JSON consumed by apps                                              |
| Flows & wireframes | 2–6   | Low-fi for F4–F9 screens; copy deck; error and offline states; approval patterns                                                                        | Clickable prototypes for checkout, order entry, KDS, admin catalog                                   |
| Usability round 1  | 6–7   | 8 participants (4 cashiers, 4 servers) on prototypes; measure time, taps, errors                                                                        | Findings; revised flows                                                                              |
| Hi-fi + handoff    | 7–12  | Components finalized, specs in Storybook with tokens, redlines in Figma, motion specs                                                                   | Design system v1.0; screen specs for Phase 1 slices                                                  |
| Pilot observation  | 12–16 | In-store observation at pilot sites, shift shadowing, log analysis (taps per sale, approval frequency)                                                  | Phase 2 design backlog                                                                               |
| Phase 2 design     | 16–32 | Floor plan editor, offline UX, cash management, split checks, KDS native, Store Hub setup flows, inventory counts on handheld                           | Updated system v1.x, usability round 2 (restaurant service simulation)                               |
| Phase 3 design     | 32+   | Enterprise admin (config rollout, franchise views), omnichannel order board, loyalty, analytics UX, kiosk/QR                                            | —                                                                                                    |

Success metrics tracked from pilot onward: median seconds per retail sale (target < 20 s excluding payment), taps per restaurant item (target ≤ 3), approval prompts per 100 orders, voids per 100 orders, cashier onboarding time to unsupervised operation (target < 2 h), SUS ≥ 80 for POS, task success ≥ 95 % on top-20 admin tasks.

---

## 8. Design-to-engineering contract

- Tokens live in `packages/ui/tokens/*.json` and are the only source of color/spacing/type in every app; lint forbids raw hex.
- Each screen spec lists: states (loading, empty, error, offline, permission-denied, approval-needed), responsive behavior per device class, keyboard map, telemetry events, and the permission keys that gate each action.
- Components ship with Storybook stories for every state and an axe check; visual regression via Chromatic or Playwright snapshots.
- Copy is in ICU message catalogs from day one (`en-AU` base), reviewed by the designer; receipt and KDS copy have their own catalogs.
