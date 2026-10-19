import { randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { PASSWORD, createLocation, call, gotoAs, provisionTenant } from './support/seed';

test('invite a user, accept the invitation, and see them become active', async ({
  page,
  browser,
}) => {
  const t = await provisionTenant();
  await gotoAs(page, t.ownerTokens, '/users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  const drawer = page.getByRole('dialog', { name: 'Invite a user' });
  await drawer.getByLabel('Name').fill('Ivy Invitee');
  await drawer.getByLabel('Email').fill('not-an-email');
  await drawer.getByRole('button', { name: 'Create invitation' }).click();
  await expect(drawer.getByText('Enter a valid email address')).toBeVisible();
  await drawer.getByLabel('Email').fill(`ivy@${t.slug}.test`);
  await drawer.getByRole('button', { name: 'Create invitation' }).click();

  const link = await drawer.getByTestId('invite-link').textContent();
  expect(link).toContain('/accept-invite?token=');
  await drawer.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: /Ivy Invitee/ })).toContainText('invited');
  await expect(page.getByText('1 pending invitation')).toBeVisible();

  // The invitee opens the link in their own browser.
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(link!);
  await guestPage.getByLabel('Choose a password').fill(PASSWORD);
  await guestPage.getByLabel('Confirm password').fill('something else entirely');
  await guestPage.getByRole('button', { name: 'Set password' }).click();
  await expect(guestPage.getByText('Passwords do not match')).toBeVisible();
  await guestPage.getByLabel('Confirm password').fill(PASSWORD);
  await guestPage.getByRole('button', { name: 'Set password' }).click();
  await expect(guestPage.getByRole('heading', { name: 'Password set' })).toBeVisible();
  await guest.close();

  await page.reload();
  await expect(page.getByRole('row', { name: /Ivy Invitee/ })).toContainText('active');
});

test('credentials: reset a password and sign the user out everywhere', async ({ page }) => {
  const t = await provisionTenant();
  const email = `ken@${t.slug}.test`;
  const created = await t.api<{ id: string }>('POST', '/users', {
    email,
    displayName: 'Ken Keys',
    password: PASSWORD,
  });
  await gotoAs(page, t.ownerTokens, '/users');
  await page.getByRole('button', { name: 'Ken Keys' }).click();
  const drawer = page.getByRole('dialog', { name: 'Ken Keys' });
  await drawer.getByRole('tab', { name: 'Credentials' }).click();
  await expect(drawer.getByRole('table', { name: 'Credentials' })).toContainText('Password');

  await drawer.getByRole('button', { name: 'Reset password…' }).click();
  await drawer.getByLabel('New password').fill('short');
  await drawer.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(drawer.getByText('Must be at least 12 characters')).toBeVisible();
  await drawer.getByLabel('New password').fill('a brand new long password');
  await drawer.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByText('Password reset. Their sessions were signed out.')).toBeVisible();
  const old = await call('POST', '/auth/login', {
    body: { tenantSlug: t.slug, email, password: PASSWORD },
    expect: 401,
  });
  expect(old.status).toBe(401);
  const fresh = await call<{ status: string }>('POST', '/auth/login', {
    body: { tenantSlug: t.slug, email, password: 'a brand new long password' },
  });
  expect(fresh.body.status).toBe('authenticated');

  await drawer.getByRole('button', { name: 'Sign out everywhere…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText(/Signed out \d+ sessions?/)).toBeVisible();
  void created;
});

test('devices: generate an enrolment code, then revoke an enrolled device with a reason', async ({
  page,
}) => {
  const t = await provisionTenant();
  const location = await createLocation(t, 'Device Store', 'dev');
  await gotoAs(page, t.ownerTokens, '/devices');
  await expect(page.getByText('No devices enrolled')).toBeVisible();

  await page.getByRole('button', { name: 'Generate enrolment code' }).first().click();
  const form = page.getByRole('form', { name: 'Generate enrolment code' });
  await form.getByRole('button', { name: 'Generate code' }).click();
  await expect(form.getByText('Choose an option')).toBeVisible();
  await form.getByLabel('Location').selectOption({ label: 'Device Store' });
  await form.getByLabel('Device kind').selectOption('kds');
  await form.getByRole('button', { name: 'Generate code' }).click();
  const code = await page.getByTestId('enrolment-code').textContent();
  expect(code).toMatch(new RegExp(`^${t.slug}\\.[0-9A-Z]{12}$`));

  // Enrol a device with that code the way the POS shell will, then see it in the list.
  const enrol = await call<{ device: { id: string } }>('POST', '/auth/device/enroll', {
    body: {
      enrollmentCode: code,
      publicKey: randomBytes(32).toString('base64'),
      name: 'Kitchen screen',
      platform: 'android',
      appVersion: '1.0.0',
    },
  });
  await page.getByRole('tab', { name: /^Devices/ }).click();
  const row = page.getByRole('row', { name: /Kitchen screen/ });
  await expect(row).toContainText('Never connected');
  await expect(page.getByText('1 device needs attention')).toBeVisible();

  await row.getByRole('button', { name: 'Kitchen screen' }).click();
  const drawer = page.getByRole('dialog', { name: 'Kitchen screen' });
  await drawer.getByLabel('Also request a remote wipe').check();
  await drawer.getByRole('button', { name: 'Revoke device…' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByLabel('Reason (kept in the audit log)').fill('lost in transit');
  await confirm.getByRole('button', { name: 'Revoke device' }).click();
  await expect(page.getByText('Device revoked and wipe requested')).toBeVisible();

  const device = await t.api<{ enrollmentStatus: string }>(
    'GET',
    `/devices/${enrol.body.device.id}`,
  );
  expect(device.body.enrollmentStatus).toBe('revoked');
  const audit = await t.api<{ items: { reason: string | null }[] }>(
    'GET',
    `/audit?action=devices.revoked`,
  );
  expect(audit.body.items[0]?.reason).toBe('[wipe requested] lost in transit');
  void location;
});
