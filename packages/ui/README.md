# @pos/ui — design system

Tokens, themes, React primitives and composites shared by the POS (Tauri + React), the KDS and the admin console (Next.js). Specification: [docs/04-design-plan.md](../../docs/04-design-plan.md) §3 (tokens and component inventory), §6 (accessibility), §8 (design-to-engineering contract). Release status: [docs/releases/s-ui.md](../../docs/releases/s-ui.md).

## Using it in an app

```tsx
import '@pos/ui/styles.css'; // once, at the app root (tokens + base + every component)
import { UiProvider, Button, CartSummary } from '@pos/ui';

<UiProvider surface="pos" locale="en-AU" currency="AUD" brand={tenant.brandColour}>
  <App />
</UiProvider>;
```

| Provider prop            | Effect                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `surface`                | `pos` (14/16/20/28/40 type, 48 px controls), `admin` (12–24), `kds` (20/24/32, 72 px controls, **dark by default**) |
| `theme`                  | `light` or `dark`; defaults per surface (light for POS and admin, dark for KDS)                                     |
| `textScale="large"`      | POS large-text mode, ×1.25 on every type role                                                                       |
| `density="compact"`      | Admin controls drop from 40 to 32 px                                                                                |
| `brand`                  | Tenant accent colour. Applied to brand accents only and **only if it keeps 3:1 against the surface**; otherwise ignored |
| `locale`, `currency`     | Intl formatting and ICU message catalog (`en-AU` base)                                                              |
| `messages`               | Per-tenant or per-app copy overrides keyed by message key                                                           |

Portalled UI (dialogs, toasts, tooltips) mounts inside the provider element so it inherits the theme.

From TypeScript, `vars.color.text` is `var(--pos-color-text)` (themed) and `tokens` keeps the Sprint 0 static shape (light theme) for existing call sites. Prefer `vars`.

## The design-to-engineering contract

1. **Tokens JSON is the only source** of colour, spacing, type, radius, motion and breakpoints: `tokens/core.json`, `tokens/type.json`, `tokens/color.json`. `pnpm --filter @pos/ui tokens` generates `src/styles/tokens.css` (CSS custom properties, light/dark themes, per-surface type scales), `src/tokens.ts` (typed values, `vars`, resolved themes) and `dist/tokens.resolved.json`. Outputs are committed; a test (`generate:check`) fails when they are stale. Never edit generated files.
2. **Hex lives only in `palette` inside `tokens/color.json`.** Themes reference palette entries, components reference theme roles.
   - ESLint rule `@pos/ui/no-raw-color` (hex, `rgb()`, `hsl()` … in TS/TSX) — package config is `eslint.config.js`; apps adopt it with `import posUi from '@pos/ui/eslint'; export default [posUi.configs.recommended]`.
   - Stylelint (`stylelint.config.js`) forbids hex/rgb/named colours in component CSS and raw lengths for spacing, radius and type.
   - `pnpm --filter @pos/ui lint` runs both. (The repo-root `eslint.config.js` is owned by the integration lead; wiring the plugin there is a one-line follow-up, see the release notes.)
3. **Contrast is a test.** `src/tokens.test.ts` asserts WCAG AA for both themes: 4.5:1 text on every surface, 3:1 for control borders and focus rings, and 4.5:1/3:1 for every status palette entry (table, KDS age, payment). Status is always **icon + label**, never colour alone. The KDS age palette is also ordered by lightness, so it survives colour-vision deficiency.
4. **Every state has a story, every story is checked.** `*.stories.tsx` live next to components. `src/stories.test.tsx` renders every story and runs axe (jsdom, in `pnpm test`, hence in CI); `playwright/stories.spec.ts` runs axe with real colour contrast plus a pixel snapshot of each story in light and dark.
5. **Copy is ICU.** Built-in strings live in `src/i18n/catalogs/<group>.en-AU.json` (payment, KDS and receipt copy have their own catalogs). `pnpm --filter @pos/ui messages` validates ICU syntax and regenerates the typed `MessageKey` union. Components call `useUi().t(key, values)`; no text in images; money is integer minor units through `Intl`.
6. **Motion** ≤ 150 ms, only colour/opacity, `prefers-reduced-motion` respected, **no continuous animation**: processing is a static ◐ icon and skeletons are static.

## Commands

| Command                                              | What it does                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm --filter @pos/ui build`                        | Generates tokens + messages, compiles to `dist/`, concatenates `dist/styles.css` |
| `pnpm --filter @pos/ui typecheck`                    | `tsc --noEmit` including stories, tests and Storybook config                     |
| `pnpm --filter @pos/ui test`                         | Vitest + Testing Library + axe over every story, token contrast, lint-rule tests |
| `pnpm --filter @pos/ui lint`                         | ESLint (no raw colour, hooks, jsx-a11y) and Stylelint                            |
| `pnpm --filter @pos/ui storybook`                    | Storybook on :6006 (toolbar: surface, theme, large text, density)                |
| `pnpm --filter @pos/ui build-storybook`              | Static Storybook in `node_modules/.cache/storybook-static`                       |
| `pnpm --filter @pos/ui exec playwright test`         | Real-browser axe + visual regression against the static Storybook                |
| `pnpm --filter @pos/ui test:visual:update`           | Rewrite visual baselines                                                         |

### Visual regression

Baselines are stored per platform (`playwright/__snapshots__/<platform>/`) because font rendering differs. The committed set is `darwin`; CI on Linux needs its own baselines: run `test:visual:update` once in the CI image (or the `ci/ui-visual.workflow.yml` job) and commit `__snapshots__/linux`. If the Chromium build Playwright expects is not installed, point `PW_CHROMIUM_PATH` at any compatible Chromium or headless shell, or run `pnpm --filter @pos/ui exec playwright install chromium`.

## Layout

```
tokens/*.json                 single source of truth
scripts/                      build-tokens, build-messages, build-css, serve-static
eslint/                       @pos/ui/no-raw-color plugin (+ tests)
src/foundation/               UiProvider, Icon, contrast maths, formatting, cx
src/i18n/                     ICU catalogs, generated typed keys, translator
src/primitives/<Name>/        component, CSS, stories, tests
src/composites/<Name>/        POS, payment and KDS composites
.storybook/                   Storybook config (global toolbar: surface, theme, text scale, density)
playwright/                   story axe + snapshot spec
```

## Adding a component

1. Folder `src/primitives|composites/<Name>/` with `<Name>.tsx`, `<Name>.css` (tokens only), `<Name>.stories.tsx` (one story per state) and `<Name>.test.tsx`.
2. Export it from the group barrel (`forms.ts`, `surfaces.ts`, `composites/index.ts`).
3. Built-in copy goes in a catalog file; run `pnpm --filter @pos/ui messages`.
4. `pnpm --filter @pos/ui typecheck lint test` must be clean; refresh visual baselines for the new stories.
