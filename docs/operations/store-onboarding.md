# Store onboarding

Status: proposal. Step-by-step workflow for taking a merchant from signed agreement to trading, aligned with the F1 identity and enrollment flow ([releases/f1.md](../releases/f1.md)) and with the pilot onboarding guide that F10 must deliver ([03 §5 F10](../03-implementation-plan.md)). Labels: **[F1]** = the API step exists today; **[Proposed]** = depends on slices not yet built (F2–F9, M-slices). Device-level steps are in [device-provisioning.md](device-provisioning.md); hardware and network rules in [supported-devices.md](supported-devices.md); payment facts in [capability matrix](../payments/capability-matrix.md); threats in [threat-model.md](../security/threat-model.md).

## 1. Roles and responsibilities

| Step area | Platform operator | Tenant owner | Store manager | Installer | Provider |
| --- | --- | --- | --- | --- | --- |
| Profile and site decision (§2–§4) | advise | accountable | consulted | responsible (survey) | n/a |
| Tenant provisioning (§5) | responsible | accountable (accepts invite, MFA) | n/a | n/a | n/a |
| Structure and users (§6, §8) | support | accountable | responsible | n/a | n/a |
| Payments (§7) | support | accountable | responsible | responsible (terminals) | responsible (merchant account, certification) |
| Devices (§9) | n/a | n/a | responsible | responsible | n/a |
| Data load (§10) | support | accountable | responsible | n/a | n/a |
| Acceptance and go-live (§11) | support | accountable (sign-off) | responsible | responsible | n/a |

## 2. Choose the deployment profile

Profiles are in [01 §3](../01-system-architecture.md); the choice is stored on the location (`deploymentProfile`: `cloud_only`, `device_autonomous`, `store_hub`).

| Question | Answer → profile |
| --- | --- |
| One register, pop-up, internet is dependable and offline trading is not required | **A cloud_only**. Checkout requires connectivity; explicitly chosen, never the default |
| Retailer or cafe with 1–3 registers that must keep trading offline, no shared tables/KDS offline | **B device_autonomous**. Payments Edge runs on the register as a plugin |
| Full-service restaurant, several registers sharing open checks/tables, KDS, kitchen printing that must survive an outage | **C store_hub**. Requires a Hub (appliance or primary register), single store VLAN, M8a/M8b delivered |
| Offline card acceptance matters | Only for provider modes that support it (Adyen local/standalone, Stripe SDK/smart reader; Tyro, Linkly TCP/IP, Windcave unknown) — see [capability matrix §4](../payments/capability-matrix.md). The terminal decides; the merchant bears the decline risk |

Profile migration A → B → C needs no data migration, only enrollment ([01 §3](../01-system-architecture.md)). **Phase 1 pilots are online-mode stores** (profile A or B without offline sync: M1 ships after Phase 1, [03 §11](../03-implementation-plan.md)); promise offline only when the corresponding milestone is live.

## 3. Pre-onboarding: commercial, provider and survey

| # | Action | Notes |
| --- | --- | --- |
| 1 | Select payment provider(s) from the capability matrix and the merchant's economics (plan open decision 1) | Start provider onboarding **now**: Tyro certification is mandatory before production, Linkly and Windcave need accreditation, Adyen store-and-forward is enabled by Adyen Support ([03 §12](../03-implementation-plan.md)); lead times are `unknown` until Sprint 0 establishes them |
| 2 | Obtain the merchant's ABN, GST registration, trading names, location addresses, time zones, trading hours and **business-day cutoff** (day boundary) | Used for legal entities, receipts and business date |
| 3 | Site survey: internet service and failover, router, Wi-Fi, switch ports, power and UPS, counter and kitchen layout | Checklist in §4 |
| 4 | Inventory existing hardware against [supported-devices](supported-devices.md); order replacements | Unsupported items are listed in the plan, not silently accepted |
| 5 | Confirm tender and surcharge position: **surcharging is banned for eftpos, Mastercard and Visa from 1 October 2026**; configure nothing that adds a surcharge for those schemes ([capability matrix §5](../payments/capability-matrix.md), [ADR-020](../adr/ADR-020.md)) | Provider-side surcharge settings must be zero (Tyro retired it; Linkly rates in EFT-Client; Windcave host config) |
| 6 | Agree the staff list, roles, and who will be tenant owner and approvers | Used in §8 |

