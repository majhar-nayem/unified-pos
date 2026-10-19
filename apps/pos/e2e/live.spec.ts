/**
 * Live check against a real apps/api (docker compose infra + migrated database):
 *
 *   node scripts/seed-dev.mjs > seed.json                       # prints a one-time code and the cashier id
 *   POS_LIVE_API_URL=http://localhost:3010 POS_LIVE_CODE=... POS_LIVE_USER=... POS_LIVE_PIN=... \
 *     pnpm exec playwright test e2e/live.spec.ts
 *
 * Skipped unless POS_LIVE_CODE is set. The code works once, so run it right after seeding.
 */
import { expect, test } from '@playwright/test';

import { enterPin, scan } from './helpers.js';

const code = process.env.POS_LIVE_CODE;
const userId = process.env.POS_LIVE_USER;
const pin = process.env.POS_LIVE_PIN ?? '4821';

test.skip(!code || !userId, 'set POS_LIVE_CODE and POS_LIVE_USER (see the header of this file)');
test.use({ viewport: { width: 1920, height: 1080 } });

test('live: enrol with a real one-time code, PIN login, refresh rotation, scan, lockout', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByLabel('Enrolment code').fill(code!);
  await page.getByRole('button', { name: 'Enrol this register' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(/Register 1 · Location/)).toBeVisible();

  // The same code cannot enrol a second device.
  const reuse = await request.post(`${process.env.POS_LIVE_API_URL}/v1/auth/device/enroll`, {
    data: {
      enrollmentCode: code,
      publicKey: Buffer.alloc(32, 7).toString('base64'),
      name: 'Second',
      platform: 'web',
      appVersion: '0',
    },
  });
  expect(reuse.status()).toBe(404);

  // Real PIN login through the device-bound session.
  await page.getByLabel('Staff ID').fill(userId!);
  await enterPin(page, pin);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /^Cart \(/ })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Connection: Online' })).toBeVisible();

  // The real server knows the cashier's name (GET /v1/users/me), and the shell remembers it.
  await expect(page.getByText('Cashier: Priya Patel')).toBeVisible({ timeout: 10_000 });

  // Refresh token rotation against the real server keeps the session.
  const before = await page.evaluate(() => localStorage.getItem('pos.secret.staff-refresh-token'));
  await page.evaluate(() =>
    (
      window as unknown as { __pos: { session: { refresh: () => Promise<void> } } }
    ).__pos.session.refresh(),
  );
  const after = await page.evaluate(() => localStorage.getItem('pos.secret.staff-refresh-token'));
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);
  await expect(page.getByRole('heading', { name: /^Cart \(/ })).toBeVisible();

  // No change feed on the server yet: the shell says so and works from the stub catalogue.
  await expect(
    page.getByText('Demo catalogue: the server has no catalogue feed yet'),
  ).toBeVisible();
  await scan(page, '9300675024235');
  await expect(page.getByRole('heading', { name: 'Cart (1 item)' })).toBeVisible();
  // ...and no sync endpoint either, so the command stays local and is counted.
  await expect(page.getByRole('status', { name: 'Unsynced: 1' })).toBeVisible();

  // Sign out and back in as the remembered cashier.
  await page.getByRole('button', { name: '☰ Menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Priya Patel' })).toBeVisible();

  // After a reload the in-memory device token is gone: the next sign-in signs a real server nonce with the
  // device key (GET challenge, POST login) and the server verifies the Ed25519 signature.
  await page.reload();
  // The browser dev build keeps the staff list in memory, so after a reload the id is typed again.
  await page.getByLabel('Staff ID').fill(userId!);
  const challenge = page.waitForResponse((r) => r.url().includes('/v1/auth/device/challenge'));
  const deviceLogin = page.waitForResponse((r) => r.url().includes('/v1/auth/device/login'));
  await enterPin(page, pin);
  await page.getByRole('button', { name: 'Sign in' }).click();
  expect((await challenge).status()).toBe(200);
  expect((await deviceLogin).status()).toBe(200);
  await expect(page.getByRole('heading', { name: /^Cart \(/ })).toBeVisible();
  await page.getByRole('button', { name: '☰ Menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  // Wrong PINs until the server's lockout policy (identity.pin.*) answers 423.
  const statuses: number[] = [];
  for (let i = 0; i < 12 && !statuses.includes(423); i++) {
    await enterPin(page, '0000');
    const answered = page.waitForResponse((r) => r.url().includes('/v1/auth/pin'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    statuses.push((await answered).status());
  }
  expect(statuses.at(-1)).toBe(423);
  expect(statuses.slice(0, -1).every((s) => s === 401)).toBe(true);
  await expect(page.getByText('Too many wrong PINs.').first()).toBeVisible();
  await expect(page.getByText(/Try again in \d+:\d\d/)).toBeVisible();
  await expect(page.getByRole('button', { name: '5', exact: true })).toBeDisabled();
});
