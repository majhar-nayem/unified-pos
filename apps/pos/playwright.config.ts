import { defineConfig } from '@playwright/test';

/**
 * e2e for the register shell in a real browser against a mock of the F1 auth API (e2e/mock-api.ts).
 * Uses the system Chrome (`channel: 'chrome'`) so no browser download is needed; set
 * PW_CHANNEL=chromium to use Playwright's bundled build instead.
 *
 * The Tauri webview itself is not driven here: `tauri-driver` needs a compiled Rust app and a native
 * WebDriver, neither available in CI yet (see docs/releases/s-f6a.md, "planned").
 */
const channel = process.env.PW_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:1420',
    ...(channel === 'chromium' ? {} : { channel }),
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/mock-api.ts',
      url: 'http://localhost:3100/v1/health',
      reuseExistingServer: !process.env.CI,
      env: { MOCK_API_PORT: '3100' },
    },
    {
      command: 'pnpm exec vite --port 1420 --strictPort',
      url: 'http://localhost:1420',
      reuseExistingServer: !process.env.CI,
      env: { POS_API_URL: process.env.POS_LIVE_API_URL ?? 'http://localhost:3100' },
    },
  ],
});
