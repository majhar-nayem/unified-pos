# Device provisioning

Status: proposal aligned with the **F1 enrollment-code flow** as implemented in `apps/api` (see [releases/f1.md](../releases/f1.md)). Steps marked **[F1]** exist in the API today; steps marked **[Proposed]** depend on slices not yet built (F5, F6, F8, M1, M8a) and are not implemented. Store-level steps are in [store-onboarding.md](store-onboarding.md); hardware and OS rules in [supported-devices.md](supported-devices.md); threats in [threat-model.md](../security/threat-model.md).

## 1. Principles

1. **A device is a principal.** It has an Ed25519 key pair generated on the device and an `enrolled` record bound to one tenant and one location (and optionally one register). It authenticates by signing a server nonce, never with a shared secret.
2. **Enrollment codes are bearer secrets with a short life.** One-time, 15 minutes, bound to location, register and device kind, issued by someone holding `devices.enroll` at that location.
3. **Staff identity is separate from device identity.** A staff member signs in on an enrolled device with a per-location PIN; the resulting `pos` session is bound to that device.
4. **Revocation is immediate enough and always audited.** Revoke kills sessions; device tokens are re-checked against enrollment status with a 60 s cache.
5. **A device never talks to another device.** It talks to the Store Hub if the location uses profile C, else to the cloud ([01 §3](../01-system-architecture.md)).

## 2. Roles

| Role | Does |
| --- | --- |
| Store manager / admin | Issues codes (`devices.enroll`), views devices (`devices.view`), revokes (`devices.revoke`) in the admin console or API |
| Installer | Prepares hardware, enters codes on devices, runs preflight and peripheral tests |
| Staff | Signs in with PIN after enrollment |
| Platform operator | No role in routine provisioning |

## 3. Enrollment flow

```mermaid
sequenceDiagram
  autonumber
  participant Adm as Admin (console/API)
  participant Dev as Device app
  participant API as Cloud api
  Adm->>API: POST /v1/devices/enrollment-codes {locationId, registerId?, kind}
  API-->>Adm: {code "<tenant-slug>.<12 chars>", expiresAt (+15 min)}
  Adm->>Dev: code handed over (read aloud or typed, not photographed)
  Dev->>Dev: generate Ed25519 key pair in secure storage; run preflight (E1..E14)
  Dev->>API: POST /v1/auth/device/enroll {enrollmentCode, publicKey, name, platform, appVersion}
  API-->>Dev: {device (status enrolled), tokens}
  loop every login
    Dev->>API: GET /v1/auth/device/challenge → {nonce (60 s, single use)}
    Dev->>API: POST /v1/auth/device/login {tenantId, deviceId, nonce, signature over "nonce.deviceId.tenantId"}
    API-->>Dev: device token (24 h)
  end
  Dev->>API: POST /v1/auth/pin {userId, pin} with device token
  API-->>Dev: pos session (60 min, refresh 14 h, bound to device)
```

### Step by step

