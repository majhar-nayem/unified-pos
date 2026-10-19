import { expect, test } from '@playwright/test';

import { createLocation, gotoAs, provisionTenant } from './support/seed';

test('clone a system role, edit its permissions and limits; system roles stay read-only', async ({
  page,
}) => {
  const t = await provisionTenant();
  await gotoAs(page, t.ownerTokens, '/roles');
  await page.getByRole('button', { name: 'Cashier', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Cashier' });
  await expect(drawer.getByText('System roles cannot be edited')).toBeVisible();
  await expect(drawer.getByRole('checkbox', { name: /approvals\.request/ })).toBeDisabled();

  await drawer.getByRole('button', { name: 'Clone role…' }).click();
  await drawer.getByLabel('Name').fill('Cashier plus');
  await drawer.getByLabel('Key').fill('cashier_plus');
  await drawer.getByRole('button', { name: 'Create copy' }).click();
  await expect(page.getByText('Role cloned')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Cashier plus' }).click();
  const copy = page.getByRole('dialog', { name: 'Cashier plus' });
  const perm = copy.getByRole('checkbox', { name: /orders\.refund\.create/ });
  await expect(perm).toBeEnabled();
  await perm.check();
  await copy.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText('Permissions saved')).toBeVisible();
  const input = copy.getByRole('spinbutton', { name: /Maximum discount percent/ });
  await input.fill('15');
  await copy.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByText('Limits saved')).toBeVisible();

  const roles = await t.api<
    { key: string; permissions: string[]; limits: Record<string, number> }[]
  >('GET', '/roles');
  const stored = roles.body.find((r) => r.key === 'cashier_plus')!;
  expect(stored.permissions).toContain('orders.refund.create');
  expect(stored.limits['orders.discount.max_percent']).toBe(15);
  // The system role it came from is untouched.
  expect(roles.body.find((r) => r.key === 'cashier')!.permissions).not.toContain(
    'orders.refund.create',
  );
});

test('a stale edit is refused with a clear message instead of overwriting a colleague', async ({
  page,
}) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Concurrent Cafe', 'cc');
  await gotoAs(page, t.ownerTokens, '/locations');
  await page.getByRole('button', { name: 'Concurrent Cafe' }).click();
  const drawer = page.getByRole('dialog', { name: 'Concurrent Cafe' });
  await drawer.getByLabel('Name').fill('My rename');

  // A colleague saves first, bumping the version.
  await t.api('PATCH', `/locations/${location.id}`, { name: 'Their rename' }, { ifMatch: 1 });

  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(drawer.getByRole('alert')).toContainText('Someone else changed this record');
  const now = await t.api<{ name: string; version: number }>('GET', `/locations/${location.id}`);
  expect(now.body).toMatchObject({ name: 'Their rename', version: 2 });
});
