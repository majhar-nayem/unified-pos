import { useId, useState, type ReactNode } from 'react';

import { Icon } from '../../foundation/Icon.js';
import { useUi } from '../../foundation/UiProvider.js';
import { Button } from '../../primitives/Button/Button.js';
import { Dialog } from '../../primitives/Dialog/Dialog.js';
import { Keypad } from '../../primitives/Keypad/Keypad.js';
import { Segmented } from '../../primitives/Segmented/Segmented.js';

export type ApprovalMethod = 'pin' | 'passkey';
export type ApprovalStatus = 'idle' | 'verifying' | 'denied' | 'error';

export interface ApprovalPromptProps {
  readonly open: boolean;
  /** What needs approval, e.g. "Void sent item" or "Refund $12.00". */
  readonly action: ReactNode;
  readonly reason?: ReactNode;
  /** The limit that was exceeded, e.g. "Discount over 10%". Over-limit is an approval, not a failure. */
  readonly limit?: ReactNode;
  readonly requestedBy?: string;
  /** Allowed approval methods; the first is the default. */
  readonly methods?: readonly ApprovalMethod[];
  readonly minPinLength?: number;
  readonly maxPinLength?: number;
  /** Result of the last verification, supplied by the app. `denied` clears the PIN. */
  readonly status?: ApprovalStatus;
  readonly onApprovePin: (pin: string) => void;
  readonly onApprovePasskey?: () => void;
  readonly onCancel: () => void;
}

/** Manager approval (PIN or passkey) for voids, refunds and overrides. The PIN is never rendered. */
export function ApprovalPrompt({
  open,
  action,
  reason,
  limit,
  requestedBy,
  methods = ['pin'],
  minPinLength = 4,
  maxPinLength = 6,
  status = 'idle',
  onApprovePin,
  onApprovePasskey,
  onCancel,
}: ApprovalPromptProps) {
  const { t } = useUi();
  const [method, setMethod] = useState<ApprovalMethod>(methods[0] ?? 'pin');
  const [pin, setPin] = useState('');
  const messageId = useId();
  const verifying = status === 'verifying';

  // Reset during render (React's "adjust state on prop change" pattern): a denied or errored attempt and a
  // closed prompt both discard the PIN.
  const [seen, setSeen] = useState({ status, open });
  if (seen.status !== status || seen.open !== open) {
    setSeen({ status, open });
    if (!open || status === 'denied' || status === 'error') setPin('');
  }

  const submit = () => {
    if (pin.length >= minPinLength && !verifying) onApprovePin(pin);
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      role="alertdialog"
      size="sm"
      title={t('approvalPrompt.title')}
      description={
        <span className="pos-approval__summary">
          <strong>{action}</strong>
          {reason ? <span>{reason}</span> : null}
          {limit ? <span>{limit}</span> : null}
          {requestedBy ? (
            <span>{t('approvalPrompt.requestedBy', { name: requestedBy })}</span>
          ) : null}
        </span>
      }
      footer={
        <Button variant="secondary" onClick={onCancel}>
          {t('approvalPrompt.cancel')}
        </Button>
      }
    >
      <div className="pos-approval">
        {methods.length > 1 ? (
          <Segmented
            label={t('approvalPrompt.method')}
            value={method}
            onValueChange={(v) => setMethod(v as ApprovalMethod)}
            options={methods.map((m) => ({
              value: m,
              label: t(m === 'pin' ? 'approvalPrompt.methodPin' : 'approvalPrompt.methodPasskey'),
            }))}
            fullWidth
          />
        ) : null}

        {method === 'pin' ? (
          <Keypad
            mode="pin"
            label={t('approvalPrompt.pinLabel')}
            value={pin}
            onChange={setPin}
            maxLength={maxPinLength}
            actionLabel={t('approvalPrompt.approve')}
            onAction={submit}
            actionDisabled={pin.length < minPinLength || verifying}
            disabled={verifying}
            aria-describedby={status === 'denied' || status === 'error' ? messageId : undefined}
          />
        ) : (
          <div className="pos-approval__passkey">
            <p>{t('approvalPrompt.passkeyHint')}</p>
            <Button
              size="lg"
              iconStart={<Icon name="lock" />}
              loading={verifying}
              onClick={onApprovePasskey}
              disabled={!onApprovePasskey}
            >
              {t('approvalPrompt.passkey')}
            </Button>
          </div>
        )}

        <div id={messageId} className="pos-approval__message" role="status" aria-live="polite">
          {verifying ? t('approvalPrompt.verifying') : null}
          {status === 'denied' ? (
            <span className="pos-approval__error">
              <Icon name="x-circle" /> {t('approvalPrompt.denied')}
            </span>
          ) : null}
          {status === 'error' ? (
            <span className="pos-approval__error">
              <Icon name="alert" /> {t('approvalPrompt.error')}
            </span>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
