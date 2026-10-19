import { expect, test } from '@playwright/test';

import { gotoAs, provisionTenant } from './support/seed';

test('create a location with deployment profile, time zone and business day boundary', async ({
  page,
}) => {
  const t = await provisionTenant();
  await gotoAs(page, t.ownerTokens, '/locations');
  await expect(page.getByText('No locations yet')).toBeVisible();

  await page.getByRole('button', { name: 'Add location' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Add location' });

  // Inline validation from the contract and the time zone check.
  await drawer.getByLabel('Name').fill('Newtown Cafe');
  await drawer.getByLabel(/^Code/).fill('bad code!');
  await drawer.getByLabel(/^Code/).blur();
  await expect(
    drawer.getByRole('alert').filter({ hasText: 'Letters, digits, _ and - only' }),
  ).toBeVisible();
  await drawer.getByLabel(/^Code/).fill('newtown');
  await drawer.getByLabel('Time zone').fill('Mars/Olympus');
  await drawer.getByLabel('Time zone').blur();
  await expect(drawer.getByRole('alert').filter({ hasText: /Unknown time zone/ })).toBeVisible();

  await drawer.getByLabel('Org unit').selectOption({ index: 1 });
  await drawer.getByLabel('Kind').selectOption('restaurant');
  await drawer.getByLabel('Deployment profile').selectOption('device_autonomous');
  await drawer.getByLabel('Time zone').fill('Australia/Sydney');
  await drawer.getByLabel('Business day boundary').fill('03:30');
  await drawer.getByRole('button', { name: 'Create location' }).click();

  await expect(page.getByText('Location created')).toBeVisible();
  // The drawer now shows the saved location.
  await expect(page.getByRole('dialog', { name: 'Newtown Cafe' })).toBeVisible();
  await page.keyboard.press('Escape');

  const row = page.getByRole('row', { name: /Newtown Cafe/ });
  await expect(row).toContainText('Restaurant');
  await expect(row).toContainText('Device autonomous');
  await expect(row).toContainText('Australia/Sydney');
  await expect(row).toContainText('03:30');

  // What the API stored matches what the form showed, and the write is audited with before/after.
  const list = await t.api<
    { code: string; deploymentProfile: string; businessDayBoundary: string }[]
  >('GET', '/locations');
  expect(list.body).toEqual([
    expect.objectContaining({
      code: 'newtown',
      deploymentProfile: 'device_autonomous',
      businessDayBoundary: '03:30',
    }),
  ]);
  const audit = await t.api<{ items: { action: string; after: unknown }[] }>(
    'GET',
    '/audit?resourceKind=location',
  );
  expect(audit.body.items.length).toBeGreaterThan(0);
});

test('a duplicate code comes back as a clear conflict message', async ({ page }) => {
  const t = await provisionTenant();
  await t.api('POST', '/locations', {
    orgUnitId: t.rootOrgUnitId,
    code: 'dup',
    name: 'First',
    kind: 'store',
    timezone: 'Australia/Sydney',
    currency: 'AUD',
  });
  await gotoAs(page, t.ownerTokens, '/locations');
  await page.getByRole('button', { name: 'Add location' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Add location' });
  await drawer.getByLabel('Name').fill('Second');
  await drawer.getByLabel(/^Code/).fill('dup');
  await drawer.getByLabel('Org unit').selectOption({ index: 1 });
  await drawer.getByRole('button', { name: 'Create location' }).click();
  await expect(drawer.getByRole('alert')).toBeVisible();
});
