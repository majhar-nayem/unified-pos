# Supported devices and OS matrix

Status: **PROPOSED**. This is the Sprint 0 deliverable "Supported devices and OS matrix" ([03 §4](../03-implementation-plan.md): *minimum OS versions (Windows, Android, iOS), terminal models and firmware, printers, scanners, scales, routers for Store Hub; published in docs/operations and enforced by device enrollment checks*). **Every row below is marked `Proposed` and stays that way until the Sprint 0 hardware spike (R1, [03 §4](../03-implementation-plan.md); [01 §15](../01-system-architecture.md)) and the Payments Edge spike (R11) confirm it on real devices.** Nothing here has been tested on hardware by the author. Model names are *candidates* chosen from common market practice or from vendor pages cited in the [capability matrix](../payments/capability-matrix.md); they are not endorsements and where no source was read the entry says `unknown`.

Related: [ADR-008](../adr/ADR-008.md) (Tauri), [ADR-011](../adr/ADR-011.md) (Store Hub), [ADR-019](../adr/ADR-019.md) (Payments Edge), [capability matrix](../payments/capability-matrix.md), [threat model](../security/threat-model.md) (G-02, G-12, G-30), [store onboarding](store-onboarding.md), [device provisioning](device-provisioning.md), [04 design plan](../04-design-plan.md).

## 0. Conventions

- **Status column:** `Proposed` (this document), `Confirmed` (after the spike; none today).
- **Enforced by:** the enrollment or heartbeat check in §9 that blocks or warns. A rule with no check is guidance only.
- **Device kinds** are the platform's `DEVICE_KINDS`: `pos`, `kds`, `cfd`, `handheld`, `kiosk`, `store_hub`, `admin_browser`. **Platforms** are `windows`, `android`, `ios`, `macos`, `linux`, `web` ([F1](../releases/f1.md)).
- **Spike scope:** the hardware spike covers Tauri 2 on **Windows and Android** only ([03 §4](../03-implementation-plan.md)). iOS and macOS rows have no spike and are placeholders for Phase 2 or later (plan open decision 3: target hardware profiles for GA).
- **Support policy language:** *supported* = tested in CI or lab, defects fixed; *best effort* = works if it passes the enrollment checks; *unsupported* = blocked at enrollment.

## 1. Operating system minimums

| Platform | Proposed minimum | Recommended | Rationale | Enforced by | Status |
| --- | --- | --- | --- | --- | --- |
| Windows (POS, KDS, CFD, Hub in register mode) | **Windows 11 22H2**; also **Windows 10 IoT Enterprise LTSC 2021** (vendor-supported to January 2032, *date to be re-verified*) for existing all-in-one POS hardware; consumer Windows 10 unsupported (end of servicing 14 October 2025) | Windows 11 24H2 | Tauri 2 needs the WebView2 runtime (evergreen); security-supported OS only | E3 | Proposed |
| Android (POS tablet, KDS, CFD, handheld later) | **Android 12 (API 31)** with current monthly security patch within 12 months | Android 14+ | Shopify announced Android 13+ from 2027 ([05 G8](../05-competitive-review-and-plan-critique.md)); Android 12 is the lowest the author proposes to carry; Play Services needed for attestation (G-12). Provider SDK minimums (Stripe, Adyen) are `unknown` here and must be read at spike time | E3, E5 | Proposed |
| iOS / iPadOS (POS, CFD later) | **iPadOS/iOS 17** | iPadOS/iOS 18 | Shopify requires iOS 18+ from 2027 ([05 G8](../05-competitive-review-and-plan-critique.md)). Tauri 2 iOS is not spiked; Tap to Pay on iPhone has its own minimum (`unknown`) | E3 | Proposed (no spike) |
| macOS (POS, back-office) | **macOS 13 Ventura** | macOS 14+ | Tauri 2 WKWebView; not spiked | E3 | Proposed (no spike) |
| Linux (Store Hub appliance only, never a register) | **Ubuntu Server 22.04 or 24.04 LTS, or Debian 12**, running the Hub as a container | Ubuntu 24.04 LTS | Hub is Node + SQLite in Docker ([01 §4](../01-system-architecture.md)); LTS with unattended security updates | E3 (Hub kind) | Proposed |
| Browser (admin console, CFD/kiosk web mode) | Current and previous major release of Chrome, Edge, Safari, Firefox | Latest | Next.js admin; CFD web fallback | n/a (web) | Proposed |

