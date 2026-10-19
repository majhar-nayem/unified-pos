import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

import {
  createApproval,
  createLocation,
  createStaff,
  gotoAs,
  provisionTenant,
} from './support/seed';

const PAGES = [
  ['/', 'Welcome'],
  ['/organisation', 'Organisation tree'],
  ['/legal-entities', 'Legal entities'],
  ['/locations', 'Locations'],
  ['/departments', 'Departments'],
  ['/registers', 'Registers'],
  ['/users', 'Users & invitations'],
  ['/roles', 'Roles & assignments'],
  ['/approvals', 'Approvals'],
  ['/devices', 'Devices'],
  ['/config', 'Configuration'],
  ['/audit', 'Audit log'],
] as const;

async function axe(page: Page, context: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  );
  expect(summary, `axe violations on ${context}`).toEqual([]);
}

test.describe('axe', () => {
  test('login and invitation pages', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in to POS Admin' })).toBeVisible();
    await axe(page, 'login');
    await page.goto('/accept-invite?token=abc');
    await expect(page.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
    await axe(page, 'accept-invite');
  });

  test('every console page with data, in light and dark', async ({ page }) => {
    const t = await provisionTenant();
    const location = await createLocation(t, 'Axe Store', 'axe');
    const cashier = await createStaff(t, 'Axe Cashier', {
      role: 'cashier',
      scope: { kind: 'location', id: location.id },
    });
    await createApproval(cashier, location.id);
    await t.api('PUT', '/config', {
      key: 'receipt.header',
      scopeKind: 'tenant',
      scopeId: t.tenantId,
      value: 'Hi',
    });
    await t.api('POST', `/locations/${location.id}/registers`, {
      code: 'R1',
      name: 'Register 1',
      kind: 'pos',
    });
    await t.api('POST', '/devices/enrollment-codes', { locationId: location.id, kind: 'pos' });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [path, heading] of PAGES) {
        await gotoAs(page, t.ownerTokens, path);
        await expect(
          page.getByRole('heading', { level: 1, name: new RegExp(heading) }),
        ).toBeVisible();
        await page.waitForLoadState('networkidle');
        await axe(page, `${path} (${scheme})`);
      }
    }
  });

  test('drawers and forms', async ({ page }) => {
    const t = await provisionTenant();
    const location = await createLocation(t, 'Axe Store', 'axe');
    await createStaff(t, 'Axe Person');
    await gotoAs(page, t.ownerTokens, '/locations');
    await page.getByRole('button', { name: 'Axe Store' }).click();
    await expect(page.getByRole('dialog', { name: 'Axe Store' })).toBeVisible();
    await axe(page, 'location drawer');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add location' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Add location' })).toBeVisible();
    await axe(page, 'add location drawer');
    await page.keyboard.press('Escape');

    await page.goto('/users');
    await page.getByRole('button', { name: 'Axe Person' }).click();
    const drawer = page.getByRole('dialog', { name: 'Axe Person' });
    await drawer.getByRole('tab', { name: 'Roles' }).click();
    await drawer.getByRole('button', { name: 'Assign a role' }).click();
    await drawer.getByLabel('Add a limit').selectOption({ index: 1 });
    await drawer.getByRole('button', { name: 'Add limit' }).click();
    await axe(page, 'assign role form');
    await drawer.getByRole('tab', { name: 'Credentials' }).click();
    await axe(page, 'credentials');
    void location;
  });
});

test('keyboard: skip link, drawer focus trap and Escape, table arrow keys', async ({ page }) => {
  const t = await provisionTenant();
  await createLocation(t, 'Kbd One', 'k1');
  await createLocation(t, 'Kbd Two', 'k2');
  await gotoAs(page, t.ownerTokens, '/locations');
  await expect(page.getByRole('button', { name: 'Kbd One' })).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

  const one = page.getByRole('button', { name: 'Kbd One' });
  await one.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Kbd Two' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(one).toBeFocused();

  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Kbd One' });
  await expect(drawer).toBeVisible();
  // Focus stays inside the dialog while tabbing through it.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
      true,
    );
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(one).toBeFocused();
});
