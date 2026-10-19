import { expect, test } from '@playwright/test';

import { createLocation, gotoAs, provisionTenant } from './support/seed';

test('compare versions and roll back; the effective value follows', async ({ page }) => {
  const t = await provisionTenant();
  const put = (value: string, reason: string) =>
    t.api('PUT', '/config', {
      key: 'receipt.header',
      scopeKind: 'tenant',
      scopeId: t.tenantId,
      value,
      reason,
    });
  await put('Welcome to Acme', 'first header');
  await put('Thanks for visiting!', 'second header');

  await gotoAs(page, t.ownerTokens, '/config');
  await expect(page.getByTestId('effective-value')).toContainText('"Thanks for visiting!"');
  const v2 = page.getByTestId('version-2');
  await expect(v2).toContainText('Current');
  await expect(page.getByTestId('version-1')).toContainText('Welcome to Acme');

  // Diff against the current value.
  await page.getByRole('button', { name: 'Compare version 1 with current' }).click();
  const diff = page.getByRole('table', { name: 'Config diff' });
  await expect(diff).toContainText('"Welcome to Acme"');
  await expect(diff).toContainText('"Thanks for visiting!"');
  await expect(diff).toContainText('changed');

  // Roll back: saved as a new version, nothing deleted.
  await page.getByRole('button', { name: 'Roll back to version 1' }).click();
  await expect(page.getByText('Rolled back: saved as version 3')).toBeVisible();
  await expect(page.getByTestId('effective-value')).toContainText('"Welcome to Acme"');
  await expect(page.getByTestId('version-3')).toContainText('Current');
  await expect(page.getByTestId('version-3')).toContainText('Rollback to version 1');
  await expect(page.getByTestId('version-2')).toBeVisible();

  const history = await t.api<{ version: number; isCurrent: boolean; value: string }[]>(
    'GET',
    `/config/history?key=receipt.header&scopeKind=tenant&scopeId=${t.tenantId}`,
  );
  expect(history.body.map((e) => [e.version, e.isCurrent, e.value])).toEqual([
    [3, true, 'Welcome to Acme'],
    [2, false, 'Thanks for visiting!'],
    [1, false, 'Welcome to Acme'],
  ]);
});

test('scope resolution preview shows the nearest override winning at a location', async ({
  page,
}) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Manly', 'manly');
  await t.api('PUT', '/config', {
    key: 'receipt.header',
    scopeKind: 'tenant',
    scopeId: t.tenantId,
    value: 'Tenant header',
  });
  await t.api('PUT', '/config', {
    key: 'receipt.header',
    scopeKind: 'location',
    scopeId: location.id,
    value: 'Manly header',
  });

  await gotoAs(page, t.ownerTokens, '/config');
  await page.getByLabel('Applies to').selectOption('location');
  await page.getByLabel('Location', { exact: true }).selectOption({ label: 'Manly' });

  await expect(page.getByTestId('effective-value')).toContainText('"Manly header"');
  const tenantRow = page.getByTestId('path-tenant');
  const locationRow = page.getByTestId('path-location');
  await expect(tenantRow).toContainText('Tenant header');
  await expect(tenantRow).toContainText('Overridden');
  await expect(locationRow).toContainText('Manly header');
  await expect(locationRow).toContainText('Wins');
});

test('the value form validates against the key schema before saving', async ({ page }) => {
  const t = await provisionTenant();
  await gotoAs(page, t.ownerTokens, '/config');
  await page.getByLabel('Setting', { exact: true }).selectOption('identity.pin.max_attempts');
  await page.getByLabel('Value', { exact: true }).fill('99');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText(/<=\s*20|at most 20|Too big/i)).toBeVisible();
  await page.getByLabel('Value', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('Configuration saved as a new version')).toBeVisible();
  await expect(page.getByTestId('effective-value')).toContainText('7');
});
