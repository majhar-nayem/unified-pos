import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Vitest's esbuild transform does not emit decorator metadata, which Nest DI needs; SWC does.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 240_000,
    testTimeout: 60_000,
  },
});
