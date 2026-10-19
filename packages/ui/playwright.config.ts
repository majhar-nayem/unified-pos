import { defineConfig, devices } from '@playwright/test';

const port = 6007;

// Visual baselines are per platform (font rendering differs). Commit the ones CI uses; regenerate with
// `pnpm --filter @pos/ui test:visual:update` on that platform. PW_CHROMIUM_PATH points at an existing
// Chromium when the version Playwright expects is not installed.
export default defineConfig({
  testDir: 'playwright',
  snapshotPathTemplate: '{testDir}/__snapshots__/{platform}/{arg}{ext}',
  fullyParallel: true,
  outputDir: 'node_modules/.cache/playwright-results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'node_modules/.cache/playwright-report' }],
  ],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' } },
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 800, height: 600 },
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 800, height: 600 },
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: `node scripts/serve-static.mjs node_modules/.cache/storybook-static ${port}`,
    url: `http://localhost:${port}/index.json`,
    reuseExistingServer: true,
  },
});
