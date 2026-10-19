import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../../i18n/translate.js';
import { renderUi } from '../../test/render.js';
import { catalogs } from '../../i18n/catalogs.generated.js';

import {
  CardTenderLabel,
  PaymentStatusPanel,
  paymentPanelPalette,
  paymentPanelStateKinds,
  receiptPaymentLabel,
  type PaymentPanelState,
} from './PaymentStatusPanel.js';

const t = createTranslator('en-AU');

function panel(
  state: PaymentPanelState,
  props: Partial<Parameters<typeof PaymentStatusPanel>[0]> = {},
) {
  return renderUi(<PaymentStatusPanel amountMinor={3286} state={state} {...props} />);
}

describe('PaymentStatusPanel states', () => {
  it('processing: shows terminal, register, instruction and cancel', async () => {
    const onCancel = vi.fn();
    panel({ kind: 'processing', terminalName: 'Tyro T2', registerName: 'Reg 1' }, { onCancel });
    expect(screen.getByText('Waiting for terminal…')).toBeInTheDocument();
    expect(screen.getByText('(Tyro T2, Reg 1)')).toBeInTheDocument();
    expect(screen.getByText('Present card on the terminal')).toBeInTheDocument();
    expect(screen.getByText('$32.86')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for terminal');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel on terminal' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('processing: terminal without a register omits the comma', () => {
    panel({ kind: 'processing', terminalName: 'Tyro T2' });
    expect(screen.getByText('(Tyro T2)')).toBeInTheDocument();
  });

  it('approved: captured palette, amount, no actions', () => {
    const { container } = panel({ kind: 'approved' });
    expect(container.querySelector('.pos-payment-panel')).toHaveAttribute(
      'data-palette',
      'payment-captured',
    );
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('$32.86 captured')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('declined: reason, retry and other tender fire their callbacks; announced assertively', async () => {
    const onRetry = vi.fn();
    const onOtherTender = vi.fn();
    panel({ kind: 'declined', reason: 'Insufficient funds' }, { onRetry, onOtherTender });
    expect(screen.getByText('Reason: Insufficient funds')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await userEvent.click(screen.getByRole('button', { name: 'Other tender' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOtherTender).toHaveBeenCalledOnce();
  });

  it('uncertain: warns not to re-charge and shows Call manager only after the threshold', async () => {
    const onCallManager = vi.fn();
    const { rerender } = panel({ kind: 'uncertain' }, { elapsedSeconds: 59, onCallManager });
    expect(screen.getByText('Confirming result with provider…')).toBeInTheDocument();
    expect(screen.getByText(/Do not re-charge/)).toBeInTheDocument();
    expect(screen.getByText('Waiting 0:59')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Call manager' })).not.toBeInTheDocument();

    rerender(
      <PaymentStatusPanel
        amountMinor={3286}
        state={{ kind: 'uncertain' }}
        elapsedSeconds={60}
        onCallManager={onCallManager}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Call manager' }));
    expect(onCallManager).toHaveBeenCalledOnce();
  });

  it('uncertain: threshold is configurable', () => {
    panel({ kind: 'uncertain' }, { elapsedSeconds: 30, callManagerAfterSeconds: 30 });
    expect(screen.getByRole('button', { name: 'Call manager' })).toBeInTheDocument();
  });

  it('approved-offline: amber, pending wording, never the captured palette', () => {
    const { container } = panel({ kind: 'approved-offline' });
    const root = container.querySelector('.pos-payment-panel');
    expect(root).toHaveAttribute('data-palette', 'payment-offline-approved');
    expect(root).not.toHaveAttribute('data-palette', 'payment-captured');
    expect(container.querySelector('[data-palette="payment-captured"]')).toBeNull();
    expect(
      screen.getByText('Approved offline — will be submitted when online'),
    ).toBeInTheDocument();
    expect(screen.getByText(/not yet settled/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('forwarded-approved: captured palette, no staff action', () => {
    const { container } = panel({ kind: 'forwarded-approved' });
    expect(container.querySelector('.pos-payment-panel')).toHaveAttribute(
      'data-palette',
      'payment-captured',
    );
    expect(screen.getByText('Forwarded and approved')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    [
      'declined-after-reconnect',
      'Offline card payment declined by the issuer — check reopened',
      'payment-failed',
    ],
    ['expired', /could not be submitted within the provider window/, 'payment-expired'],
  ] as const)('%s: red banner with the three recovery actions', async (kind, text, palette) => {
    const onCollectAgain = vi.fn();
    const onContactCustomer = vi.fn();
    const onWriteOff = vi.fn();
    const { container } = panel({ kind }, { onCollectAgain, onContactCustomer, onWriteOff });
    expect(container.querySelector('.pos-payment-panel')).toHaveAttribute('data-palette', palette);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Collect again' }));
    await userEvent.click(screen.getByRole('button', { name: 'Contact customer' }));
    const writeOff = screen.getByRole('button', { name: /Write off/ });
    expect(writeOff).toHaveAccessibleName('Write off (manager approval required)');
    expect(writeOff.querySelector('svg')).toBeInTheDocument();
    await userEvent.click(writeOff);
    expect(onCollectAgain).toHaveBeenCalledOnce();
    expect(onContactCustomer).toHaveBeenCalledOnce();
    expect(onWriteOff).toHaveBeenCalledOnce();
    expect(screen.getByText('Writing off needs manager approval.')).toBeInTheDocument();
  });

  it('caps-reached: card button is disabled and the count and limit are formatted', async () => {
    renderUi(
      <PaymentStatusPanel
        amountMinor={3286}
        state={{ kind: 'caps-reached', count: 5, limitMinor: 50000 }}
      />,
    );
    expect(
      screen.getByText('Offline limit reached (5/$500.00) — reconnect to continue taking cards'),
    ).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Card' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Offline limit reached/);
  });

  it('every state sets its own palette and icon, and always has text', () => {
    const states: PaymentPanelState[] = [
      { kind: 'processing' },
      { kind: 'approved' },
      { kind: 'declined', reason: 'x' },
      { kind: 'uncertain' },
      { kind: 'approved-offline' },
      { kind: 'forwarded-approved' },
      { kind: 'declined-after-reconnect' },
      { kind: 'expired' },
      { kind: 'caps-reached', count: 1, limitMinor: 100 },
    ];
    expect(states.map((s) => s.kind).sort()).toEqual([...paymentPanelStateKinds].sort());
    for (const state of states) {
      const { container, unmount } = panel(state);
      const root = container.querySelector('.pos-payment-panel') as HTMLElement;
      expect(root.getAttribute('data-palette')).toBe(paymentPanelPalette(state.kind));
      expect(root.querySelector('[role] svg')).toBeInTheDocument();
      expect(
        within(root).getByText(/\S/, { selector: '.pos-payment-panel__title' }),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it('only captured states use the captured palette', () => {
    const captured = paymentPanelStateKinds.filter(
      (k) => paymentPanelPalette(k) === 'payment-captured',
    );
    expect(captured).toEqual(['approved', 'forwarded-approved']);
  });
});

describe('CardTenderLabel and copy', () => {
  it('reads "Card" online and never promises offline acceptance', () => {
    const { rerender } = renderUi(<CardTenderLabel />);
    expect(screen.getByText('Card')).toBeInTheDocument();
    rerender(<CardTenderLabel offline />);
    expect(
      screen.getByText('Card (terminal may approve offline, up to limit)'),
    ).toBeInTheDocument();
  });

  it('no catalogued payment or receipt copy says card payments work offline', () => {
    const all = Object.entries(catalogs['en-AU'])
      .filter(([key]) => key.startsWith('paymentStatusPanel.') || key.startsWith('receipt.'))
      .map(([, message]) => message);
    expect(all.length).toBeGreaterThan(20);
    for (const message of all) {
      expect(message).not.toMatch(/card payments? (will )?works? offline/i);
    }
  });

  it('receipt wording is pending for offline-collected cards and settled only after capture', () => {
    expect(receiptPaymentLabel({ kind: 'approved-offline' }, t)).toMatch(/^Pending/);
    expect(receiptPaymentLabel({ kind: 'uncertain' }, t)).toMatch(/^Pending/);
    expect(receiptPaymentLabel({ kind: 'approved' }, t)).toBe('Settled');
    expect(receiptPaymentLabel({ kind: 'forwarded-approved' }, t)).toBe('Settled');
    expect(receiptPaymentLabel({ kind: 'declined' }, t)).toBe('Not collected');
    for (const kind of paymentPanelStateKinds) {
      if (kind !== 'approved' && kind !== 'forwarded-approved') {
        expect(receiptPaymentLabel({ kind }, t)).not.toBe('Settled');
      }
    }
  });
});
