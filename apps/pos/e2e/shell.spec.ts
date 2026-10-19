import { expect, test } from '@playwright/test';

import { enrol, enrolAndSignIn, enterPin, scan, seed, signIn } from './helpers.js';

test.use({ viewport: { width: 1920, height: 1080 } });

test.describe('enrolment → PIN login → shell', () => {
  test('a new register enrols with a one-time code, then signs a cashier in with a PIN', async ({
    page,
    request,
  }) => {
    const s = await seed(request);
    await enrol(page, s);
    await signIn(page, s);
    await expect(page.getByRole('heading', { name: 'Cart (0 items)' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Connection: Online' })).toBeVisible();
    await expect(page.getByText('Cashier:')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Unsynced: 0' })).toBeVisible();
  });

  test('a used enrolment code is refused with an explanation', async ({ page, request }) => {
    const s = await seed(request);
    await enrol(page, s);
    await page.evaluate(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('pos-simulated-keychain');
    });
    await page.goto('/');
    await page.getByLabel('Enrolment code').fill(s.code);
    await page.getByRole('button', { name: 'Enrol this register' }).click();
    await expect(page.getByRole('alert')).toContainText('invalid, used or expired');
  });

  test('wrong PINs lock the screen with a countdown and the keypad is disabled', async ({
    page,
    request,
  }) => {
    const s = await seed(request);
    await enrol(page, s);
    for (let i = 0; i < 3; i++) await signIn(page, s, '0000');
    const lock = page.getByRole('alert').filter({ hasText: 'Too many wrong PINs.' });
    await expect(lock.first()).toBeVisible();
    await expect(page.getByText(/Try again in 1:\d\d|Try again in 2:00/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '5', exact: true })).toBeDisabled();
  });

  test('a bad PIN shows a message and the screen clears the entry', async ({ page, request }) => {
    const s = await seed(request);
    await enrol(page, s);
    await signIn(page, s, '9999');
    await expect(page.getByText('Wrong PIN. Try again.')).toBeVisible();
    await expect(page.getByLabel('PIN (4 to 8 digits)')).toHaveValue('');
  });

  test('the session survives a reload (refresh token in the simulated keychain)', async ({
    page,
    request,
  }) => {
    await enrolAndSignIn(page, request);
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Cart \(/ })).toBeVisible();
  });

  test('sign out returns to the PIN screen with the cashier remembered by name', async ({
    page,
    request,
  }) => {
    const s = await enrolAndSignIn(page, request);
    await page.getByRole('button', { name: '☰ Menu' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: s.displayName })).toBeVisible();
    await enterPin(page, s.pin);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: /^Cart \(/ })).toBeVisible();
  });
});

test.describe('scanner events', () => {
  test('a wedge scan adds a line without focus; repeating the scan increments the quantity', async ({
    page,
    request,
  }) => {
    await enrolAndSignIn(page, request);
    await scan(page, '9300675024235');
    await expect(page.getByRole('heading', { name: 'Cart (1 item)' })).toBeVisible();
    const lines = page.getByRole('list', { name: 'Order lines' });
    await expect(lines).toContainText('Oat Milk 1L');
    await scan(page, '9300675024235');
    await expect(page.getByRole('heading', { name: 'Cart (2 items)' })).toBeVisible();
    await expect(lines).toContainText('2 × 4.50');
    await expect(page.getByRole('status', { name: 'Unsynced: 2' })).toBeVisible();
  });

  test('the scan Enter never presses the focused button', async ({ page, request }) => {
    await enrolAndSignIn(page, request);
    await page.getByRole('button', { name: 'Void order' }).focus();
    await scan(page, '9300675024242');
    await expect(page.getByRole('heading', { name: 'Cart (1 item)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Void order' })).toBeVisible(); // would read "Tap again to void" if pressed
  });

  test('an unknown barcode is reported and nothing is added', async ({ page, request }) => {
    await enrolAndSignIn(page, request);
    await scan(page, '0000000000000');
    await expect(page.getByText('No product with code 0000000000000.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cart (0 items)' })).toBeVisible();
  });

  test('slow human typing outside a field is not treated as a scan', async ({ page, request }) => {
    await enrolAndSignIn(page, request);
    await page.keyboard.type('9300675024235', { delay: 120 });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Cart (0 items)' })).toBeVisible();
  });

  test('typing in the search field filters products and Enter on one match adds it', async ({
    page,
    request,
  }) => {
    await enrolAndSignIn(page, request);
    const search = page.getByRole('searchbox');
    await search.fill('croiss');
    await expect(page.getByRole('button', { name: /Croissant/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Bagels/ })).toHaveCount(0);
    await search.press('Enter');
    await expect(page.getByRole('list', { name: 'Order lines' })).toContainText('Croissant');
  });

  test('tapping a tile adds the product and a line can be removed inline', async ({
    page,
    request,
  }) => {
    await enrolAndSignIn(page, request);
    await page.getByRole('button', { name: /Sourdough Loaf/ }).click();
    await page
      .getByRole('button', { name: /^Sourdough Loaf/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('heading', { name: 'Cart (0 items)' })).toBeVisible();
  });

  test('the browser dev build keeps its store in memory, so a reload starts a fresh order', async ({
    page,
    request,
  }) => {
    await enrolAndSignIn(page, request);
    await scan(page, '9300675024235');
    await expect(page.getByRole('heading', { name: 'Cart (1 item)' })).toBeVisible();
    // The browser dev build keeps the store in memory, so a reload starts a fresh order; the SQLite
    // path is covered by the store tests (crash recovery) and the Tauri build.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Cart (0 items)' })).toBeVisible();
  });
});

