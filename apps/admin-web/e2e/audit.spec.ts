import { expect, test } from '@playwright/test';

import { createLocation, gotoAs, provisionTenant } from './support/seed';

test('browse the audit log: filter, open an entry, read the before/after diff, verify the chain', async ({
  page,
}) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Paddington', 'paddo');
  await t.api(
    'PATCH',
    `/locations/${location.id}`,
    { name: 'Paddington Flagship' },
    { ifMatch: 1 },
  );

  await gotoAs(page, t.ownerTokens, '/audit');
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(page.getByRole('table', { name: 'Audit entries' })).toBeVisible();

  await page.getByLabel('Resource kind').fill('location');
  const rows = page.getByRole('table', { name: 'Audit entries' }).getByRole('row');
  await expect(rows).toHaveCount(3); // header + created + updated
  await expect(page.getByRole('button', { name: 'Remove filter Resource kind' })).toBeVisible();

  // Open the update entry and read the diff.
  await page
    .getByRole('button', { name: /location\.updated|tenancy\.location\.updated|\.updated$/ })
    .first()
    .click();
  const drawer = page.getByRole('dialog');
  const diff = drawer.getByRole('table', { name: 'Audit diff' });
  await expect(diff).toContainText('Paddington Flagship');
  await expect(diff).toContainText('changed');
  await expect(drawer.getByRole('list', { name: 'Changes to this resource' })).toContainText(
    'created',
  );
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.getByText(/Chain verified: \d+ entries checked/)).toBeVisible();

  // Filters live in chips; clearing returns every entry.
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(rows.nth(3)).toBeVisible();
});

test('cursor paging walks forward and back through the log', async ({ page }) => {
  const t = await provisionTenant();
  for (let i = 0; i < 12; i++) await createLocation(t, `Store ${i}`, `s${i}`);
  await gotoAs(page, t.ownerTokens, '/audit');
  await page.getByLabel('Rows per page').selectOption('10');
  await expect(page.getByText(/Page 1 · 10 rows/)).toBeVisible();
  const firstSeq = await page
    .getByRole('table', { name: 'Audit entries' })
    .getByRole('row')
    .nth(1)
    .getByRole('cell')
    .first()
    .textContent();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(/Page 2/)).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: 'Audit entries' })
      .getByRole('row')
      .nth(1)
      .getByRole('cell')
      .first(),
  ).not.toHaveText(firstSeq ?? '');
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText(/Page 1/)).toBeVisible();
});
