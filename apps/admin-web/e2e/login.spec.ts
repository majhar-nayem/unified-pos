import { expect, test } from '@playwright/test';

import { PASSWORD, provisionTenant, totpFor } from './support/seed';

test('first sign-in enrols an authenticator, then a later sign-in uses the code', async ({
  page,
}) => {
  const t = await provisionTenant({ enrolOwner: false });

  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?next|\/login$/);

  await page.getByLabel('Organisation').fill(t.slug);
  await page.getByLabel('Email').fill(t.ownerEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();

  // The owner holds *.admin permissions, so a second factor is mandatory.
  await expect(page.getByText('Your roles require a second factor')).toBeVisible();
  const uri = await page.getByTestId('otpauth-uri').getAttribute('href');
  const totp = totpFor(uri!);
  await page.getByLabel('Code from the app').fill(totp.code(0));
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();

  await expect(page.getByText('Authenticator saved')).toBeVisible();
  await page.getByLabel('Authenticator code').fill(totp.code(1));
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByRole('heading', { name: /Welcome, Olive/ })).toBeVisible();
  await expect(page.getByTestId('tenant-name')).toHaveText(t.name);
  // The tokens live in httpOnly cookies: page scripts cannot read them.
  expect(await page.evaluate(() => document.cookie)).not.toContain('pos_at');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/locations');
  await expect(page).toHaveURL(/\/login\?next=%2Flocations/);

  // Second sign-in: the enrolled owner goes straight to the code prompt.
  await page.getByLabel('Organisation').fill(t.slug);
  await page.getByLabel('Email').fill(t.ownerEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(totp.code(-1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/locations$/);
  await expect(page.getByRole('heading', { name: 'Locations', level: 1 })).toBeVisible();
});

test('wrong password and wrong code show inline errors without leaking which part was wrong', async ({
  page,
}) => {
  const t = await provisionTenant();
  await page.goto('/login');
  await page.getByLabel('Organisation').fill(t.slug);
  await page.getByLabel('Email').fill(t.ownerEmail);
  await page.getByLabel('Password').fill('not the right password');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.alert-danger')).toContainText(
    'Email, password or organisation is incorrect',
  );

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('.alert-danger')).toContainText('That code was not accepted');
});

test('the form validates from the contract before calling the API', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Must be at least 3 characters')).toBeVisible();
  await expect(page.getByText('Enter a valid email address')).toBeVisible();
  await expect(page.getByText('Required', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Organisation')).toHaveAttribute('aria-invalid', 'true');
  // Fixing a field clears its message as you type.
  await page.getByLabel('Organisation').fill('acme');
  await expect(page.getByText('Must be at least 3 characters')).toHaveCount(0);
});