**Support lifecycle (proposed policy).** The matrix is reviewed each quarter; raising a minimum needs 90 days' notice in the admin console; devices below the minimum are warned for the notice period and then blocked from **new** enrollments only (an already-enrolled device is warned, never silently locked out mid-trade). The release kill-switch can pin devices to a previous app version ([03 §10](../03-implementation-plan.md)).

## 2. Register and display hardware profiles

| Profile | Form factor | Minimum hardware (proposed) | Notes | Status |
| --- | --- | --- | --- | --- |
| P-WIN | Windows all-in-one or tablet, 12–15" touch | 4-core x64, **8 GB RAM**, **128 GB SSD with ≥ 20 GB free**, 1080p, 10-point touch, wired Ethernet port, TPM 2.0 (for key protection) | First-class register; second display for CFD; serial/USB peripherals; best hardware access | Proposed |
| P-AND | Android tablet 10–13" | 8-core, **4 GB RAM**, 64 GB storage (≥ 10 GB free), USB-C host or OTG hub, Bluetooth 5, Play Services, up-to-date WebView | Local SQLCipher store is small; USB printing and scanner need host mode; Bluetooth permissions vary by OS version | Proposed |
| P-IOS | iPad 10th gen or later | A14 or newer, 64 GB | Bluetooth printing needs vendor SDK (MFi); USB peripherals via docks only; no spike | Proposed (no spike) |
| P-KDS | Wall-mounted touch screen, Windows or Android | 15.6" or larger, 1080p, wired Ethernet or PoE, kitchen-rated (splash, temperature), anti-glare | Connects to Hub (preferred) or Cloud; printer fallback if screen drops ([01 §7.6](../01-system-architecture.md)) | Proposed |
| P-CFD | Second window on register, or small Android tablet | 8–10" display, fixed mount | Second-window mode in F6; remote tablet CFD pairs through Hub (M8a+) | Proposed |
| P-KIOSK | Self-order kiosk | Out of scope until Phase 2/3 (QR/kiosk ordering) | `kiosk` kind exists in the enum | Proposed (not planned in Phase 1) |
| P-HH | Handheld (React Native) | Phase 3 | Out of scope here | Proposed (not planned) |

Hardware is **shared-use by staff**; local storage encryption (SQLCipher, key in keychain/Keystore) is required on every profile ([01 §8.1](../01-system-architecture.md)). Devices without a hardware-backed keystore (Android) or TPM (Windows) are *best effort* and flagged in the admin console (threat T1.2, G-11).

## 3. Payment terminals and firmware policy

| Provider | Terminal models | Connection | Firmware policy (proposed) | Source / evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Stripe Terminal (AU) | Smart readers: BBPOS WisePOS E, Stripe Reader S700, S710, T600; mobile: BBPOS WisePad 3; Tap to Pay on iPhone and Android; Verifone V660p, UX700, P630 are **private preview** in AU | Smart readers over LAN/internet via SDK; mobile via Bluetooth/USB | Stripe pushes updates. Offline-eligibility rule: reader connected online within **24 h** on the same LAN and updated within **30 days**; WisePad 3 in AU needs `4.01.07.00_Prod_APAC1_on_v28_491001` or later; eftpos needs SDK iOS ≥ 2.20.0, Android ≥ 2.20.0, React Native ≥ 0.0.1-beta.12 | [capability matrix §3.2](../payments/capability-matrix.md) S6, S9, S23 | Proposed |
| Adyen | `unknown` (AU terminal list not read); local Terminal API requires terminal IP, port 8443, DHCP reservation or static IP, Adyen root certificate in the app | LAN (local), internet (cloud) | Adyen manages firmware; platform records version via `TerminalAdapter.health()` | [capability matrix §3.1](../payments/capability-matrix.md) S5 | Proposed |
| Tyro | `unknown` (Tyro terminal models not read) | iClient over LAN; certification mandatory | Tyro-managed; certification binds the build | [capability matrix §3.3](../payments/capability-matrix.md) S10, S14 | Proposed |
| Linkly | `unknown` (PINpad models are provisioned through Linkly and the acquirer; not read) | Linkly EFT-Client / Cloud; Core Payments TCP/IP | Linkly/acquirer-managed; POS name and version must match the accreditation | [capability matrix §3.4](../payments/capability-matrix.md) S15 | Proposed |
| Windcave | HIT-enabled (host-integrated) terminals only; standalone terminals do not work; Tupelo terminals for the XML interface | HIT over HTTPS | Windcave-managed; terminals must be enabled for HIT and tipping by Windcave | [capability matrix §3.5](../payments/capability-matrix.md) S18, S20 | Proposed |

