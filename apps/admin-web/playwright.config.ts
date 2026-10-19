import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3101);
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3100';

/**
 * Flows run against a real apps/api (Postgres + Redis from docker compose) and a production build
 * of the console. Each test provisions its own tenant, so tests are independent and can run in
 * parallel. See docs/releases/s-f8.md for the exact commands.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  globalSetup: './e2e/support/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start --port ${WEB_PORT}`,
    url: `http://localhost:${WEB_PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      POS_API_URL: API_URL,
      POS_COOKIE_SECURE: 'false',
      PORT: String(WEB_PORT),
    },
  },
});
