import { expect, type APIRequestContext, type Page } from '@playwright/test';

export interface Seed {
  code: string;
  userId: string;
  pin: string;
  displayName: string;
}

export async function seed(request: APIRequestContext): Promise<Seed> {
  const response = await request.get('http://localhost:3100/__test/seed');
  return (await response.json()) as Seed;
}

export async function enrol(page: Page, s: Seed, name = 'Register 1'): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Enrol this register' })).toBeVisible();
  await page.getByLabel('Enrolment code').fill(s.code);
  await page.getByLabel('Register name').fill(name);
  await page.getByRole('button', { name: 'Enrol this register' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

export async function enterPin(page: Page, pin: string): Promise<void> {
  for (const digit of pin) await page.getByRole('button', { name: digit, exact: true }).click();
}

/** Staff ID is asked for the first time on a register; afterwards the name is a button. */
export async function signIn(page: Page, s: Seed, pin = s.pin): Promise<void> {
  const staffId = page.getByLabel('Staff ID');
  if (await staffId.isVisible()) await staffId.fill(s.userId);
  await enterPin(page, pin);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function enrolAndSignIn(page: Page, request: APIRequestContext): Promise<Seed> {
  const s = await seed(request);
  await enrol(page, s);
  await signIn(page, s);
  await expect(page.getByRole('heading', { name: /^Cart \(/ })).toBeVisible();
  return s;
}

/** Type a code the way a keyboard-wedge scanner does: all characters back to back, then Enter. */
export async function scan(page: Page, code: string): Promise<void> {
  await page.keyboard.type(code, { delay: 0 });
  await page.keyboard.press('Enter');
}