**Platform firmware policy (proposed):**
1. Firmware is provider-managed; the platform never installs firmware. It **reads** model, serial and firmware from the adapter `health()` result into `devices.peripherals` (`kind = payment_terminal`, `make_model`, `capabilities`, `settings`).
2. A per-provider minimum-firmware table lives in configuration; below minimum a terminal is `status = error` and **offline card eligibility is withdrawn** (the Edge disables store-and-forward) until updated.
3. Terminal firmware updates should not be applied during trading hours; the onboarding doc asks merchants to schedule them ([store onboarding §7](store-onboarding.md)).
4. The terminal serial number and location are recorded at onboarding for PCI physical-inspection inventory (threat model AC-9e, G-24).

## 4. Receipt, kitchen and label printers

| Class | Protocol / driver (`peripherals.driver`) | Candidate models (unverified) | Connection | Requirements | Status |
| --- | --- | --- | --- | --- | --- |
| Thermal receipt, ESC/POS | `escpos` | Epson TM-T20III, TM-T82III, TM-T88VI, TM-m30 series; Bixolon SRP-350 series | USB, Ethernet (TCP 9100), Bluetooth (model dependent) | 80 mm paper, auto-cutter, drawer-kick port (RJ11), UTF-8 or supported code page, QR support, status feedback (paper out, cover open) | Proposed |
| Thermal receipt, Star Line mode | `star_line` | Star TSP100 series, TSP143IV, mC-Print3, mPOP | USB, Ethernet, Bluetooth, (Lightning/BLE on iOS via Star SDK) | same as above; Star line mode, not StarPRNT-only | Proposed |
| Kitchen impact printer | `escpos` | Epson TM-U220 (dot matrix, red/black) | Ethernet | Heat-tolerant; audible alert; network, static IP | Proposed |
| Label printer | `zebra_zpl` | Zebra ZD series | USB, Ethernet | Phase 2 retail labels | Proposed |

Rules (proposed): printer IPs are **static or DHCP-reserved outside the dynamic pool**; every receipt printer has the cash-drawer kick tested (drawer is kicked through the printer, [05 §4.5](../05-competitive-review-and-plan-critique.md)); kitchen printers are routed per station and printer fallback applies when a KDS misses heartbeats ([01 §7.6](../01-system-architecture.md)). Bluetooth printing from iOS needs vendor SDKs and is a **risk to validate**, not a promise. Network printers accept unauthenticated jobs, so they belong on the store VLAN (threat T2.6). The spike must test: USB and network print from Tauri on Windows and Android, drawer kick, status feedback.

## 5. Barcode scanners

| Type | Interface | Candidate models (unverified) | Configuration | Status |
| --- | --- | --- | --- | --- |
| 1D/2D wired | USB HID keyboard wedge | Zebra DS2208, Honeywell Voyager 1450g, Datalogic QuickScan | Suffix Enter (CR), UK/AU layout, 2D enabled for QR/GS1 | Proposed |
| 1D/2D wireless | Bluetooth HID or 2.4 GHz cradle | Honeywell Voyager 1472g, Zebra DS2278 | Cradle with USB HID preferred; Bluetooth pairing is per device | Proposed |
| Built-in camera | OS camera API | Tablets and phones | Fallback only, not for counter throughput | Proposed |

Target: scan to line < 100 ms local ([03 §5 F6](../03-implementation-plan.md)); the F6 shell must treat HID input as events independent of focused input (spike item). SPP (serial profile) scanners are unsupported.

## 6. Scales

| Type | Interface | Notes | Status |
| --- | --- | --- | --- |
| Bluetooth scale | BLE/Classic serial, vendor protocol | A spike item (R1: "Bluetooth scale"); vendor and protocol `unknown` | Proposed |
| USB/serial counter scale | USB-serial (CDC), RS-232 | Protocols vary by vendor; list to be fixed by the spike | Proposed |

**Regulatory note (unverified):** scales used for sale by weight in Australia generally need to be pattern-approved/verified under trade measurement rules (National Measurement Institute); confirm before the platform lists a scale as supported for retail weight sales.

## 7. Customer-facing display, drawers, other peripherals

| Peripheral | Support | Status |
| --- | --- | --- |
| CFD as second window on the register (Windows/Android dual display) | Supported target in F6 | Proposed |
| CFD as separate tablet via the Hub | M8a or later; needs Hub pairing | Proposed |
| Pole display (serial VFD) | Unsupported in v1 | Proposed |
| Cash drawer via printer RJ11 kick (ESC/POS pulse) | Supported; 12 V or 24 V per drawer and printer | Proposed |
| USB cash drawer | Unsupported in v1 | Proposed |
| RFID readers | `rfid_reader` kind exists; out of scope for Phase 1 | Proposed |