## 4. Network and site readiness

Required before any device is enrolled (checks E10, E11 in [supported-devices §9](supported-devices.md)).

- [ ] **Dedicated store VLAN or SSID** for POS, KDS, CFD, Hub, printers and terminals; **guest Wi-Fi and back-office PCs on another network** (threat T2.5, gap G-30). The single-subnet rule applies *inside* this VLAN only.
- [ ] Layer 2 single subnet; mDNS (UDP 5353) passes; Wi-Fi AP/client isolation is **off** on the store SSID; IGMP snooping configured if switches are managed.
- [ ] **DHCP reservations or static IPs** for the Hub, every printer and every terminal, outside the dynamic pool. Record them in the device list.
- [ ] Router, switch, access points and the Hub are on a **UPS**; the router does not reboot on schedule during trading.
- [ ] Wired Ethernet for the Hub, printers, KDS and terminals where cabling allows.
- [ ] Outbound allow-list (TCP 443 to the platform and provider endpoints, UDP 123 NTP) and **no inbound ports**.
- [ ] NTP reachable; time zone set on devices.
- [ ] Uplink meets the placeholder targets in [supported-devices §8.2](supported-devices.md); dual WAN or 4G failover is arranged for profile C.
- [ ] Printers, drawers, scanners and scales on site pass the spike-confirmed list.

## 5. Tenant provisioning (platform operator) [F1]

| # | Step | API / action | Result |
| --- | --- | --- | --- |
| 1 | Provision the tenant | `POST /v1/tenants` with an **operator** bearer token (interim `AUTH_OPERATOR_TOKENS` mechanism; operator login/IdP is open, threat G-26) | One transaction creates the tenant, root org unit, first admin user, audit entry and `tenant.provisioned` event; an invite is issued |
| 2 | First admin accepts the invite | `POST /v1/users/accept-invite` `{token, password}` | Password stored with Argon2id |
| 3 | First admin signs in | `POST /v1/auth/login` | Because the first admin holds `*.admin`/`finance.*` roles, response is `mfa_enrollment_required` with a 5-minute pre-auth token |
| 4 | Enroll MFA | `POST /v1/users/me/totp/enroll` (with the pre-auth token) then `…/totp/confirm`; complete the login with `POST /v1/auth/mfa/totp`; then, in the full session, **register a passkey as well** (`POST /v1/users/me/passkeys/options`, `POST /v1/users/me/passkeys`) | Full session with `mfa=true`; passkey available for later logins |
| 5 | Record the tenant slug | Slug is the prefix of every enrollment code | Given to installers |
| 6 | Record interim operator-token handling | Operator tokens are static secrets; store only in the operator's secret manager; rotate on staff change | Gap to be closed before pilot |

Interim rule (until the grant-ceiling gap G-19 is closed): **only the tenant owner grants roles with admin or finance permissions**; managers must not be given `access.assignment.grant` at tenant scope.

## 6. Structure setup [F1 API; admin console in F8]

