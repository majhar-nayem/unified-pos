import { expect, test } from '@playwright/test';

import { PASSWORD, call, gotoAs, provisionTenant, totpFor } from './support/seed';

test('enrol a passkey with a virtual authenticator, then sign in with it as the second factor', async ({
  page,
  context,
}) => {
  const t = await provisionTenant();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await gotoAs(page, t.ownerTokens, '/account');
  await expect(page.getByRole('table', { name: 'Your credentials' })).toContainText(
    'Authenticator app',
  );
  await page.getByLabel('Name (optional)').fill('Virtual key');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('Passkey added')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Your credentials' })).toContainText('Virtual key');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Organisation').fill(t.slug);
  await page.getByLabel('Email').fill(t.ownerEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  // Sign-in returns to the page the person was on (the `next` parameter).
  await expect(page.getByRole('heading', { name: 'My account', level: 1 })).toBeVisible();
  const me = await call<{ mfaVerified: boolean }>('GET', '/auth/me', {
    token: (await context.cookies()).find((c) => c.name === 'pos_at')!.value,
  });
  expect(me.body.mfaVerified).toBe(true);
});

test('change the password and replace the authenticator from My account', async ({ page }) => {
  const t = await provisionTenant();
  await gotoAs(page, t.ownerTokens, '/account');

  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  const secret = await page.getByTestId('account-totp-secret').textContent();
  const next = totpFor(`otpauth://totp/x?secret=${secret}&period=30&digits=6&algorithm=SHA1`);
  await page.getByLabel('Code from the app').fill(next.code(0));
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Authenticator saved')).toBeVisible();

  const form = page.getByRole('form', { name: 'Change password' });
  await form.getByLabel('Current password').fill(PASSWORD);
  await form.getByLabel('New password', { exact: true }).fill('short');
  await form.getByLabel('New password', { exact: true }).blur();
  await expect(form.getByText('Must be at least 12 characters')).toBeVisible();
  await form.getByLabel('New password', { exact: true }).fill('a much longer new password');
  await form.getByLabel('Confirm new password').fill('different');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByText('Passwords do not match')).toBeVisible();
  await form.getByLabel('Confirm new password').fill('a much longer new password');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed')).toBeVisible();
  // The old password no longer works.
  const old = await call('POST', '/auth/login', {
    body: { tenantSlug: t.slug, email: t.ownerEmail, password: PASSWORD },
    expect: 401,
  });
  expect(old.status).toBe(401);
});
