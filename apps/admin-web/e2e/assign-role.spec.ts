import { expect, test } from '@playwright/test';

import { createLocation, createStaff, gotoAs, provisionTenant } from './support/seed';

test('assign a role at a location with a discount limit, then revoke it', async ({ page }) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Bondi Store', 'bondi');
  const sam = await createStaff(t, 'Sam Cashier');

  await gotoAs(page, t.ownerTokens, '/users');
  await page.getByRole('button', { name: 'Sam Cashier' }).click();
  const drawer = page.getByRole('dialog', { name: 'Sam Cashier' });
  await drawer.getByRole('tab', { name: 'Roles' }).click();
  await expect(drawer.getByText('This user holds no roles')).toBeVisible();

  await drawer.getByRole('button', { name: 'Assign a role' }).click();
  const form = drawer.getByRole('form', { name: 'Assign a role' });
  await form.getByLabel('Role').selectOption({ label: 'Cashier' });
  await expect(form.getByTestId('effective-limits')).toContainText(
    'orders.discount.max_percent ≤ 10',
  );

  // Scope picker: location kind is the default; choose the concrete location.
  await form.getByLabel('Location', { exact: true }).selectOption({ label: 'Bondi Store' });

  // Limits editor: tighten the role's 10% discount cap to 5%.
  await form.getByLabel('Add a limit').selectOption('orders.discount.max_percent');
  await form.getByRole('button', { name: 'Add limit' }).click();
  await form
    .getByRole('spinbutton', {
      name: 'Maximum discount percent that may be applied without approval',
    })
    .fill('5');
  await expect(form.getByText('Role default: 10')).toBeVisible();
  await expect(form.getByTestId('effective-limits')).toContainText(
    'orders.discount.max_percent ≤ 5',
  );
  await form.getByLabel('Reason').fill('new hire at Bondi');
  await form.getByRole('button', { name: 'Assign role' }).click();

  await expect(page.getByText('Role assigned')).toBeVisible();
  const table = drawer.getByRole('table', { name: 'Role assignments' });
  await expect(table).toContainText('Cashier');
  await expect(table).toContainText('Location: Bondi Store');
  await expect(table).toContainText('orders.discount.max_percent ≤ 5');

  const stored = await t.api<
    { roleKey: string; limits: Record<string, number>; scope: { kind: string; id: string } }[]
  >('GET', `/role-assignments?userId=${sam.id}`);
  expect(stored.body).toEqual([
    expect.objectContaining({
      roleKey: 'cashier',
      limits: { 'orders.discount.max_percent': 5 },
      scope: { kind: 'location', id: location.id },
    }),
  ]);

  // Revoking is destructive, so it asks first.
  await table.getByRole('button', { name: 'Revoke cashier' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('stop applying to this user immediately');
  await confirm.getByRole('button', { name: 'Revoke role' }).click();
  await expect(page.getByText('Role assignment revoked')).toBeVisible();
  await expect(drawer.getByText('This user holds no roles')).toBeVisible();
});

test('the assignment form rejects a missing role and scope inline', async ({ page }) => {
  const t = await provisionTenant();
  await createStaff(t, 'Pat Nobody');
  await gotoAs(page, t.ownerTokens, '/users');
  await page.getByRole('button', { name: 'Pat Nobody' }).click();
  const drawer = page.getByRole('dialog', { name: 'Pat Nobody' });
  await drawer.getByRole('tab', { name: 'Roles' }).click();
  await drawer.getByRole('button', { name: 'Assign a role' }).click();
  await drawer.getByRole('button', { name: 'Assign role' }).click();
  await expect(
    drawer.getByRole('form', { name: 'Assign a role' }).getByRole('alert').first(),
  ).toBeVisible();
});
