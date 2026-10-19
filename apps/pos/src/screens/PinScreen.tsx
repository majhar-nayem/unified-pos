import { useEffect, useState, type FormEvent } from 'react';

import { useServices } from '../app/services.js';
import type { SessionState } from '../session/session-manager.js';
import type { StaffEntry } from '../store/stores.js';
import { Banner, Button, Field } from '../ui/primitives.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Seconds left on a lock, ticking once a second while the lock lasts. */
export function useLockRemaining(
  lockedUntil: number | null,
  now: () => number = () => Date.now(),
): number {
  const [remaining, setRemaining] = useState(() =>
    lockedUntil ? Math.max(0, (lockedUntil - now()) / 1000) : 0,
  );
  useEffect(() => {
    if (!lockedUntil) {
      setRemaining(0);
      return undefined;
    }
    const tick = () => setRemaining(Math.max(0, (lockedUntil - now()) / 1000));
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, [lockedUntil, now]);
  return remaining;
}

type SignedOut = Extract<SessionState, { phase: 'signed_out' }>;

/** Staff sign-in on the enrolled device: pick yourself, enter your PIN. Lockout comes from the server (423). */
export function PinScreen({ state }: { state: SignedOut }) {
  const { session, store } = useServices();
  const [staff, setStaff] = useState<StaffEntry[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [manualId, setManualId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'warn'; text: string } | null>(null);
  const remaining = useLockRemaining(state.lockedUntil);
  const locked = remaining > 0;

  useEffect(() => {
    let cancelled = false;
    void store.replicas.staff().then((list) => {
      if (cancelled) return;
      setStaff(list);
      if (list.length === 0) setManual(true);
      else setUserId((current) => current ?? list[0]!.userId);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const selected = manual ? manualId.trim() : (userId ?? '');
  const canSubmit = !busy && !locked && UUID.test(selected) && pin.length >= 4;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setMessage(null);
    const outcome = await session.pinLogin(selected, pin);
    setBusy(false);
    setPin('');
    if (outcome.ok) return;
    if (outcome.reason === 'bad_pin') setMessage({ kind: 'error', text: 'Wrong PIN. Try again.' });
    else if (outcome.reason === 'locked')
      setMessage({ kind: 'error', text: 'Too many wrong PINs. PIN entry is locked.' });
    else
      setMessage({ kind: outcome.reason === 'offline' ? 'warn' : 'error', text: outcome.message });
  }

  return (
    <main className="center-screen">
      <form className="card" onSubmit={submit} aria-labelledby="pin-title">
        <div>
          <h1 id="pin-title" style={{ fontSize: 28 }}>
            Sign in
          </h1>
          <p className="muted">
            {state.identity.deviceName} · Location {state.identity.locationId.slice(0, 8)}
          </p>
        </div>

        {state.deviceAuthFailed ? (
          <Banner tone="danger" role="alert">
            This register could not prove its identity to the server. Ask a manager to check it in
            Devices, or enrol it again.
            <Button onClick={() => void session.wipe('manual')}>Enrol again</Button>
          </Banner>
        ) : null}

        {staff.length > 0 ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend className="muted">Who is signing in?</legend>
            <div className="staff-list">
              {staff.map((s) => (
                <Button
                  key={s.userId}
                  aria-pressed={!manual && userId === s.userId}
                  onClick={() => {
                    setManual(false);
                    setUserId(s.userId);
                  }}
                >
                  {s.displayName}
                </Button>
              ))}
              <Button aria-pressed={manual} onClick={() => setManual(true)}>
                Someone else
              </Button>
            </div>
          </fieldset>
        ) : null}

        {manual ? (
          <Field
            id="staff-id"
            label="Staff ID"
            hint="Ask a manager for your staff ID. It appears here next time."
          >
            <input
              id="staff-id"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="staff-id-hint"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
            />
          </Field>
        ) : null}

        {locked ? (
          <div className="lockout" role="alert">
            <strong>Too many wrong PINs.</strong>
            <p style={{ margin: 0 }}>
              PIN entry is locked on this register. Try again in{' '}
              <span aria-live="off">{formatCountdown(remaining)}</span>, or ask a manager to unlock
              it.
            </p>
          </div>
        ) : null}

        <Field id="pin" label="PIN (4 to 8 digits)">
          <input
            id="pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={8}
            disabled={locked}
            value={pin}
            style={{ minHeight: 64, fontSize: 28, textAlign: 'center' }}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          />
        </Field>

        <div className="keypad" role="group" aria-label="PIN keypad">
          {KEYS.map((k) => (
            <Button
              key={k}
              className="btn-key"
              disabled={locked}
              onClick={() => setPin((p) => (p + k).slice(0, 8))}
            >
              {k}
            </Button>
          ))}
          <Button
            className="btn-key"
            aria-label="Clear"
            disabled={locked}
            onClick={() => setPin('')}
          >
            C
          </Button>
          <Button
            className="btn-key"
            disabled={locked}
            onClick={() => setPin((p) => (p + '0').slice(0, 8))}
          >
            0
          </Button>
          <Button
            className="btn-key"
            aria-label="Delete last digit"
            disabled={locked}
            onClick={() => setPin((p) => p.slice(0, -1))}
          >
            ⌫
          </Button>
        </div>

        {message && !locked ? (
          <p role="alert" className={message.kind === 'error' ? 'error-text' : 'muted'}>
            {message.text}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          tender
          disabled={!canSubmit}
          onClick={() => undefined}
        >
          {busy ? 'Checking…' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}