## 8. Store Hub hardware and network requirements

### 8.1 Store Hub hardware

| Item | Proposed requirement | Status |
| --- | --- | --- |
| Packaging | Dedicated appliance **or** "primary register in hub mode" (plan open decision 4). Appliance recommended for profile C stores with KDS | Proposed |
| Appliance spec | x86-64, 4 cores, **8 GB RAM**, **128 GB SSD** (industrial or enterprise-grade), **wired Gigabit Ethernet**, TPM 2.0 or equivalent for disk key, fanless preferred, UPS-backed | Proposed |
| OS | Ubuntu Server LTS or Debian 12, automatic security updates, full-disk encryption, SSH disabled by default or key-only via the vendor channel | Proposed |
| Power | Hub, router and PoE/AP **on UPS** (router restart during an outage breaks printing until the ISP returns, [05 G7](../05-competitive-review-and-plan-critique.md)) | Proposed |
| Unsupported until tested | ARM single-board computers, Wi-Fi-only Hubs, Hub on a shared back-office PC | Proposed |
| Failover | Single Hub in Phase 2; failover (secondary hub or primary-register takeover) is Phase 3 ([03 §7](../03-implementation-plan.md)) | Proposed |

### 8.2 Network requirements

| Requirement | Detail (proposed) | Why | Status |
| --- | --- | --- | --- |
| Single subnet (Layer 2) | POS, KDS, CFD, Hub, printers and terminals share one IPv4 subnet and VLAN; no routed hops between them | mDNS discovery and one-to-one protocol; Toast has the same rule ([05 G7](../05-competitive-review-and-plan-critique.md)) | Proposed |
| Dedicated store VLAN/SSID | The above subnet is **separate from guest Wi-Fi and back-office PCs** (threat T2.5, G-30) | One-subnet rule must not mean exposure to customers | Proposed |
| mDNS | Multicast UDP 5353 allowed; **AP/client isolation off**; IGMP snooping configured for multicast on managed switches; service `_unifiedpos._tcp` | Hub discovery ([01 §4.1](../01-system-architecture.md)) | Proposed |
| Static-address fallback | Hub has a **DHCP reservation or static IP**; devices store the last known Hub address and an admin-configured static address; printers on static or reserved IPs outside the DHCP pool; terminals reserved too (Adyen recommends DHCP reservation/static IP for local mode) | Devices keep working if mDNS or the router DHCP restarts ([01 §12.2](../01-system-architecture.md)); Adyen S5 | Proposed |
| Router | Business-grade router/firewall with DHCP reservations, VLAN support, NTP, no UPnP dependency, local DHCP and DNS that survive WAN loss; the **platform does not require the vendor's router** (Toast refuses support on non-vendor routers: do not copy that) | [05 G7](../05-competitive-review-and-plan-critique.md) | Proposed |
| Wi-Fi | Wi-Fi 5 or 6 APs with site survey; **wired Ethernet for Hub, printers, terminals, KDS where possible**; 5 GHz preferred | Reliability | Proposed |
| Uplink | ≥ 10 Mbps down / 5 Mbps up per store, latency to ap-southeast-2 < 150 ms typical; dual WAN or 4G failover recommended for profile C (*figures are placeholders until the load model exists*) | Sync and catalog burst at open ([03 §9](../03-implementation-plan.md)) | Proposed |
| Outbound allow-list | TCP 443 to the platform API and sync; provider endpoints per [capability matrix](../payments/capability-matrix.md) (Adyen cloud/local certificate hosts, Stripe, Tyro, Linkly cloud `pos.cloud.pceftpos.com:443`, Windcave HIT); UDP 123 NTP; no inbound ports from the internet | Least privilege; Linkly cloud host from vendor terms | Proposed |
| LAN ports | Adyen terminal TCP 8443; ESC/POS printers TCP 9100; Hub HTTPS (port to be fixed by the Hub design) | Internal | Proposed |
| Time | Time synced by NTP on all devices; skew check at enrollment | HLC, business date, offline expiry | Proposed |

## 9. Enrollment-time and heartbeat checks that enforce the matrix

