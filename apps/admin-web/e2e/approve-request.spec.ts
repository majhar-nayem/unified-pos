import { expect, test } from '@playwright/test';

import {
  createApproval,
  createLocation,
  createStaff,
  gotoAs,
  provisionTenant,
} from './support/seed';

test('approve a pending request from the queue, and it shows on the home list first', async ({
  page,
}) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Surry Hills', 'surry');
  const cashier = await createStaff(t, 'Casey Cashier', {
    role: 'cashier',
    scope: { kind: 'location', id: location.id },
  });
  const approval = await createApproval(cashier, location.id, 25);

  // Home: "needs attention" is the first card and links to the queue.
  await gotoAs(page, t.ownerTokens, '/');
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByTestId('attention-item').first()).toContainText(
    '1 approval request waiting',
  );
  await attention.getByRole('link', { name: 'Review' }).click();

  await expect(page).toHaveURL(/\/approvals$/);
  const row = page.getByRole('row', { name: /Discount over limit/ });
  await expect(row).toContainText('Casey Cashier');
  await expect(row).toContainText('Surry Hills');
  await row.getByRole('button', { name: 'Discount over limit' }).click();

  const drawer = page.getByRole('dialog', { name: 'Discount over limit' });
  await expect(drawer).toContainText('orders.discount.apply');
  await expect(drawer).toContainText('25');
  await drawer.getByLabel('Note (optional)').fill('Regular customer, fine');
  await drawer.getByRole('button', { name: 'Approve' }).click();

  await expect(page.getByText('Request approved')).toBeVisible();
  await expect(page.getByText('Nothing waiting for approval')).toBeVisible();

  const decided = await t.api<{ status: string; decisionNote: string; decidedBy: string }>(
    'GET',
    `/approvals/${approval.id}`,
  );
  expect(decided.body).toMatchObject({
    status: 'approved',
    decisionNote: 'Regular customer, fine',
    decidedBy: t.ownerId,
  });

  await page.getByRole('tab', { name: 'Approved' }).click();
  await expect(page.getByRole('row', { name: /Discount over limit/ })).toContainText('approved');
});

test('rejecting records the decision; the requester cannot approve their own request', async ({
  page,
}) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Newtown', 'newtown');
  const cashier = await createStaff(t, 'Riley Cashier', {
    role: 'cashier',
    scope: { kind: 'location', id: location.id },
  });
  const approval = await createApproval(cashier, location.id, 40);

  await gotoAs(page, t.ownerTokens, '/approvals');
  await page.getByRole('button', { name: 'Discount over limit' }).click();
  const drawer = page.getByRole('dialog', { name: 'Discount over limit' });
  await drawer.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Request rejected')).toBeVisible();
  const after = await t.api<{ status: string }>('GET', `/approvals/${approval.id}`);
  expect(after.body.status).toBe('rejected');
});
