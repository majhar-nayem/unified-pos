'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { Button } from './Button';
import { TextareaInput } from './Field';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  /** Destructive actions get the danger style (design plan §5: confirm only for those). */
  danger?: boolean;
  /** Ask for a reason and hand it to onConfirm. */
  reason?: { label: string; required?: boolean };
  busy?: boolean;
  onConfirm(reason: string): void | Promise<void>;
  onCancel(): void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger = true,
  reason,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const msgId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!open) return;
    setText('');
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;
  const missingReason = Boolean(reason?.required) && text.trim().length === 0;
  return (
    <div className="dialog-backdrop">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={msgId}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        <div id={msgId} className="dialog-message">
          {message}
        </div>
        {reason ? (
          <TextareaInput
            label={reason.label}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            required={reason.required}
          />
        ) : null}
        <div className="dialog-actions">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => void onConfirm(text.trim())}
            loading={busy}
            disabled={missingReason}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
