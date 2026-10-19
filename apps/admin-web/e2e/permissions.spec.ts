import { expect, test } from '@playwright/test';

import { call, createLocation, createStaff, gotoAs, provisionTenant } from './support/seed';

test('navigation and actions follow the server policy for a store manager', async ({ page }) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Coogee', 'coogee');
  const manager = await createStaff(t, 'Morgan Manager', {
    role: 'store_manager',
    scope: { kind: 'location', id: location.id },
  });

  await gotoAs(page, manager.tokens, '/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  // store_manager holds these view permissions...
  for (const link of [
    'Home',
    'Organisation tree',
    'Legal entities',
    'Locations',
    'Departments',
    'Registers',
    'Users & invitations',
    'Approvals',
    'Devices',
  ]) {
    await expect(nav.getByRole('link', { name: link })).toBeVisible();
  }
  // ...and none of these.
  for (const link of ['Audit log', 'Configuration', 'Roles & assignments']) {
    await expect(nav.getByRole('link', { name: link })).toHaveCount(0);
  }
  // Server agrees: the same permission keys decide, so a direct call is refused too.
  expect(
    (await call('GET', '/audit', { token: manager.tokens.accessToken, expect: 403 })).status,
  ).toBe(403);
  expect(
    (
      await call('GET', '/config?key=receipt.header&scopeKind=tenant&scopeId=' + t.tenantId, {
        token: manager.tokens.accessToken,
        expect: [403, 404],
      })
    ).status,
  ).toBeGreaterThanOrEqual(403);

  // Typing the URL does not open a page the role cannot use.
  await page.goto('/audit');
  await expect(page.getByText('Your roles do not include access to this page')).toBeVisible();

  // Page-level buttons: can view locations but not manage them.
  await page.getByRole('link', { name: 'Locations' }).click();
  await expect(page.getByRole('heading', { name: 'Locations', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add location' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Coogee' })).toBeVisible();
  await page.getByRole('button', { name: 'Coogee' }).click();
  await expect(page.getByText('You can view this location but not change it.')).toBeVisible();
  expect(
    (
      await call('POST', '/locations', {
        token: manager.tokens.accessToken,
        body: {
          orgUnitId: t.rootOrgUnitId,
          code: 'x',
          name: 'x',
          kind: 'store',
          timezone: 'UTC',
          currency: 'AUD',
        },
        expect: [403, 404],
      })
    ).status,
  ).toBeGreaterThanOrEqual(403);
});

test('the owner sees every section', async ({ page }) => {
  const t = await provisionTenant();
  await gotoAs(page, t.ownerTokens, '/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const link of [
    'Home',
    'Organisation tree',
    'Legal entities',
    'Locations',
    'Departments',
    'Registers',
    'Users & invitations',
    'Roles & assignments',
    'Approvals',
    'Devices',
    'Configuration',
    'Audit log',
  ]) {
    await expect(nav.getByRole('link', { name: link })).toBeVisible();
  }
});

test('the proxy refuses dot segments that would climb out of /v1', async ({ request }) => {
  for (const path of ['/api/v1/..%2Fhealth', '/api/v1/%2e%2e/health']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect([404, 400]).toContain(res.status());
  }
});