Today the enrollment API (`POST /v1/auth/device/enroll`) takes `enrollmentCode`, `publicKey`, `name`, `platform`, `appVersion` ([F1](../releases/f1.md), `DeviceEnrollRequestSchema`). **Only the code, key and basic fields exist today**; every check below is **proposed** and needs contract and client work (F6 by S-F6a, F8 by S-F8, config keys by the integration lead). Results are written to `devices.health` / `devices.settings` and `devices.peripherals`, which already exist in the schema.

| Id | Check | Data source | Outcome | Owner slice | Status |
| --- | --- | --- | --- | --- | --- |
| E1 | Enrollment code valid, unused, unexpired; kind matches device kind | server (exists: `FOR UPDATE` consume, 15 min TTL) | block | F1 (done) | Implemented in F1 (not part of the matrix itself) |
| E2 | `platform` is supported for the `kind` (for example `store_hub` only `linux` or `windows`) | `platform` in request (exists) | block | F6 | Proposed |
| E3 | OS version ≥ minimum in §1 | **new field** `osVersion` (and `model`, `webviewVersion`) in the enroll request | block for new enrollments, warn for enrolled | F6 + contracts | Proposed |
| E4 | App version ≥ server-published minimum, and not on the kill-switch list | `appVersion` (exists) + config | block | F6, S-INFRA | Proposed |
| E5 | Secure storage: SQLCipher key created and stored in keychain/Keystore/TPM; hardware-backed flag recorded | client attestation in request | warn if software-only | F6 (G-11) | Proposed |
| E6 | Platform attestation passes (Play Integrity, App Attest), root/jailbreak signal | attestation token verified server-side | block or warn per tenant policy | F6 (G-12) | Proposed |
| E7 | Free storage ≥ minimum in §2 | client | warn at < threshold; block new enrollment below | F6 | Proposed |
| E8 | Clock skew versus server `Date` | client + server | warn > 2 min, block > 5 min | F6 | Proposed |
| E9 | Time zone equals the location's | client + location | warn | F6 | Proposed |
| E10 | Network preflight: device IP and mask put the Hub, printers and terminals in the same subnet; mDNS probe finds the Hub (if profile C); static fallback address reachable | client | block for profile C; warn for B | F6, M8a (G-30) | Proposed |
| E11 | Guest-network heuristic: SSID/VLAN name or gateway heuristics suggest a shared guest network; ask the installer to confirm the dedicated VLAN | client | warn with required confirmation recorded in audit | F6 (G-30) | Proposed |
| E12 | Printers reachable (TCP 9100 or USB present), **test print and drawer kick** succeed | client + installer | block for the receipt printer (profile with printing); warn otherwise | F6 | Proposed |
| E13 | Scanner test scan within 100 ms event timing | client + installer | warn | F6 | Proposed |
| E14 | Terminal reachable (TLS handshake or SDK connect), model on the supported list, firmware ≥ minimum, serial recorded | Payments Edge `health()` | block card tender if failing; warn otherwise | F5 + Edge spike (G-24) | Proposed |
| E15 | Offline-card eligibility: terminal and mode support store-and-forward and tenant has set caps | capability matrix + tenant config | enables the offline card option only when true | M11 | Proposed |
| E16 | Heartbeat re-checks E3, E4, E7, E8, E14 and reports drift; below minimum shows a banner and (after notice) blocks re-enrollment | `devices.health`, heartbeat | warn | F6, F8 | Proposed |

**Override policy (proposed):** a block can be overridden only by a user holding `devices.admin` (MFA session), with a reason; the override is audited and appears on the device record. Overrides expire after 30 days.

## 10. How `Proposed` becomes `Confirmed`

| Row group | Confirmed by | Where recorded |
| --- | --- | --- |
| Windows, Android minimums (§1) and profiles P-WIN, P-AND | Hardware spike (R1) on at least one device each: print USB and network, drawer kick, HID scan, Bluetooth scale | Update this file; spike report in `docs/releases/sprint-0.md` follow-up |
| Printers, scanners, scales (§4–§6) | Same spike; model list reduced to what passed | This file |
| Terminals and firmware (§3) | Payments Edge spike (R11) and R3 sandbox tests T1–T9 ([capability matrix §7](../payments/capability-matrix.md)); provider terminal lists obtained from the providers | This file and the capability matrix |
| Hub hardware and network (§8) | M8a lab with a 3-device, 1-KDS rig and the failure drills (internet cut 4 h, router restart) | This file |
| iOS and macOS | A Phase 2 spike (not scheduled) | This file |
| Enrollment checks (§9) | Implemented slice by slice; each check gets a test in F6/F8 | This file (status column) |
