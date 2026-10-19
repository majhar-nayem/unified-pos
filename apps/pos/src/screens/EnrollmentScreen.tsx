import { useState, type FormEvent } from 'react';

import { useServices } from '../app/services.js';
import { isTauri } from '../platform/runtime.js';
import { Banner, Button, Field } from '../ui/primitives.js';

const DEFAULT_SERVER =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (isTauri()
    ? 'http://localhost:3000'
    : typeof window === 'undefined'
      ? ''
      : window.location.origin);

/** First run: a manager gives the register a one-time code (`<tenant>.<code>`, valid 15 minutes). */
export function EnrollmentScreen({ notice }: { notice: 'revoked' | null }) {
  const { session, keys } = useServices();
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [code, setCode] = useState('');
  const [name, setName] = useState('Register 1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await session.enroll({ apiBaseUrl: server.trim(), code, deviceName: name });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }

  return (
    <main className="center-screen">
      <form className="card" onSubmit={submit} aria-labelledby="enroll-title" noValidate>
        <h1 id="enroll-title" style={{ fontSize: 28 }}>
          Enrol this register
        </h1>
        {notice === 'revoked' ? (
          <Banner tone="danger" role="alert">
            This register was removed by an administrator. Enrol it again with a new code to keep
            selling.
          </Banner>
        ) : null}
        <p className="muted">
          Ask a manager for an enrolment code in Devices. The code works once and expires after 15
          minutes.
        </p>
        <Field id="server" label="Server address">
          <input
            id="server"
            inputMode="url"
            autoComplete="off"
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </Field>
        <Field id="code" label="Enrolment code" hint="For example acme.ABCDEFGH1234">
          <input
            id="code"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby="code-hint"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field id="device-name" label="Register name">
          <input
            id="device-name"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          tender
          disabled={busy || code.trim().length < 8 || name.trim().length === 0}
          onClick={() => undefined}
        >
          {busy ? 'Enrolling…' : 'Enrol this register'}
        </Button>
        <p className="muted">
          Device key:{' '}
          {keys.kind === 'os_keychain'
            ? 'stored in the operating system keychain'
            : 'simulated keychain (development build)'}
        </p>
      </form>
    </main>
  );
}