| # | Step | API | Notes |
| --- | --- | --- | --- |
| 1 | Org units (company, brand, region, franchise group) | `POST /v1/org-units`, reparent with `POST /v1/org-units/:id/reparent` | Franchise boundaries: `kind = franchise_group` with the visibility flag |
| 2 | Legal entities (ABN, GST registration, receipt legal text) | `POST /v1/legal-entities` | Attach to org units or locations |
| 3 | Location | `POST /v1/locations` `{orgUnitId, legalEntityId?, code, name, kind, deploymentProfile, timezone, currency, locale?, businessDayBoundary?, address?}` | `kind`: store, restaurant, warehouse, central_kitchen, dark_store, popup. Location `status` starts at `onboarding`; it is set to `active` at go-live (§11) |
| 4 | Departments | `POST /v1/locations/:id/departments` | Optional |
| 5 | Registers | `POST /v1/locations/:id/registers` `{code, name, kind?, departmentId?}` | One register per physical till; code is printed in the offline order reference (`<register_code>-<seq>`) |
| 6 | Config entries | `PUT /v1/config` at tenant/org unit/location scope | Example: `identity.pin.max_attempts`, `identity.pin.window_seconds`, `identity.pin.lock_seconds`; nearest scope wins; changes are versioned and audited |
| 7 | Business day | `POST /v1/locations/:id/business-days/open` (F9 adds close/Z reports) | Needs `tenancy.business_day.open` |

## 7. Payments setup [Proposed: F5, M11]

| # | Step | Detail |
| --- | --- | --- |
| 1 | Create the provider account record and secrets (reference only; secrets go to Secrets Manager, the database holds `credentials_ref`) | Each provider has its own checklist in the [capability matrix](../payments/capability-matrix.md) |
| 2 | Register terminals: provider, model, **serial**, firmware, location | Required PCI physical inventory (threat AC-9e, G-24) |
| 3 | Confirm connection mode per store (local API, SDK, cloud) and what it implies for offline card | If the chosen mode has no offline card the UI must not offer it |
| 4 | Offline card decision (profile B/C, supported modes only): per-transaction cap, count and sum caps, expiry window, who handles declines (manager queue) | Caps are enforced by the Edge and by the provider; the merchant accepts decline and tamper risk (provider documentation) |
| 5 | Confirm surcharge is off for designated schemes | [capability matrix §5](../payments/capability-matrix.md) |
| 6 | Provider certification or go-live checklist complete (Tyro: certified build; Windcave: Certification Report; Linkly: accreditation matching POS name and version; Adyen: go-live checklist) | Production use is blocked until done |
| 7 | **Schedule terminal firmware updates outside trading hours** and agree who applies them | Offline eligibility depends on up-to-date firmware (Stripe: updated within 30 days; reader online within 24 h) |
| 8 | Test transactions in the provider's test environment, then a low-value live sale and refund at go-live | Part of §11 |
| 9 | Settlement and reconciliation: confirm the settlement file arrives and the merchant knows the daily process | M11 |

## 8. Users, roles and PINs [F1]

| # | Step | API | Notes |
| --- | --- | --- | --- |
| 1 | Invite staff | `POST /v1/users/invite` `{email, displayName}` | Staff set their password at `accept-invite` |
| 2 | Grant roles at the right scope | `POST /v1/role-assignments` `{userId, roleId, scope, validFrom?, validTo?, reason?, limits?}` | System roles shipped: `tenant_owner`, `admin`, `finance`, `store_manager`, `shift_supervisor`, `cashier`, `server`, `kitchen`, `readonly_auditor`; clone to customise; temporary elevation uses `validTo` |
| 3 | Set limits | Assignment-level limits, e.g. `orders.discount.max_percent`, `orders.refund.max_minor` | Over-limit actions create approval requests instead of failing |
| 4 | Set PINs per location | `PUT /v1/users/:userId/pin` `{locationId, pin}` | 4–8 digits; use unique PINs, never shared; managers' PINs also approve over-limit actions |
| 5 | MFA for privileged roles | Mandatory for roles with `*.admin` or `finance.*` | Encourage passkeys |
| 6 | Review who can issue device codes, revoke devices and grant roles | Permissions `devices.enroll`, `devices.revoke`, `access.assignment.grant` | See the threat model, AC-8 |

## 9. Device enrollment

Follow [device-provisioning.md](device-provisioning.md). Order: **Store Hub first** (profile C), then registers, KDS and CFD. Record each device in the onboarding sheet with kind, register, serial, IP address and who enrolled it.

