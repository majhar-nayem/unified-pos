# Stream S-UI — design system (`packages/ui`)

Status after implementing [04-design-plan.md §3 and §8](../04-design-plan.md) under the stream rules in [03-implementation-plan.md §15](../03-implementation-plan.md). Everything is uncommitted in the working tree. Only `packages/ui/**` and this file were edited by the stream (plus `pnpm-lock.yaml`, see shared-file lines). `apps/*` and other packages were not touched.

Verified locally on 2026-10-18:

| Check                                     | Result                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @pos/ui build`             | green: token + message generation, `tsc` to `dist/`, `dist/styles.css` (39 CSS files)                                                                                |
| `pnpm --filter @pos/ui typecheck`         | green (src, stories, tests, Storybook and Playwright config)                                                                                                         |
| `pnpm --filter @pos/ui test`              | 875 tests in 42 files: component tests, 365 stories rendered with axe, WCAG contrast of both themes, lint-rule tests, stale-output checks                            |
| `pnpm --filter @pos/ui lint`              | clean (ESLint with no-raw-colour, react-hooks, jsx-a11y; Stylelint)                                                                                                  |
| `pnpm exec eslint packages/ui` (root cfg) | clean, including the boundary rules (`ui` imports no other `@pos` package)                                                                                           |
| `pnpm --filter @pos/ui build-storybook`   | green                                                                                                                                                                |
| Playwright (`playwright test`)            | 730 of 730: every story in light and dark, real-browser axe including colour contrast, pixel snapshots; second run against baselines identical                       |
| Consumers                                 | `@pos/pos` and `@pos/kds` typecheck against the new package. `@pos/admin-web` has one existing error in its own `ResourceTable.test.tsx` (not caused by this stream) |

Not run: root `pnpm build/lint/test` (shared-files protocol 15.2.2), Linux visual baselines.

## Features (implemented / tested / simulated / planned)

Status key: **I** implemented · **T** covered by tests · **S** stubbed or simulated · **P** planned, not started.

### Tokens, themes, contract (design plan §3.1, §8)

| Item                                                                                                                                                                                                              | Status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `tokens/{core,type,color}.json` single source (spacing 4-pt, touch 48/72/64/96, type scales POS/admin/KDS, radii, motion ≤ 150 ms, breakpoints 480/800/1366/1920, z-index, large-text ×1.25)                      | I T    |
| Colour roles, light and dark themes, three status palettes (table, KDS age, payment) plus payment extras (`offline-approved`, `expired`, `caps-reached`)                                                          | I T    |
| Build: `scripts/build-tokens.mjs` → `src/styles/tokens.css`, generated `src/tokens.ts` (replaces the old hand-written file; Sprint 0 `tokens` shape kept), `dist/tokens.resolved.json`; stale output fails a test | I T    |
| WCAG AA contrast test over every role and status palette in both themes (4.5:1 text, 3:1 UI)                                                                                                                      | I T    |
| Themes: light default for POS/admin, dark default for KDS, `data-surface`, large-text mode, admin compact density                                                                                                 | I T    |
| Tenant brand colour constrained to accents; rejected when below 3:1 on the surface                                                                                                                                | I T    |
| ESLint rule `@pos/ui/no-raw-color` (also exported as `@pos/ui/eslint`) and Stylelint config (no hex/rgb/named colours, no raw lengths for spacing, radius, type)                                                  | I T    |
| ICU message catalogs (`en-AU`), generated typed `MessageKey`, separate payment / KDS / receipt catalogs, ICU syntax validated at build                                                                            | I T    |
| `UiProvider` (surface, theme, locale, currency, message overrides, portal container), Intl money in integer minor units, duration and time formatting                                                             | I T    |

### Primitives (§3.2)

| Component                                                                  | Status | Notes                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button (primary/secondary/danger/ghost; sm/md/lg/`tender`; loading, icons) | I T    |                                                                                                                                                             |
| IconButton                                                                 | I T    | `label` required                                                                                                                                            |
| Keypad                                                                     | I T    | digits / pin (digits never in the DOM) / amount in minor units; physical keyboard                                                                           |
| Toggle, Segmented, Checkbox, Radio + RadioGroup                            | I T    | native inputs                                                                                                                                               |
| Input, Select, Field                                                       | I T    | label/hint/error wiring                                                                                                                                     |
| Search with scanner capture                                                | I T    | timing-based scan detection, `onScan` vs `onSubmit`, optional global capture                                                                                |
| Combobox                                                                   | I T    | ARIA 1.2 listbox, async `loading` state                                                                                                                     |
| Badge, StatusPill, Tag                                                     | I T    | pills are always icon + label                                                                                                                               |
| Tooltip, Toast (`ToastProvider`, `useToast`)                               | I T    | live regions, timers paused on hover/focus                                                                                                                  |
| Dialog (+ `alertdialog`), Sheet/Drawer                                     | I T    | manual focus trap, focus restore, scroll lock, stacked dialogs, no native `<dialog>`                                                                        |
| Tabs                                                                       | I T    |                                                                                                                                                             |
| Table (virtualized)                                                        | I T    | in-house windowing (10k rows → about 20 DOM rows), ARIA grid, single tab stop, selection, compact/comfortable density; sorting is delegated to the consumer |
| Card, EmptyState, Skeleton                                                 | I T    | skeletons are static                                                                                                                                        |
| Banner (offline / degraded / cloud routing / warning)                      | I T    | copy from catalog so tenants can override                                                                                                                   |
| Stepper                                                                    | I T    | wizard step indicator                                                                                                                                       |

### First composites (§3.2, §4)

| Component                             | Status | Notes                                                                                                                                                                                                                     |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CartLine, `CartLineList`              | I T    | list is a listbox with roving focus; see decision 3                                                                                                                                                                       |
| CartSummary                           | I T    | announces grand total changes                                                                                                                                                                                             |
| ProductTile, ProductGrid              | I T    | pages, grid keyboard navigation, stock states with icon + text                                                                                                                                                            |
| QuantityStepper                       | I T    |                                                                                                                                                                                                                           |
| TenderBar                             | I T    | 72 px tender buttons, F-key shortcuts, offline relabel and caps-reached disabled state                                                                                                                                    |
| PaymentStatusPanel                    | I T    | all §4.2 states: processing, approved, declined, uncertain (Call manager after 60 s), approved offline, forwarded and approved, declined after reconnect, expired, caps reached; `CardTenderLabel`; `receiptPaymentLabel` |
| ConnectivityIndicator, SyncQueueBadge | I T    | SyncQueueBadge includes the unsynced offline-payment expiry countdown (pure props)                                                                                                                                        |
| ApprovalPrompt                        | I T    | PIN and passkey, over-limit framed as approval; passkey is a callback (WebAuthn is the app's job)                                                                                                                         |
| KDS Ticket, TicketItem, `ageBucket`   | I T    | age palette with icon + label per bucket, allergy band, voided and updated markers; sound is the app's job (`onVoidedAnnounce`)                                                                                           |

### Storybook, accessibility, visual regression

| Item                                                                                                                                      | Status                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Storybook 10 (`@storybook/react-vite`, a11y and docs addons); toolbar for surface, theme, text scale, density; 365 stories, one per state | I                                                                                         |
| Every story is rendered and axe-checked in Vitest (runs in `pnpm test:unit`, so in existing CI)                                           | I T                                                                                       |
| Playwright: real-browser axe with colour contrast and pixel snapshots, light and dark, from the static Storybook (730 cases)              | I T                                                                                       |
| README describing the design-to-engineering contract                                                                                      | I                                                                                         |
| CI job for the Playwright run                                                                                                             | S: `packages/ui/ci/ui-visual.workflow.yml` is a proposal, `.github/**` belongs to S-INFRA |

## Architectural decisions

- **Plain CSS plus custom properties, one stylesheet.** `dist/styles.css` concatenates tokens, base and every component stylesheet; apps import `@pos/ui/styles.css` once. Chosen over CSS-in-JS so states (hover, focus-visible, disabled) and themes are CSS, work in Tauri webviews and Next.js without a runtime, and so Stylelint can enforce tokens. Base rules use `:where()` so component classes always win.
- **Single source for both worlds.** `vars.color.text` (CSS variable reference, themed) is the preferred TypeScript form; `tokens` keeps the Sprint 0 static light values so existing call sites compile. Note it is the light palette now: apps that used the old dark-only `tokens.color.bg` will look light until they adopt `UiProvider`.
- **Accessibility decisions that deviate from a literal reading of the wireframes:**
  1. `CartLineList` is a listbox, which cannot contain controls (axe `nested-interactive`). A selected line's stepper and void actions appear in a `selectedActions` strip after the list; a standalone `CartLine` can show them inline.
  2. Disabled-at-bounds controls (quantity stepper, pager, out-of-stock tiles) use `aria-disabled` so keyboard focus is not lost.
  3. Ticket status is a pill and the primary action names the next step (Start / Ready / Bump), where the wireframe shows the status as the button label.
  4. `Banner variant="offline"` renders in the danger (red) tone, as the plan specifies for profile B; `tone="offline"` is slate.
  5. Scrollable dialog and sheet bodies become focusable only when they overflow.
- **No animation that loops.** Processing is a static half-filled circle, skeletons are static, transitions are ≤ 150 ms on colour only; this honours "no animation on the checkout critical path" and "no flashing".
- **Scanner detection is timing based** (≥ 4 characters, ≤ 50 ms gap, Enter terminated). Keyboard-wedge scanners are covered; HID-POS and device SDK scanners belong to `packages/hardware`.
- **Visual baselines are per platform** (`playwright/__snapshots__/<platform>`); output directories live under `node_modules/.cache` so the repo-root lint and format ignore generated Storybook output.

## Modules and files

`packages/ui/` only: `tokens/`, `scripts/`, `eslint/`, `.storybook/`, `playwright/`, `ci/`, `src/{foundation,i18n,primitives,composites,styles,test}`, package config (`package.json`, `tsconfig*.json`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `stylelint.config.js`, `.gitignore`, `README.md`). `src/Button.tsx` and the hand-written `src/tokens.ts` were replaced. Public entry points: `@pos/ui`, `@pos/ui/styles.css`, `@pos/ui/tokens.json`, `@pos/ui/eslint`.

## Migrations and APIs

None. Public package API: `@pos/ui` exports now include tokens (`tokens`, `vars`, `themes`, `typeScale` …), `UiProvider`/`useUi`, `Icon`, formatting and contrast helpers, `createTranslator`, and every component above. `Button`'s props remain compatible (`variant`, `children`, native button props; `size`, `loading`, `iconStart/End`, `fullWidth` added).

## Tests executed

875 Vitest tests (jsdom, Testing Library, user-event, axe-core) in 42 files; 730 Playwright cases (365 stories × light and dark) with axe and snapshots. No load or security tests apply to this package.

## Known limitations

- Axe in jsdom has no layout, so contrast is verified by the token test and the Playwright run only.
- Visual baselines exist for `darwin` only. They were produced with Chromium headless shell 1223 through `PW_CHROMIUM_PATH` because Playwright 1.64.1 expects build 1248, which was not installed (nothing was downloaded). Linux CI needs its own baselines.
- Only `en-AU` copy exists; no RTL audit has been run, and the large-text mode (×1.25) is verified through a story and a Provider prop, not a layout sweep across every composite.
- No high-contrast KDS theme yet (the age palette is lightness-ordered and carries icons and labels, which covers colour-vision safety, but the §6 "high-contrast theme" is not built).
- Tooltip positions top or bottom only; Combobox's popup is inline, not portalled; Table does not sort rows itself.
- PaymentStatusPanel's `uncertain` timer is driven by the `elapsedSeconds` prop (a `useElapsed` helper is provided).
- Fonts: the system UI stack is used, so snapshots differ between machines even on one OS version if system fonts change.

## Security considerations

PIN entry never puts digits in the DOM or in announcements (only a count); `ApprovalPrompt` hands the PIN to the app callback and clears it on denial, error and close. The component library does not persist anything and makes no network calls. The `no-raw-color` rule and tenant brand guard stop tenant data from breaking contrast. Tenant-supplied copy overrides are rendered as ICU text, not HTML.

## Deployment instructions

None beyond the build: consumers `import '@pos/ui/styles.css'` once and wrap the app in `<UiProvider surface="pos|admin|kds">`. Optional: add `import posUi from '@pos/ui/eslint'; export default [posUi.configs.recommended]` to an app's ESLint config.

## What remains from the component inventory (§3.2)

| Group            | Not yet built                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POS composites   | ModifierPicker, DiscountPanel, CustomerChip, ReceiptPreview, SuspendedOrdersList                                                                                                                                                                      |
| Restaurant       | FloorPlanCanvas, TableTile (palette tokens exist), SeatSelector, CourseBar, CheckSplitter, TipPrompt, GuestCountPicker, OpenChecksList                                                                                                                |
| KDS composites   | StationHeader, AllDayCountBar, BumpBar mapping, RecallDrawer                                                                                                                                                                                          |
| Admin composites | DataTable with saved views (the virtualized `Table` is the base), FilterBar, DetailDrawer (`Sheet` is the base), AuditTimeline, ConfigDiff, BulkActionBar, ImportWizard (`Stepper` is the base), PromotionRuleBuilder, MenuScheduler, FloorPlanEditor |
| Other §3.1 / §6  | High-contrast KDS theme, RTL pass, customer-facing display components, Figma token sync, Chromatic option                                                                                                                                             |

## Stubs and shared-file lines

- **Stubs left:** none in code. The Playwright CI job is only a proposal (`packages/ui/ci/ui-visual.workflow.yml`).
- **Dependencies added (own `package.json`, one `pnpm install --filter @pos/ui`):** runtime `intl-messageformat@12.1.3`; dev `storybook`, `@storybook/react-vite`, `@storybook/addon-a11y`, `@storybook/addon-docs` 10.6.2, `@playwright/test@1.64.1` (the version `admin-web` already uses), `@axe-core/playwright`, `axe-core`, `@testing-library/{react,dom,jest-dom,user-event}`, `jsdom`, `stylelint`, `eslint-plugin-jsx-a11y`, `eslint-plugin-react-hooks`, `vite@7.3.7`, `@types/react-dom`, `react-dom`, `@types/node`.
- **Shared-file lines:** `pnpm-lock.yaml` changed by that install (new `packages/ui` importer entries; Next's peer-resolution suffix gained `@playwright/test`). No other shared file was edited. Root `eslint.config.js`, `.gitignore`, `.prettierignore` and `.github/**` are owned by others and untouched.
- **Defects recorded for the integration lead:** none in `db/schema*.sql`.

## Recommended next steps

1. Wire `@pos/ui/eslint` into the root `eslint.config.js` and import `@pos/ui/styles.css` plus `UiProvider` in `apps/pos`, `apps/kds` and `apps/admin-web` (their owners), replacing app-local components.
2. Move `packages/ui/ci/ui-visual.workflow.yml` into `.github/workflows` (S-INFRA), generate Linux baselines once in the CI image, and add `packages/ui` build and Storybook build to the pipeline.
3. Next component wave in priority order: ModifierPicker, DiscountPanel, TableTile + FloorPlanCanvas, StationHeader + AllDayCountBar + RecallDrawer, then the admin composites on top of Table, Sheet and Stepper.
4. Designer review of the en-AU copy catalogs (payment, KDS and receipt especially) and a usability pass of the payment states with cashiers.
5. Add the high-contrast KDS theme and a ×1.25 large-text layout sweep over the composites.
