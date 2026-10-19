import { expect, test } from '@playwright/test';

import { createLocation, gotoAs, provisionTenant } from './support/seed';

test('reparent an org unit; moving under its own child is not offered', async ({ page }) => {
  const t = await provisionTenant();
  const mk = async (name: string, code: string, parentId: string) =>
    (await t.api<{ id: string }>('POST', '/org-units', { parentId, kind: 'region', code, name }))
      .body.id;
  const north = await mk('North region', 'north', t.rootOrgUnitId);
  const south = await mk('South region', 'south', t.rootOrgUnitId);
  const sub = await mk('North sub', 'north-sub', north);
  void south;
  await createLocation(t, 'Tree Store', 'tree');

  await gotoAs(page, t.ownerTokens, '/organisation');
  const tree = page.getByRole('tree', { name: 'Organisation units' });
  await expect(tree.getByRole('treeitem', { name: /North sub/ })).toBeVisible();

  // Collapse and expand with the toggle.
  await page.getByRole('button', { name: 'Collapse North region' }).click();
  await expect(tree.getByRole('button', { name: 'North sub', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand North region' }).click();

  await tree.getByRole('button', { name: 'North region', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'North region' });
  const parent = drawer.getByLabel('New parent');
  await expect(parent.locator('option', { hasText: 'North sub' })).toHaveCount(0); // a descendant
  await expect(parent.locator('option', { hasText: 'North region' })).toHaveCount(0); // itself
  await parent.selectOption({ label: 'South region (Region)' });
  await drawer.getByRole('button', { name: 'Move unit' }).click();
  await expect(page.getByText('Organisation unit moved')).toBeVisible();
  await page.keyboard.press('Escape');

  // The moved unit and its child now sit under South.
  const south2 = tree.getByRole('treeitem', { name: /South region/ });
  await expect(south2.getByRole('treeitem', { name: /North region/ })).toBeVisible();
  await expect(south2.getByRole('treeitem', { name: /North sub/ })).toBeVisible();

  const units = await t.api<{ id: string; parentId: string | null }[]>('GET', '/org-units');
  expect(units.body.find((u) => u.id === north)?.parentId).toBe(south);
  expect(units.body.find((u) => u.id === sub)?.parentId).toBe(north);
});

test('legal entity and register forms save through the API', async ({ page }) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Reg Store', 'reg');
  await gotoAs(page, t.ownerTokens, '/legal-entities');
  await expect(page.getByText('No legal entities yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add legal entity' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Add legal entity' });
  await drawer.getByLabel('Legal name').fill('Acme Pty Ltd');
  await drawer.getByLabel('Tax registration no. (ABN)').fill('12 345 678 901');
  await drawer.getByLabel('City').fill('Sydney');
  await drawer.getByRole('button', { name: 'Create legal entity' }).click();
  await expect(page.getByText('Legal entity created')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: /Acme Pty Ltd/ })).toContainText('12 345 678 901');

  await page.goto('/registers');
  await page.getByRole('button', { name: 'Add register' }).first().click();
  const reg = page.getByRole('dialog', { name: 'Add register' });
  await reg.getByLabel('Location').selectOption({ label: 'Reg Store' });
  await reg.getByLabel('Name').fill('Front counter');
  await reg.getByLabel(/^Code/).fill('R1');
  await reg.getByRole('button', { name: 'Create register' }).click();
  await expect(page.getByText('Register created')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: /Front counter/ })).toContainText('Reg Store');
  const regs = await t.api<{ locationId: string; code: string }[]>('GET', '/registers');
  expect(regs.body).toEqual([expect.objectContaining({ locationId: location.id, code: 'R1' })]);

  await page.goto('/departments');
  await page.getByRole('button', { name: 'Add department' }).first().click();
  const dep = page.getByRole('dialog', { name: 'Add department' });
  await dep.getByLabel('Name').fill('Bar');
  await dep.getByLabel(/^Code/).fill('bar');
  await dep.getByLabel('Kind').selectOption('bar');
  await dep.getByRole('button', { name: 'Create department' }).click();
  await expect(page.getByText('Department created')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: /Bar/ })).toContainText('bar');
});