## 10. Data load and configuration [Proposed: F2, F8]

| # | Item | Notes |
| --- | --- | --- |
| 1 | Tax classes and rules | Australian GST seed; confirm inclusive vs exclusive display |
| 2 | Catalog: categories, items, variants, barcodes, units, modifiers | CSV import with validation report; the downloadable error report must be zero before go-live |
| 3 | Menus, sections, availability (restaurants) | Menu resolver by (location, channel, time) |
| 4 | Price lists and promotions v1 | Preview uses the same engine as POS; promotion editing is privileged |
| 5 | Receipt templates, legal text, logo, reprint policy | ABN and tax invoice wording |
| 6 | Kitchen stations, routing rules, printers (profile C or kitchen printing) | Verify with test tickets |
| 7 | Cash drawer and float policy | M6 for detailed cash management |
| 8 | Opening stock (if inventory is on) | M2; until then stock is not tracked |

## 11. Go-live acceptance and reconciliation

### 11.1 Acceptance checklist (signed by tenant owner)

- [ ] Every device passed [device-provisioning §6](device-provisioning.md)
- [ ] Cash sale, card sale (live low-value), refund and void-with-approval completed and visible in the audit browser with actor, device and reason
- [ ] Receipts show ABN, tax breakdown and the terminal's receipt block; reprints are logged
- [ ] Profile B/C: internet unplug drill (cash sale offline, then sync with zero loss or duplicates); for profile C also Hub restart and router restart
- [ ] Offline card behaviour matches the configuration and the provider mode (caps set, copy honest) or offline card is off
- [ ] Business day opens and closes; X report matches the physical count of a test float
- [ ] Staff trained: PIN rules, approvals, what to do when the terminal shows an uncertain result ("Confirming with terminal…": wait, do not retry), where the manager queue is
- [ ] Security hygiene: guest Wi-Fi isolated, terminals inventoried, tenant owner has MFA and a passkey, no shared PINs
- [ ] Location `status` moved from `onboarding` to `active`; go-live date and approvers recorded

### 11.2 Reconciliation items to know on day one

| Situation | What the manager does |
| --- | --- |
| Device lost with unsynced offline sales | Expect cash variance in the Z report; list the missing sales from the paper trail and drawer count; raise a ticket ([device-provisioning §8](device-provisioning.md)) |
| Offline card payment later declined or expired | The check reopens; it appears in the manager's "Offline payments awaiting outcome" queue for re-collection, customer contact or write-off (M11) |
| `uncertain` payment | Platform queries the provider; manager sees it in the exceptions queue; no retry until terminal |
| Settlement difference | Resolve from reconciliation exceptions (M11) |

## 12. Hypercare (first two weeks, proposed)

Daily review of: devices offline, sync backlog, payment `uncertain` count, reconciliation exceptions, voids/refunds/discounts by user (baseline anomaly report, F9/F10), PIN lockouts, cash variance. Named contact on the platform side and on the merchant side; same-day response for payment and printing faults; weekly review of feedback with product.

## 13. Day-two changes

Add a register or KDS (new code, [device-provisioning](device-provisioning.md)); add a store (repeat §6–§9 reusing the org structure); change deployment profile (A → B → C by enrollment); staff turnover (disable user, revoke sessions, rotate PINs used on shared devices); price and promotion changes (audited, preview first); quarterly access review of who can grant roles, issue codes and revoke devices.

## 14. Offboarding or closing a location

1. Stop trading; close the final business day; export Z reports and data the merchant is entitled to.
2. Revoke every device of the location ([device-provisioning §8](device-provisioning.md)); wipe where the wipe command exists (G-15).
3. Move the location `status` to `closed` (then `archived`); disable users who only worked there.
4. Return or reset terminals with the provider; cancel merchant accounts if leaving.
5. Retention and erasure follow the tenant's policy (architecture §11, privacy row).
