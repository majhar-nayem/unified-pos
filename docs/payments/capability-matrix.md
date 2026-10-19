# Payment capability matrix (R3)

Status: **PROPOSED**, populated from vendor public documentation read on 2026-10-18 and from [docs/05 §3](../05-competitive-review-and-plan-critique.md). Every cell below is a documentation finding, not a sandbox result. The Sprint 0 exit criterion ([03 §4, "Payment capability matrix (R3)"](../03-implementation-plan.md)) is that these cells are re-proved with sandbox tests per connection mode; §7 lists the tests. Until then the matrix may drive internal design but **must not drive UI claims or sales claims** (architecture R3).

Related: [ADR-010](../adr/ADR-010.md), [ADR-019](../adr/ADR-019.md), [ADR-020](../adr/ADR-020.md), [01 §7.4 and §8.3](../01-system-architecture.md), [threat model, PCI matrix](../security/threat-model.md#pci-dss-responsibility-matrix), [supported devices §3](../operations/supported-devices.md).

## 1. How to read this document

- **Cell format:** `value [source]`. A source is an identifier from §8. Text in *italics* is the author's inference, not a vendor statement.
- **`unknown`** means the sources read did not establish the fact. It is never a negative. Candidate answers and the question to put to the vendor are in §6.
- **`not stated`** means the vendor page that should cover the topic was read and is silent.
- **Evidence grade** of a source: **V** = vendor documentation page fetched and read; **R** = reported only in a search-result snippet or secondary source, page body not read (marked in §8); **I** = internal repository document.
- Provider × **connection mode** is the unit, as in the adapter contract (`capabilities.offlineModes` per mode, architecture §7.4).
- Currency of reference is AUD, Australian market.

## 2. Connection modes covered

| Provider | Modes in scope | Where the adapter runs (ADR-019) |
| --- | --- | --- |
| Adyen | **Local** Terminal API (POS → terminal IP, port 8443, synchronous) [S5]; **Cloud** Terminal API (via Adyen `device-api`, sync or async) [S5]; **Mobile SDK** (Tap to Pay on iPhone, iOS card reader) [S1] | Local: Payments Edge. Cloud: `payments` deployable. Mobile SDK: Edge native plugin (iOS) |
| Stripe Terminal | **Native SDK** (iOS/Android/React Native, Bluetooth or smart readers, Apps on Devices) [S6]; **JavaScript SDK**; **Server-driven** (cloud) [S6, S7] | SDK: Edge native plugin. JS SDK: webview. Server-driven: `payments` deployable |
| Tyro | **iClient** (browser JavaScript over LAN) [S10]; .NET TTA, iOS/Android SDKs, Pay@Table REST [S10, S21] | iClient: webview or Edge. Others: Edge |
| Linkly | **Cloud** (REST, internet required) [S16]; **Core Payments TCP/IP** (local) [S15]; Local REST and ActiveX interfaces exist [S17]; **Online API** (e-commerce) [S17] | Cloud: `payments` deployable. TCP/IP and Local REST: Edge |
| Windcave | **HIT** (Host Initiated Transactions, HTTPS service controlling a terminal) [S18, S19]; XML socket for Tupelo attended terminals [S20]; **REST API** (card-not-present only) [S20] | HIT: Edge or cloud depending on reachability, *to be settled in spike R11* |

*Inference:* Linkly and Windcave were not part of the original Payments Edge spike (plan §4 names Adyen local and Tyro iClient). If either is selected for Phase 2, spike R11 must be extended.

## 3. Capability matrix by provider and mode

### 3.1 Adyen

| Capability | Local Terminal API | Cloud Terminal API | Mobile SDK / standalone |
| --- | --- | --- | --- |
| Card present | yes [S1, S5] | yes [S5] | yes [S1] |
| Card not present | unknown (Adyen online products were not reviewed; Terminal API pages do not cover them) | unknown | unknown |
| Pre-auth | yes: `PaymentRequest` with `authorisationType=PreAuth`; requires webhooks `AUTHORISATION_ADJUSTMENT`, `CAPTURE`, `CAPTURE_FAILED`; not for QR, MOTO, MKE [S4]. eftpos AU: not stated [S4] | same API [S4] | unknown |
| Adjust / increase auth | yes, by request to the Adyen backend (not the terminal), up or down, depends on scheme, MCC, issuer; ≥ 5 s after the pre-auth [S4] | same | unknown |
| Capture of pre-auth | `POST /payments/{pspRef}/captures`, confirmed by `CAPTURE` webhook; default expiry 28 days, scheme rules differ (Visa 5–30, Mastercard 7 or 30, Amex 7 days) [S4] | same | unknown |
| Tip | on-terminal tip prompt (fixed, percent, custom, may decline) or tip supplied by POS and confirmed on terminal; standalone accounts can prompt every payment [S2] | same [S2] | not stated |
| Tip adjust after authorisation | "tip on receipt": pre-auth, increase authorisation, manual capture of final amount [S2]. Other post-auth adjustment: not stated | same | unknown |
| Offline store-and-forward | **yes**, offline EMV first, then store-and-forward; Support enables and sets limits [S1] | **effectively no**: only works if the link drops after the terminal already received the request [S1] | yes for standalone; Mobile SDK store-and-forward for 24 consecutive hours after online security attestation; offline PIN only; no offline EMV or refunds [S1] |
| Offline caps / windows | per-transaction maximum and per-terminal count, set by Adyen Support; chip floor limit, contactless floor limit; no defaults published [S1] | n/a | mobile: 24 h window [S1] |
| Excluded offline | most local schemes, QR wallets, magstripe, cashback; **American Express in Australia**; contactless can be blocked so offline accepts chip only [S1] | n/a | mobile: offline PIN only; Manual Key Entry configurable, no liability shift [S1] |
| After reconnect | forward on reconnect; response lacks PSP reference and auth data (`OnlineFlag=false`, `offlineAuthCode` distinguishes outcomes); issuer may decline; **Auto Rescue** retries for one calendar month (not for fraud-flagged) [S1] | n/a | same [S1] |
| Refund with original | yes, `ReversalRequest` by tender reference + POIID or by PSP reference; return window 40 business days [S3] | yes [S3] | unknown |
| Refund without original | yes, unreferenced: `PaymentRequest` with PaymentType Refund, any card, manual reconciliation, higher fraud risk; not for QR wallets [S3] | yes [S3] | unknown |
| Refund while offline | only unreferenced, only up to a Support-set maximum, processed as offline EMV so can fail [S1] | n/a | not supported on mobile [S1] |
| Least-cost routing | not stated (`paymentMethodVariant` and `fundingSource` on a refund identify routing network [S3]; the LCR page returned 404) | not stated | not stated |
| Surcharge | not reviewed → unknown | unknown | unknown |
| Certification / go-live | a go-live checklist exists; contents not stated; lead time unknown [S5] | same | same |
| Network note | use DHCP reservation or static IP for the terminal; add Adyen root certificate to the POS; **Adyen does not support network issues at the physical location** [S5] | dynamic IP; DHCP lease ≥ 24 h recommended [S5] | n/a |

### 3.2 Stripe Terminal

| Capability | Native SDK (mobile and smart readers) | JavaScript SDK | Server-driven |
| --- | --- | --- | --- |
| Card present | yes, AU readers: BBPOS WisePOS E, Stripe Reader S700/S710/T600, BBPOS WisePad 3 (mobile), Tap to Pay on iPhone/Android; Verifone V660p/UX700/P630 private preview in AU [S9] | yes (SDK works with smart readers over internet) [S6] | yes [S6] |
| Card not present | yes through the same PaymentIntents API *(Terminal documents use PaymentIntents; CNP product pages not reviewed)* | same | same |
| Pre-auth (manual capture) | `capture_method=manual` works for Visa/Mastercard/Amex, but **eftpos cards always decline with `manual`**; eftpos does not support holds; `manual_preferred` authorises only non-eftpos cards and takes eftpos in one step [S9]. Extended authorisations supported offline; incremental authorisations not [S6] | same [S9] | same [S9] |
| Tip | on-reader tipping in AU on WisePad 3, WisePOS E, S700/S710; works with automatic and manual capture [S8]. On-receipt tipping (overcapture) is **US only** [S8] | on-reader via smart readers [S8] | same [S8] |
| Tip adjust after authorisation | **not available in AU** (on-receipt/overcapture US only) [S8]. For mandatory tips, include in the PaymentIntent amount [S8] | same | same |
| Offline store-and-forward | **yes**: Visa, Mastercard, Discover, Amex, JCB, Maestro; eftpos listed as supported with co-branded cards routed through the international scheme [S6]. *Conflict:* docs/05 recorded "EFTPOS-only cards not accepted" from the Android collect-offline page [S21, S23]; resolve in sandbox. No swipe; no QR; Tap to Pay on Android has no offline; Tap to Pay on iPhone is contactless Visa/MC/Discover/Amex only (private preview) [S6] | **not supported** [S6, S21] | **not supported** [S6, S21] |
| Offline caps / windows | Stripe-enforced USD 10,000 (or equivalent) per transaction; merchant may set lower amount and count limits via `offlineBehavior`; reader connected online within 24 h on same LAN, updated within 30 days [S21, S23] | n/a | n/a |
| Excluded offline | swipe; contactless in SCA markets; NYCE/PULSE/STAR, girocard, Interac, QR [S6]; no cancel or refund until forwarded [S21] | n/a | n/a |
| After reconnect | reader forwards automatically; PaymentIntent id is null until forwarded; reconcile via metadata and webhooks; merchant bears decline and tamper risk [S21] | n/a | n/a |
| Refund with original | yes via API or Dashboard; for eftpos the cardholder need not present the card again [S9] | same | same |
| Refund without original | unknown (card-present unlinked refunds not covered in pages read) | unknown | unknown |
| Least-cost routing | **yes for co-branded eftpos**: default routing depends on capture type and contact vs contactless; `routing.requested_priority` = `domestic` (eftpos) or `international`; processed network readable at `charge.payment_method_details.card_present.network` [S9]. Stripe also publishes a support note on dual-network debit in Australia [S9] | same | same |
| Cash-out | not supported on Terminal [S9] | same | same |
| Surcharge | not stated in pages read | not stated | not stated |
| Certification | no per-integration certification stated; SDK minimum versions for eftpos: iOS 2.20.0, Android 2.20.0, React Native 0.0.1-beta.12 (JS and server-driven need no change) [S9]; BBPOS WisePad 3 AU firmware `4.01.07.00_Prod_APAC1_on_v28_491001` or later [S9]. Lead time unknown | n/a | n/a |

### 3.3 Tyro

| Capability | iClient (JS over LAN) | Other integrated modes (TTA, SDKs, Pay@Table) |
| --- | --- | --- |
| Card present | yes [S10, S13] | yes [S10] |
| Card not present | unknown (Tyro e-commerce products not reviewed) | unknown |
| Pre-auth | exists as "Integrated Pre-Authorisation"; optional in certification for both retail and hospitality [S10, S14]; rules, expiry and eftpos behaviour unknown (page body not retrieved) | unknown |
| Tip | entered **on the terminal** when tipping is enabled; no POS config or request parameter; applied tip returned in `transactionCompleteCallback.tipAmount` (required for certification); "Highly Recommended" for hospitality [S11, S14] | unknown |
| Tip adjust after authorisation | not stated [S11] | unknown |
| Offline store-and-forward | **unknown**: no offline/store-and-forward statement in iClient pages [S10, S13]; docs/05 also records unknown [S21] | unknown |
| Offline caps / windows | unknown | unknown |
| Refund with original | refund request needs `amount` and `integratedReceipt`; refund amount must include original surcharge and, by guidance, stored tip-inclusive amount; no cashout or surcharge flag on refunds [S11, S12, S13] | unknown |
| Refund without original | matched vs unmatched refund: not stated [S13] | unknown |
| Cash-out | optional `cashout` amount on purchase; not on refunds [S13] | unknown |
| Least-cost routing | not stated | unknown |
| Surcharge | `enableSurcharge` flag; credit cards, rate set in Merchant Portal; applied amount returned. **Deprecated and retired by October 2026** (rates set to zero); new integrations from 1 October 2026 should send `enableSurcharge: false` [S12] | same *(assumed)* |
| Transaction status recovery | a "Continue last transaction" function exists in the demo; mechanism described on the Transaction Callbacks page, not read [S13] | unknown |
| Certification | **mandatory before production**; criteria checklist per feature; development should start from the certification criteria PDF [S10, S14, S21]; lead time unknown (Sprint 0 kick-off will establish it) | same |

### 3.4 Linkly

| Capability | Cloud (REST) | Core Payments TCP/IP | Online API |
| --- | --- | --- | --- |
| Card present | yes; recommended for new integrations; no local install, no direct POS-to-pinpad link [S17] | yes [S15] | no (e-commerce) |
| Card not present | no | no | yes [S17] |
| Pre-auth | unknown: not confirmed on Cloud [S17] | not stated [S15] | yes: payments, pre-auths, captures, refunds, voids [S17] |
| Tip | supported, sync and async [S17] | supported: `EnableTip=1`, tip entered in EFT-Client UI (manual or percent), response `AmtTip`; POS-managed tip via `TIP` tag [S15]. A tip-adjustment transaction type appears in search results for the TCP/IP docs and was not confirmed [S17] | unknown |
| Tip adjust after authorisation | unknown | R: tip adjustment transaction exists, requires original RRN, auth code, track data [S17] (not confirmed) | unknown |
| Offline store-and-forward | **no**: the Cloud service is not accessible without a reliable internet connection at the POS site [S16] | not stated; the response carries an "Offline Transaction" flag, so some offline authorisation exists on the terminal side [S15]; caps and windows unknown | n/a |
| Excluded offline | unknown | unknown | n/a |
| Refund with original | yes [S17] | **required**: each refund must be matched to an original purchase using the `RFN` PAD tag stored from the purchase response [S15] | yes [S17] |
| Refund without original | R: third party reports only referenced refunds on Cloud [S17] | **not supported through the Core Payments interface** [S15] | unknown |
| Least-cost routing | not stated | not stated | not stated |
| Surcharge | handled by Linkly and terminal; `SUR` tag, included in `AMT`, rates in the EFT-Client GUI [S15]. *Post-ban: must be disabled for designated schemes (§5)* | same [S15] | unknown |
| Split payments | POS-managed [S15] | POS-managed [S15] | unknown |
| Transaction status recovery | `Get Last Transaction` and `Reprint Receipt` required [S15] | same [S15] | n/a |
| Certification | accreditation process: minimum requirements Purchase, Refund, Reprint Receipt, Get Last Transaction, partial/split payments, power-fail and timeout handling; POS name and version must match the accreditation; timeouts "180 seconds from the last message received" [S15]; production credentials issued through an acquirer, sandbox for testing only [S17]. Lead time unknown | same | unknown |

### 3.5 Windcave

| Capability | HIT (Host Initiated Transactions) | REST API |
| --- | --- | --- |
| Card present | yes; terminals must be enabled as host-integrated, standalone terminals do not work [S18, S19] | **no**: REST covers card-not-present only [S20] |
| Card not present | via REST (separate) [S20] | yes [S20] |
| Pre-auth | `Auth` transaction type holds funds; **completion of a terminal Auth must go through the eCommerce REST API**, not HIT [S18] | completion of HIT Auth; HIT user and REST user must share the same Windcave Group [S18] |
| Tip | `EnableTip=1` on Auth or Purchase prompts on the terminal; tip returned in `AmtT`; must be enabled per terminal by contacting Windcave [S18] | n/a |
| Tip adjust after authorisation | not stated | not stated |
| Offline store-and-forward | HIT pages do not describe it [S18]. The Windcave Merchant Operating Guide v2.3 (old, about 1,300 days) says terminals can go offline after two timeouts, loss of network or unreachable host if offline processing is enabled; limits set by the acquirer; stored on the terminal, uploaded when connectivity returns [S19]. *Treat as R, possibly outdated* | n/a |
| Refund with original | matched refund by original `DpsTxnRef` [S18] | matched refund via REST (same Group requirement) [S18] |
| Refund without original | unmatched refund authorised with a **merchant refund card** swiped with PIN on the terminal; POS should apply its own authorisation first [S18] | n/a |
| Least-cost routing | not stated | n/a |
| Surcharge | configured on the Windcave host per card type and account (fixed or percent), reported in `AmtS`; enablement via Windcave with terminal serial numbers [S18] | n/a |
| Australian availability | unknown: sources describe Windcave HIT but not Australian acquiring or eftpos support; Windcave is a common acquirer in New Zealand and also appears in Australia [S20] | n/a |
| Certification | five steps: pre-certification test scripts, book certification, QA run on the scheduled date, bug fixes (a second round may be needed), Certification Report; **lead time not stated, "book well in advance"** [S18] | n/a |

## 4. Offline card acceptance, cross-provider view

| Provider and mode | Offline card | Platform consequence (ADR-019) |
| --- | --- | --- |
| Adyen local / standalone | yes, caps by Support | Edge enforces count/sum caps from `devices.health`; expiry set from provider window; honour Auto Rescue (one month) in `forward_outcome = rescue_in_progress` |
| Adyen cloud | no | `offlineModes: none` |
| Adyen Mobile SDK | yes, 24 h, offline PIN only | `offline_expires_at = attestation + 24 h` |
| Stripe SDK / smart reader | yes, USD 10,000 cap, 24 h LAN-online rule | smart reader must have been online on the same LAN in the last 24 h; reader firmware ≤ 30 days old; `payment_intent` id null until forwarded, correlate by metadata |
| Stripe JS / server-driven | no | `offlineModes: none` |
| Tyro iClient | unknown | UI treats as `none` until certification confirms |
| Linkly Cloud | no | `offlineModes: none` |
| Linkly TCP/IP | unknown | treat as `none` until confirmed |
| Windcave HIT | unknown / R | treat as `none` until confirmed |

Rules that follow, restating architecture §7.4 and §8.3: the terminal decides; the POS never promises offline card acceptance; capability is per mode, not per provider; American Express is refused offline by Adyen in Australia; Stripe lists Amex as supported but refuses swipe, and eftpos treatment must be proven.

## 5. Australian surcharge ban from 1 October 2026 and its effect

### 5.1 What is established

| Fact | Evidence |
| --- | --- |
| RBA conclusions on the Review of Merchant Card Payment Costs and Surcharging end surcharging on **eftpos, Mastercard and Visa** cards (debit, prepaid and credit on those networks) from **1 October 2026**; lower domestic interchange caps start the same day [S22] | CommBank newsroom (Aug 2026), HSF Kramer (Apr 2026), JD Supra |
| No change to least-cost-routing "expectations" approach [S22] | JD Supra summary |
| Interchange caps on foreign-issued cards and transparency measures follow from 1 April 2027 [S22] | JD Supra summary |
| Scope for **American Express, Diners, PayPal, BNPL**: sources disagree. One guide says Amex is covered; another lists Amex, Diners, PayPal, Afterpay and Zip as outside the ban; other reports say Amex, UnionPay and PayPal chose to drop surcharging on the same date anyway [S22] | secondary |
| Tyro: integrated surcharge "deprecated and will be retired by October 2026", all surcharges then zero; new integrations from 1 October 2026 should send `enableSurcharge: false` [S12] | vendor (V) |

*Unresolved, needs legal review before any AU surcharge capability is ever reintroduced:* exact legal definition of designated schemes, the position for non-designated schemes, and how the rule applies to tips, service charges and "payment processing fees" labelled differently.

### 5.2 Effect on platform features

| Area | Effect | Owner / slice |
| --- | --- | --- |
| Schema | `surcharge_minor` columns stay (non-AU markets; excluded brands; historical sales). Not removed | ADR-020 |
| Pricing pipeline step 6 (charges: service charge, **surcharge**, delivery fee) | Surcharge charge type is **not offered** in AU configuration; service charge and delivery fee unaffected | S-F3 / S-F2 (F3 charge rules) |
| Adapter `capabilities.surcharging` | `false` by default for AU accounts; adapters send the provider's disable flag (Tyro `enableSurcharge: false`); any non-zero surcharge returned by a provider is stored, printed and alerts | S-F5, M11 |
| Receipts and refunds | Sales made before 1 Oct 2026 may carry surcharge; refund amounts must include it (Tyro rule) | F4 receipts, M3 |
| Linkly / Windcave | Surcharge is configured provider-side (Linkly EFT-Client rates, `SUR` tag; Windcave host config, `AmtS`); onboarding checklist must confirm designated-scheme surcharges are zero at the provider [S15, S18] | onboarding doc, store-onboarding.md |
| Admin console | No surcharge editor for AU (F8) | S-F8 |
| Reporting | New requirement: **least-cost-routing visibility**: network mix and effective rate by network, from Stripe `network` field, Adyen `paymentMethodVariant`, and settlement files | M12, M11 |
| Tips and service charges | Not part of the ban per sources read, but recommended wording review | product, legal |

## 6. Questions to put to vendors (turn `unknown` into facts)

| Provider | Question | Why it matters |
| --- | --- | --- |
| Tyro | Offline / store-and-forward behaviour in iClient, caps, windows; unmatched refunds; pre-auth rules and eftpos; tip adjust; LCR; certification lead time | Offline promise; Sprint 0 kick-off |
| Adyen | Limits Support will set by default for AU; eftpos behaviour in store-and-forward and pre-auth; LCR and eftpos routing; go-live checklist contents; Adyen online/CNP for Phase 2 | Offline caps; cost |
| Stripe | eftpos offline acceptance (conflict §3.2); unlinked card-present refunds; Verifone preview timing in AU; surcharge handling on AU accounts | Offline rule; refund policy |
| Linkly | Cloud pre-auth and tip adjustment; offline behaviour of Core Payments via terminals; accreditation lead time; unmatched refunds | Whether Linkly can serve profiles B/C |
| Windcave | Australian acquiring and eftpos support; current offline mode limits; LCR; certification lead time | Whether Windcave is an AU option at all (NZ expansion is plan decision 5) |

## 7. Sprint 0 sandbox test plan (to flip PROPOSED to CONFIRMED)

| # | Test | Providers and modes | Result recorded as |
| --- | --- | --- | --- |
| T1 | Sale, cancel, timeout then `getStatus` / last-transaction recovery | all | `uncertain` resolution path per mode |
| T2 | Offline sale under cap, over cap, over count, excluded card (Adyen test cards that enforce limits; Stripe simulated offline reader) | Adyen local, Stripe SDK | caps, windows, excluded schemes |
| T3 | Forward then decline | Adyen local, Stripe SDK | `forward_outcome` mapping, webhook shape |
| T4 | Referenced and unreferenced refund, online and offline | all | refund policy rows |
| T5 | Tip on terminal; tip after auth where claimed | Adyen, Stripe (AU), Tyro, Linkly, Windcave | tip rows; US-only Stripe on-receipt confirmed absent in AU |
| T6 | Pre-auth, adjust, capture, expiry, eftpos behaviour | Adyen, Stripe, Windcave | pre-auth rows |
| T7 | Co-branded debit routing and network reporting | Stripe, Adyen, Tyro, Linkly | LCR rows |
| T8 | Surcharge flags off; assert zero surcharge in responses | Tyro, Linkly, Windcave | surcharge rows |
| T9 | Certification: scoping call, environment, plan, lead time | Tyro (mandatory), Linkly, Windcave | certification rows |

## 8. Sources

| Id | Grade | Source |
| --- | --- | --- |
| S1 | V | Adyen, Offline payments: https://docs.adyen.com/point-of-sale/offline-payment |
| S2 | V | Adyen, Tipping: https://docs.adyen.com/point-of-sale/tipping |
| S3 | V | Adyen, Refund a payment (Terminal API): https://docs.adyen.com/point-of-sale/basic-tapi-integration/refund-payment/ |
| S4 | V | Adyen, Pre-authorisation: https://docs.adyen.com/point-of-sale/pre-authorisation |
| S5 | V | Adyen, Choose your architecture: https://docs.adyen.com/point-of-sale/design-your-integration/choose-your-architecture/ |
| S6 | V | Stripe, Accept offline payments (smart readers): https://docs.stripe.com/terminal/features/operate-offline/overview.md?reader-type=internet |
| S7 | V | Stripe, Accept offline payments (index of reader variants): https://docs.stripe.com/terminal/features/operate-offline/overview |
| S8 | V | Stripe, Collect tips: https://docs.stripe.com/terminal/features/collecting-tips/overview |
| S9 | V | Stripe, Regional considerations (Australia): https://docs.stripe.com/terminal/payments/regional?integration-country=AU |
| S10 | V | Tyro, iClient implementation guide: https://docs.integrated-eftpos.tyro.com/integrated-eftpos/iclient/implementation-guide |
| S11 | V | Tyro, Integrated tipping: https://docs.integrated-eftpos.tyro.com/integrated-eftpos/iclient/implementation-guide/integrated-tipping |
| S12 | V | Tyro, Integrated surcharge: https://docs.integrated-eftpos.tyro.com/integrated-eftpos/iclient/implementation-guide/integrated-surcharge |
| S13 | V | Tyro, Integrated purchase, cashout and refund: https://docs.integrated-eftpos.tyro.com/integrated-eftpos/iclient/implementation-guide/purchase-cashout-refund |
| S14 | R | Tyro, Certification criteria iClient retail/hospitality (PDF listed in search results and linked from S10; the PDF could not be fetched, 404; optional/recommended status taken from the search summary) |
| S15 | V | Linkly, Core Payments TCP/IP interface: https://linkly.com.au/apidoc/TCPIP/ (first 100,000 of about 305,000 characters read) |
| S16 | R | Linkly, POS vendor terms and conditions: https://linkly.com.au/pos-terms-and-conditions/ (search-result excerpt: Cloud needs a reliable internet connection) |
| S17 | R | Linkly developer APIs page and Cloud Development Guide: https://linkly.com.au/resources-support/developer-apis ; https://linkly.zendesk.com/hc/en-au/articles/45823288939161-Linkly-Cloud-Development-Guide (guide returned 403; facts from search excerpts) |
| S18 | V | Windcave, Merchant attended EFTPOS HIT: https://www.windcave.com/merchant-attended-eftpos-hit |
| S19 | R | Windcave, Merchant Operating Guide v2.3: https://www.windcave.com/Document/Windcave-Merchant-Operating-Guide.pdf (search excerpt; document is old) and HIT PDF https://www.windcave.com/Document/PXHIT.pdf |
| S20 | R | Windcave developer documentation: https://www.windcave.com/developer-documentation (search excerpt) |
| S21 | I | [docs/05 §3 and §8](../05-competitive-review-and-plan-critique.md) (Adyen, Stripe, Tyro, Square, Toast, Clover rows and cited vendor pages) |
| S22 | R | RBA surcharge decision, secondary coverage: https://www.commbank.com.au/articles/newsroom/2026/08/commbank-reduces-fee-card-surcharging.html ; https://www.hsfkramer.com/insights/2026-04/rba-releases-conclusions-of-its-review-of-merchant-card-payment-costs ; https://www.jdsupra.com/legalnews/rba-releases-conclusions-of-its-review-4787592/ (the RBA conclusions paper itself was not read) |
| S23 | I | Stripe, Collect card payments offline (smart readers, Android), as cited in docs/05 §8: https://docs.stripe.com/terminal/features/operate-offline/collect-card-payments.md |