| # | Step | Who | Detail | Status |
| --- | --- | --- | --- | --- |
| 1 | **Check eligibility** | Installer | Device meets [supported-devices §1–§2](supported-devices.md); app installed from the signed channel (internal → pilot → general track, [03 §10](../03-implementation-plan.md)); network per [supported-devices §8](supported-devices.md) | Guidance |
| 2 | **Decide the kind and register** | Manager | `kind` is one of `pos`, `kds`, `cfd`, `handheld`, `kiosk`, `store_hub`, `admin_browser`. A `pos` device is bound to a register (`registerId`); KDS, CFD and Hub are location-level | [F1] kinds and optional `registerId` |
| 3 | **Issue the code** | Manager | `POST /v1/devices/enrollment-codes` `{locationId, registerId?, kind}`. Requires `devices.enroll` at the location; audited as `devices.enrollment_code.issued`. Code format `<tenant-slug>.<12 Crockford base-32 characters>` (about 60 bits of randomness), stored in full, TTL **15 minutes**. The admin UI should display it once, with a countdown, and mask it afterwards (threat G-14). To revoke an unused code there is no endpoint yet | [F1] issue; UI in F8 (**Proposed**) |
| 4 | **Install and open the app; choose "Enroll"** | Installer | Enter the code. The slug before the dot lets the device find its tenant before it has a token | [F1] server side; client in F6 |
| 5 | **Preflight on the device** | Device | OS and app version, secure storage and key creation, clock skew, storage, network (same subnet as Hub/printers/terminals, mDNS probe, static fallback), guest-network confirmation, attestation; results shown to the installer and sent with enrollment. Blocks and warnings are in [supported-devices §9](supported-devices.md) | **Proposed** (new request fields needed: `osVersion`, `model`, attestation) |
| 6 | **Generate the key pair** | Device | Ed25519 in OS keychain/Keystore/TPM where available; the private key never leaves the device. The public key is sent as base64 raw 32 bytes or SPKI DER | [F1] server accepts both |
| 7 | **Enroll** | Device | `POST /v1/auth/device/enroll` with `enrollmentCode`, `publicKey`, `name`, `platform` (`windows`, `android`, `ios`, `macos`, `linux`, `web`), `appVersion`. Server resolves the tenant from the slug, locks the code row, rejects used/expired/unknown codes with one deliberately uniform 404 ("Enrollment code is invalid, used or expired"), creates the device (`enrollment_status = enrolled`), stamps the code `used_at` and `used_by_device_id`, audits `devices.enrolled`, emits `device.enrolled`, and returns device plus tokens | [F1] |
| 8 | **Learn the Hub identity** | Device | For profile C: the enrollment response (or a first config sync) delivers the Hub's certificate public key, which the device **pins**; discovery only supplies an address. A device never trusts a service because it answered mDNS | **Proposed** (G-01, M8a) |
| 9 | **Initial sync** | Device | Bootstrap snapshot of catalog, config, employees (PIN hashes), customer subset; then feed by cursor ([01 §8.2](../01-system-architecture.md)) | **Proposed** (F6/M1) |
| 10 | **Peripherals and terminal** | Installer | Add and test each peripheral; record in `devices.peripherals`; pair the terminal (see §5) | **Proposed** (F6/F5) |
| 11 | **Set staff PINs** | Manager | `PUT /v1/users/:userId/pin` `{locationId, pin}` (4–8 digits; permission `identity.pin.set`), per location. Lockout settings come from config keys `identity.pin.max_attempts` (5), `identity.pin.window_seconds` (900), `identity.pin.lock_seconds` (900) | [F1] |
| 12 | **Acceptance test on the device** | Installer + manager | Checklist in §6 | Guidance |

### Device login and session lifetimes (F1)

| Token | Lifetime | Notes |
| --- | --- | --- |
| Device token | 24 h | Stateless; re-checked against `enrollment_status` (cached 60 s); obtained by signing the challenge |
| Challenge nonce | 60 s | Single use (`GETDEL`), message signed is `${nonce}.${deviceId}.${tenantId}` |
| `pos` session after PIN | 60 min, refresh 14 h | Bound to the device; refresh rotation with reuse detection |
| Lockouts | per user per location (config) and 50 failed PINs per 15 min per device | Alerts for lockouts are proposed (F10) |

## 4. Store Hub provisioning (profile C)

Hub is enrolled as a device of kind `store_hub` **first**, before registers and KDS, so the Hub address and certificate can be delivered to every later enrollment.

| # | Step | Detail |
| --- | --- | --- |
| 1 | Prepare hardware per [supported-devices §8.1](supported-devices.md); set static IP or DHCP reservation; place on the store VLAN; connect to UPS | |
| 2 | Issue a code with `kind = store_hub` (location-level) and enroll as above; the Hub runs Node + SQLite and advertises `_unifiedpos._tcp` | Hub itself is delivered in M8a; until then this section is a design target |
| 3 | The Hub creates its key and TLS certificate on first run; the public key is registered with the cloud at enrollment and distributed to devices at their enrollment | **Proposed** (G-01) |
| 4 | Verify from a register: discovery finds the Hub, static fallback address works, TLS pin matches, and a kitchen ticket reaches a test printer | |
| 5 | Run the failure drills as acceptance: internet cut for four hours, router restart, Hub unplug ([03 §6 M8a](../03-implementation-plan.md)) | |

Variant: "primary register in hub mode" repeats the same, with the register app in Hub mode (open decision 4). Payments Edge on the Hub arrives with M8b.

## 5. Peripherals and terminal pairing

| Item | Procedure | Recorded as |
| --- | --- | --- |
| Receipt printer | Select driver (`escpos` or `star_line`), connection (USB, network, Bluetooth), address; **test print and drawer kick** | `peripherals` row: `kind = receipt_printer`, `driver`, `connection`, `address`, `status` |
| Kitchen printer | As above; map to a kitchen station | `kind = kitchen_printer` |
| Scanner | Scan a test code; check Enter suffix and speed | `kind = scanner` |
| Scale | Pair and read a test weight (retail weight sales need approved scales, see [supported-devices §6](supported-devices.md)) | `kind = scale` |
| CFD | Second window or remote tablet | `kind = customer_display` |
| Terminal | Pair according to provider: Adyen local needs terminal IP, port 8443, Adyen root certificate; Stripe reader registered to the location and connected via SDK; Tyro iClient pairing per Tyro guide; Linkly/Windcave per provider. Record **serial number, model, firmware** and the person who inspected it (PCI 9.5 inventory) | `kind = payment_terminal`, `make_model`, `capabilities` |