test.describe('connectivity and recovery UI', () => {
  test('going offline shows the banner, relabels CARD, and unsynced commands keep counting', async ({
    page,
    request,
    context,
  }) => {
    await enrolAndSignIn(page, request);
    await context.setOffline(true);
    await expect(page.getByText('Offline. Sales are saved on this register')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Connection: Offline' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /CARD \(terminal may approve offline, up to limit\)/ }),
    ).toBeVisible();
    await scan(page, '9300675024259');
    await expect(page.getByRole('heading', { name: 'Cart (1 item)' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Unsynced: 1' })).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByRole('status', { name: 'Connection: Online' })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('printer offline shows recovery actions; Retry clears them once the printer is back', async ({
    page,
    request,
  }) => {
    await enrolAndSignIn(page, request);
    await page.getByRole('button', { name: '☰ Menu' }).click();
    await page.getByRole('button', { name: 'Diagnostics' }).click();
    await page.getByRole('button', { name: 'Simulate printer offline' }).click();
    await expect(page.getByRole('table').first()).toContainText('Offline');
    await page.getByRole('button', { name: 'Back to register' }).click();
    const banner = page.getByRole('status').filter({ hasText: 'Receipt printer offline' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Sales are still saved');
    // Retry while it is still down: the banner stays.
    await banner.getByRole('button', { name: 'Retry' }).click();
    await expect(banner).toBeVisible();
    // The cashier fixes the printer (paper, cable), then taps Retry.
    await page.evaluate(() => {
      const pos = (
        window as unknown as {
          __pos: { hardware: { manager: { first: (k: string) => { offline: boolean } } } };
        }
      ).__pos;
      pos.hardware.manager.first('receipt_printer').offline = false;
    });
    await banner.getByRole('button', { name: 'Retry' }).click();
    await expect(banner).toHaveCount(0);
  });

  test('the banner links to diagnostics where the printer can be tested again', async ({
    page,
    request,
  }) => {
    await enrolAndSignIn(page, request);
    await page.getByRole('button', { name: '☰ Menu' }).click();
    await page.getByRole('button', { name: 'Diagnostics' }).click();
    await page.getByRole('button', { name: 'Simulate printer offline' }).click();
    await page.getByRole('button', { name: 'Back to register' }).click();
    await page.getByRole('button', { name: 'Open diagnostics' }).click();
    await page.getByRole('button', { name: /Test print/ }).click();
    await expect(page.getByText(/Print failed: Printer offline \(safe to retry\)/)).toBeVisible();
    await page.getByRole('button', { name: /Simulated printer: offline/ }).click();
    await page.getByRole('button', { name: /Test print/ }).click();
    await expect(page.getByText('Test receipt sent.')).toBeVisible();
  });

  test('a revoked register is wiped and returns to enrolment with an explanation', async ({
    page,
    request,
  }) => {
    const s = await enrolAndSignIn(page, request);
    await page.getByRole('button', { name: '☰ Menu' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await request.post('http://localhost:3100/__test/revoke');
    await signIn(page, s);
    await expect(page.getByRole('alert')).toContainText('removed by an administrator');
    await expect(page.getByRole('heading', { name: 'Enrol this register' })).toBeVisible();
  });
});

test.describe('diagnostics', () => {
  test('lists every peripheral with its state and the local store facts', async ({
    page,
    request,
  }) => {
    await enrolAndSignIn(page, request);
    await page.getByRole('button', { name: '☰ Menu' }).click();
    await page.getByRole('button', { name: 'Diagnostics' }).click();
    const table = page.getByRole('table').first();
    for (const device of [
      'Mock receipt printer',
      'Mock scanner',
      'Mock scale',
      'Mock customer display',
      'Mock cash drawer',
    ]) {
      await expect(table).toContainText(device);
    }
    await expect(page.getByText('Simulated: SQLCipher is not wired yet')).toBeHidden(); // memory store in the browser
    await expect(page.getByText('In memory (browser development build')).toBeVisible();
    await expect(page.getByText('Stub demo data (no server feed yet)')).toBeVisible();
    await page.getByRole('button', { name: /Test print/ }).click();
    await expect(page.getByText('Test receipt sent.')).toBeVisible();
  });
});

test.describe('customer display window', () => {
  test('mirrors the cart live and returns to the welcome screen when it is voided', async ({
    page,
    request,
    context,
  }) => {
    await enrolAndSignIn(page, request);
    const cfd = await context.newPage();
    await cfd.setViewportSize({ width: 1280, height: 800 });
    await cfd.goto('/?mode=cfd');
    await expect(cfd.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await scan(page, '9300675024235');
    await expect(cfd.getByRole('heading', { name: 'Your order' })).toBeVisible();
    await expect(cfd.getByRole('list', { name: 'Items' })).toContainText('Oat Milk 1L');
    await expect(cfd.getByLabel('Total')).toHaveText('4.50');
    await page.getByRole('button', { name: 'Void order' }).click();
    await page.getByRole('button', { name: 'Tap again to void' }).click();
    await expect(cfd.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  });
});
