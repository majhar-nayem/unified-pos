import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Container pull + 3000-line schema apply can take a while on a cold machine.
    hookTimeout: 240_000,
    testTimeout: 60_000,
    // One Postgres container per file; keep files sequential to avoid saturating Docker.
    fileParallelism: false,
  },
});
