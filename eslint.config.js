// @ts-check
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { dependencyRules, elements } from './tools/eslint/boundaries.js';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/src-tauri/**',
      '**/next-env.d.ts',
      'pnpm-lock.yaml',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...globals.es2022 },
    },
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': rootDir,
      'boundaries/elements': elements,
      'boundaries/ignore': ['**/node_modules/**', '**/dist/**'],
      // Resolve @pos/* workspace imports to their source folders without needing a build first.
      'import/resolver': {
        typescript: { project: `${rootDir}/tsconfig.eslint.json` },
        node: { extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx'] },
      },
    },
    rules: {
      'boundaries/dependencies': ['error', dependencyRules],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // NestJS resolves constructor injection from emitted decorator metadata, which needs value imports.
    files: ['apps/api/**', 'apps/worker/**'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  prettier,
);
