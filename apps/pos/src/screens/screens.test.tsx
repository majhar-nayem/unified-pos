import { webcrypto } from 'node:crypto';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.js';
import { createServices, type Services } from '../app/services.js';
import { createMockHardware } from '../hardware/setup.js';
import { MemorySecretStore, WebCryptoDeviceKeys } from '../platform/keys.js';
import { MemoryKeyValueStore } from '../platform/ports.js';
import { FakeApi } from '../test/fake-api.js';
import { createMemoryStore } from '../store/stores.js';
import type { CfdMessage, CfdTransport } from '../cfd/channel.js';
import { CfdView } from './CfdView.js';
import { formatCountdown } from './PinScreen.js';

beforeEach(() => {
  // jsdom ships no WebCrypto subtle; the device key adapter needs Ed25519.
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function boot(options: { enrolled?: boolean } = {}) {
  const api = new FakeApi();
  const code = api.addCode();
  const user = api.addUser('1234', 'Priya Patel');
  const services = await createServices({
    store: createMemoryStore(),
    keys: new WebCryptoDeviceKeys(null),
    secrets: new MemorySecretStore(),
    settings: new MemoryKeyValueStore(),
    fetch: api.fetch,
    hardware: createMockHardware(),
    cfd: null,
    now: api.now,
  });
  if (options.enrolled)
    await services.session.enroll({
      apiBaseUrl: 'http://api.test',
      code,
      deviceName: 'Register 1',
    });
  return { api, code, user, services };
}

const press = (digits: string) => {
  for (const d of digits) fireEvent.click(screen.getByRole('button', { name: d }));
};

function view(services: Services) {
  return render(<App services={services} />);
}

describe('EnrollmentScreen', () => {
  it('asks for a code first, then moves to PIN entry after a successful enrolment', async () => {
    const { services, code } = await boot();
    view(services);
    expect(screen.getByRole('heading', { name: 'Enrol this register' })).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Enrol this register' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // no code yet
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'http://api.test' },
    });
    fireEvent.change(screen.getByLabelText('Enrolment code'), { target: { value: code } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });

  it('explains an invalid code', async () => {
    const { services } = await boot();
    view(services);
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'http://api.test' },
    });
    fireEvent.change(screen.getByLabelText('Enrolment code'), {
      target: { value: 'acme.WRONGWRONG12' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enrol this register' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/invalid, used or expired/);
  });

  it('says so when the server cannot be reached', async () => {
    const { services, api, code } = await boot();
    api.online = false;
    view(services);
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'http://api.test' },
    });
    fireEvent.change(screen.getByLabelText('Enrolment code'), { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: 'Enrol this register' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot reach the server/);
  });

  it('shows a revoked notice after an administrator removed the register', async () => {
    const { services, api, user } = await boot({ enrolled: true });
    for (const d of api.devices.values()) d.revoked = true;
    await services.session.pinLogin(user.id, '1234');
    view(services);
    expect(screen.getByRole('alert').textContent).toMatch(/removed by an administrator/);
  });
});

