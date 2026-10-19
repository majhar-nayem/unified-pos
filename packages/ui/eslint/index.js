import { noRawColor } from './no-raw-color.js';

/**
 * ESLint plugin shipped with the design system.
 *
 *   import posUi from '@pos/ui/eslint';
 *   export default [posUi.configs.recommended];
 *
 * `recommended` is a flat-config entry enabling `@pos/ui/no-raw-color` for TS/JS sources. Generated
 * token output (`**\/tokens.ts`) is exempt: it is the one place raw values live.
 */
const plugin = {
  meta: { name: '@pos/ui' },
  rules: { 'no-raw-color': noRawColor },
  configs: {},
};

plugin.configs.recommended = {
  name: '@pos/ui/recommended',
  files: ['**/*.{ts,tsx,js,jsx,mjs}'],
  ignores: ['**/tokens.ts', '**/*.test.{ts,tsx,js}'],
  plugins: { '@pos/ui': plugin },
  rules: { '@pos/ui/no-raw-color': 'error' },
};

export default plugin;