The Payments Edge (a Tauri plugin on the register for profile B, a Hub module for profile C, [ADR-019](../adr/ADR-019.md)) owns terminal communication. Terminals are never given more network access than the store VLAN needs.

## 6. Device acceptance checklist

Every item must pass; a failed item is fixed or the override policy of [supported-devices §9](supported-devices.md) is used with a recorded reason.

- [ ] Device record shows `enrolled`, correct location, register and kind; app and OS versions are above minimum
- [ ] Device login by challenge works after an app restart; clock skew is within limits
- [ ] A test staff member signs in by PIN; wrong PIN lockout behaves as configured
- [ ] Catalog and config are present locally; last-updated banner shows a current time
- [ ] Scan → line add is visibly instant; test sale with cash completes; receipt prints and drawer opens
- [ ] Terminal sale with a test or low-value real card completes; terminal receipt text is stored; refund tested
- [ ] Airplane-mode drill for profile B/C: cash sale completes offline and syncs; card behaviour is as the capability matrix says for the provider and mode (the screen must not promise offline card unless enabled)
- [ ] Kitchen ticket reaches the right station (profile C) or printer; printer fallback tested
- [ ] Revoking the device in the admin console makes the device refuse new sessions within about a minute

## 7. Day-two operations

| Event | Procedure | Notes |
| --- | --- | --- |
| App update | Signed bundle by staged rollout per tenant; kill-switch can pin a version | [03 §10](../03-implementation-plan.md) |
| Replace a failed device | Enroll the replacement with a new code and the same register; **revoke** the old device | Keys never move between devices |
| Move a device to another location | Revoke and re-enroll; there is no transfer | Prevents carrying cached data across locations |
| Staff leaves | Disable user (`identity.user.manage`), revoke sessions (`DELETE /v1/users/:userId/sessions`), PINs are per location | |
| Terminal firmware update | Schedule outside trading; check firmware stays above the minimum or offline card is withdrawn | [supported-devices §3](supported-devices.md) |
| Router or Wi-Fi change | Re-run the network preflight (E10, E11) | |
| Lost or stolen device | §8 | |

## 8. Revocation, loss and theft

1. **Revoke immediately:** admin console or `POST /v1/devices/:deviceId/revoke` with a `reason`. The API sets `enrollment_status = revoked`, stamps `revoked_at`, **revokes all active sessions of that device** (`revoke_reason = device_revoked`), audits `devices.revoked` with before/after, emits `device.revoked`, and clears the status cache. Existing device tokens stop working once the 60 s cache expires (the device is checked on use).  **[F1]**
2. **Remote wipe:** the architecture says a wipe command is delivered on next contact ([01 §8.4](../01-system-architecture.md)) and the data model has `wipe_requested_at` and status `wiped`, but the F1 API has **no wipe endpoint** (threat G-15). Until it exists, the local database is protected only by SQLCipher and the keychain/Keystore key. Treat a lost device that was never wiped as a data exposure to be assessed.
3. **Unsynced commands on the lost device:** commands recorded offline and not yet uploaded are lost with it; their sales appear in the cash drawer and Z report as variance. Managers must reconcile ([store-onboarding §11](store-onboarding.md)).
4. **Offline card payments queued on a lost register:** the Edge queue is on the device; outstanding forward outcomes can only be recovered from provider reports. Raise with the provider (Adyen retries for one month; Stripe readers hold payments on the reader) ([capability matrix §4](../payments/capability-matrix.md)).
5. **Review:** check recent audit entries for the device (`devices.*`, sessions, voids/refunds), rotate the staff PINs that were used on it, record the incident.

## 9. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Enrollment says "invalid, used or expired" | Wrong slug or characters, code already used, older than 15 minutes, or issued for another tenant. The message is intentionally uniform | Issue a new code |
| Enrollment rate-limited (HTTP 429) | Too many attempts from the same IP (public bucket 60 burst, 10/s) | Wait for `Retry-After` |
| Device login `DEVICE_AUTH_FAILED` (401) | Revoked device, expired or reused nonce, wrong key, or a skewed clock making the nonce fail | Fetch a fresh challenge; check clock; re-enroll if the key is lost |
| PIN login 423 locked | Lockout policy reached | Wait, or admin resets via PIN set; review whether someone is guessing |
| Hub not found | mDNS blocked (AP isolation, VLAN), different subnet | Use static fallback address; fix network per [supported-devices §8.2](supported-devices.md) |
| Terminal unreachable | IP changed (no reservation), certificate not installed (Adyen local), terminal firmware below minimum | Reserve IP; re-pair; update firmware |