describe('PinScreen', () => {
  it('signs in with the keypad once a staff id is entered', async () => {
    const { services, user } = await boot({ enrolled: true });
    view(services);
    const submit = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(await screen.findByLabelText('Staff ID'), { target: { value: user.id } });
    press('1234');
    expect((screen.getByLabelText('PIN (4 to 8 digits)') as HTMLInputElement).value).toBe('1234');
    fireEvent.click(submit);
    await waitFor(() => expect(services.session.getState().phase).toBe('signed_in'));
  });

  it('rejects a malformed staff id before calling the server', async () => {
    const { services, api } = await boot({ enrolled: true });
    view(services);
    fireEvent.change(await screen.findByLabelText('Staff ID'), { target: { value: 'not-a-uuid' } });
    press('1234');
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(api.calls.some((c) => c.includes('/auth/pin'))).toBe(false);
  });

  it('keypad edits: delete, clear and the 8 digit maximum', async () => {
    const { services } = await boot({ enrolled: true });
    view(services);
    const pin = screen.getByLabelText('PIN (4 to 8 digits)') as HTMLInputElement;
    press('123456789');
    expect(pin.value).toBe('12345678');
    fireEvent.click(screen.getByRole('button', { name: 'Delete last digit' }));
    expect(pin.value).toBe('1234567');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(pin.value).toBe('');
    fireEvent.change(pin, { target: { value: '12ab34' } });
    expect(pin.value).toBe('1234');
  });

  it('shows the lockout panel with a ticking countdown, disables entry, then re-enables at expiry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { services, user, api } = await boot({ enrolled: true });
    api.maxAttempts = 2;
    api.lockSeconds = 90;
    view(services);
    fireEvent.change(await screen.findByLabelText('Staff ID'), { target: { value: user.id } });
    for (let i = 0; i < 2; i++) {
      press('0000');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      });
    }
    const panel = await screen.findByText('Too many wrong PINs.');
    expect(panel).toBeTruthy();
    expect(screen.getByText(/Try again in/).textContent).toContain('1:30');
    expect((screen.getByRole('button', { name: '5' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('PIN (4 to 8 digits)') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      api.advance(91_000);
      vi.setSystemTime(Date.now() + 91_000);
      vi.advanceTimersByTime(1000);
    });
    // The server-side lock has expired but the screen only re-enables by the clock the manager uses.
    await waitFor(() => expect(screen.queryByText('Too many wrong PINs.')).toBeNull());
    expect((screen.getByRole('button', { name: '5' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers the known staff as buttons and remembers a name after sign-in', async () => {
    const { services, user } = await boot({ enrolled: true });
    await services.store.replicas.rememberStaff(
      { userId: user.id, displayName: 'Priya Patel' },
      '2026-10-18T09:00:00Z',
    );
    view(services);
    const priya = await screen.findByRole('button', { name: 'Priya Patel' });
    expect(priya.getAttribute('aria-pressed')).toBe('true');
    press('1234');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(services.session.getState().phase).toBe('signed_in'));
  });

  it('a device that cannot authenticate offers to enrol again', async () => {
    const { services, api, user } = await boot({ enrolled: true });
    api.advance(25 * 3600 * 1000); // device token expired
    await services.keys.destroy(); // key lost: the next signature is made with a different key
    view(services);
    fireEvent.change(await screen.findByLabelText('Staff ID'), { target: { value: user.id } });
    press('1234');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    const alert = await screen.findByText(/could not prove its identity/);
    expect(
      within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: 'Enrol again',
      }),
    ).toBeTruthy();
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59.2, '1:00'],
    [90, '1:30'],
    [600, '10:00'],
    [-3, '0:00'],
  ])('%s s → %s', (s, text) => {
    expect(formatCountdown(s)).toBe(text);
  });
});

describe('Shell', () => {
  async function signedIn() {
    const ctx = await boot({ enrolled: true });
    await ctx.services.session.pinLogin(ctx.user.id, '1234');
    return ctx;
  }

  it('renders the header, empty cart, product grid and a disabled tender bar', async () => {
    const { services } = await signedIn();
    view(services);
    expect(await screen.findByRole('heading', { name: 'Cart (0 items)' })).toBeTruthy();
    expect(screen.getByRole('status', { name: /Unsynced: 0/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: /Oat Milk 1L/ })).toBeTruthy());
    const cash = screen.getByRole('button', { name: /CASH/ }) as HTMLButtonElement;
    expect(cash.disabled).toBe(true);
    services.connectivity.stop();
  });

  it('a tile tap writes a command and the unsynced badge counts it', async () => {
    const { services } = await signedIn();
    view(services);
    fireEvent.click(await screen.findByRole('button', { name: /Oat Milk 1L/ }));
    expect(await screen.findByRole('heading', { name: 'Cart (1 item)' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('status', { name: /Unsynced: 1/ })).toBeTruthy());
    services.connectivity.stop();
  });

  it('opens the diagnostics screen from the menu and lists the mock peripherals', async () => {
    const { services } = await signedIn();
    view(services);
    fireEvent.click(await screen.findByRole('button', { name: /Menu/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    expect(await screen.findByText('Mock receipt printer')).toBeTruthy();
    for (const name of ['Mock scale', 'Mock scanner', 'Mock customer display'])
      expect(screen.getByText(name)).toBeTruthy();
    services.connectivity.stop();
  });
});

describe('CfdView', () => {
  function fakeTransport() {
    const t: CfdTransport = {
      postMessage: () => undefined,
      onmessage: null,
      close: () => undefined,
    };
    return { t, send: (m: CfdMessage) => act(() => t.onmessage?.({ data: m })) };
  }

  it('shows a welcome screen, mirrors the cart, then goes back to idle', () => {
    const { t, send } = fakeTransport();
    render(<CfdView transport={t} />);
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeTruthy();
    send({
      type: 'cart',
      currency: 'AUD',
      lines: [{ name: 'Oat Milk 1L', quantity: '2', totalMinor: '900' }],
      totalMinor: '900',
    });
    expect(screen.getByRole('heading', { name: 'Your order' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Items' }).textContent).toContain('Oat Milk 1L');
    expect(screen.getByLabelText('Total').textContent).toBe('9.00');
    send({ type: 'idle' });
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeTruthy();
    expect(screen.queryByLabelText('Total')).toBeNull();
  });
});
