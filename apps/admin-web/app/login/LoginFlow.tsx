'use client';

import { startAuthentication } from '@simplewebauthn/browser';
import { LoginRequestSchema, TotpVerifyRequestSchema } from '@pos/contracts';
import type { TotpEnrollResponse } from '@pos/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { FormError, TextInput } from '@/components/ui/Field';
import { Alert, CopyButton } from '@/components/ui/Misc';
import { ApiError, sessionCall } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { useZodForm } from '@/lib/zod-form';

type Step =
  { kind: 'password' } | { kind: 'mfa'; methods: string[] } | { kind: 'enroll'; uri: string };

function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export function LoginFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const credentials = useRef<{ tenantSlug: string; email: string; password: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (session.status === 'authenticated') router.replace(safeNext(params.get('next')));
  }, [session.status, router, params]);

  async function finish() {
    await session.reload();
    router.replace(safeNext(params.get('next')));
  }

  return (
    <div className="login-card">
      <h1>Sign in to POS Admin</h1>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {step.kind === 'password' ? (
        <PasswordStep
          onNext={(creds, result) => {
            credentials.current = creds;
            setNotice(null);
            if (result.status === 'authenticated') void finish();
            else if (result.status === 'mfa_required')
              setStep({ kind: 'mfa', methods: result.methods ?? ['totp'] });
            else
              void sessionCall<TotpEnrollResponse>('/enroll/totp').then((r) =>
                setStep({ kind: 'enroll', uri: r.otpauthUri }),
              );
          }}
        />
      ) : null}
      {step.kind === 'mfa' ? (
        <MfaStep
          methods={step.methods}
          onDone={finish}
          onRestart={() => {
            credentials.current = null;
            setStep({ kind: 'password' });
          }}
        />
      ) : null}
      {step.kind === 'enroll' ? (
        <EnrollStep
          uri={step.uri}
          onEnrolled={async () => {
            const creds = credentials.current;
            if (!creds) return setStep({ kind: 'password' });
            const next = await sessionCall<{ status: string; methods?: string[] }>('/login', creds);
            setNotice('Authenticator saved. Enter a fresh code to finish signing in.');
            setStep({ kind: 'mfa', methods: next.methods ?? ['totp'] });
          }}
        />
      ) : null}
    </div>
  );
}

function PasswordStep({
  onNext,
}: {
  onNext(
    creds: { tenantSlug: string; email: string; password: string },
    result: { status: string; methods?: string[] },
  ): void;
}) {
  const form = useZodForm(LoginRequestSchema, { tenantSlug: '', email: '', password: '' });
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async (values) => {
        try {
          const result = await sessionCall<{ status: string; methods?: string[] }>(
            '/login',
            values,
          );
          onNext(values, result);
        } catch (error) {
          if (error instanceof ApiError && (error.status === 401 || error.status === 423)) {
            form.setFormError(
              error.status === 423
                ? 'Too many attempts. Try again in a few minutes.'
                : 'Email, password or organisation is incorrect.',
            );
            return;
          }
          throw error;
        }
      })}
    >
      <TextInput
        label="Organisation"
        autoComplete="organization"
        value={form.values.tenantSlug}
        onChange={(e) => form.setValue('tenantSlug', e.target.value.trim().toLowerCase())}
        onBlur={() => form.blur('tenantSlug')}
        error={form.errors.tenantSlug}
        hint="The short name of your tenant, for example acme"
        required
      />
      <TextInput
        label="Email"
        type="email"
        autoComplete="username"
        value={form.values.email}
        onChange={(e) => form.setValue('email', e.target.value)}
        onBlur={() => form.blur('email')}
        error={form.errors.email}
        required
      />
      <TextInput
        label="Password"
        type="password"
        autoComplete="current-password"
        value={form.values.password}
        onChange={(e) => form.setValue('password', e.target.value)}
        onBlur={() => form.blur('password')}
        error={form.errors.password}
        required
      />
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Continue
      </Button>
    </form>
  );
}

function MfaStep({
  methods,
  onDone,
  onRestart,
}: {
  methods: string[];
  onDone(): Promise<void>;
  onRestart(): void;
}) {
  const form = useZodForm(TotpVerifyRequestSchema, { code: '' });
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  async function usePasskey() {
    setPasskeyError(null);
    setPasskeyBusy(true);
    try {
      const optionsJSON =
        await sessionCall<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
          '/mfa/passkey/options',
        );
      const response = await startAuthentication({ optionsJSON });
      await sessionCall('/mfa/passkey/verify', { response });
      await onDone();
    } catch (error) {
      setPasskeyError(
        error instanceof ApiError
          ? error.message
          : 'The passkey was not accepted. Try again or use your authenticator app.',
      );
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <div>
      <p className="muted">Enter a second factor to finish signing in.</p>
      {methods.includes('totp') ? (
        <form
          noValidate
          onSubmit={form.handleSubmit(async (values) => {
            try {
              await sessionCall('/mfa/totp', values);
              await onDone();
            } catch (error) {
              if (error instanceof ApiError && error.status === 401) {
                form.setFormError('That code was not accepted. Wait for the next code and retry.');
                return;
              }
              if (error instanceof ApiError && error.status === 403) {
                form.setFormError('Too many failed attempts. Try again in a few minutes.');
                return;
              }
              throw error;
            }
          })}
        >
          <TextInput
            label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={form.values.code}
            onChange={(e) => form.setValue('code', e.target.value.replace(/\D/g, ''))}
            onBlur={() => form.blur('code')}
            error={form.errors.code}
            required
          />
          <FormError message={form.formError} />
          <Button type="submit" variant="primary" loading={form.submitting}>
            Verify
          </Button>
        </form>
      ) : null}
      {methods.includes('passkey') ? (
        <div style={{ marginTop: 12 }}>
          <Button onClick={() => void usePasskey()} loading={passkeyBusy}>
            Use a passkey
          </Button>
          <FormError message={passkeyError} />
        </div>
      ) : null}
      <div style={{ marginTop: 16 }}>
        <Button variant="ghost" size="sm" onClick={onRestart}>
          Start over
        </Button>
      </div>
    </div>
  );
}

function EnrollStep({ uri, onEnrolled }: { uri: string; onEnrolled(): Promise<void> }) {
  const form = useZodForm(TotpVerifyRequestSchema, { code: '' });
  const secret = (() => {
    try {
      return new URL(uri).searchParams.get('secret') ?? '';
    } catch {
      return '';
    }
  })();
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async (values) => {
        try {
          await sessionCall('/enroll/totp/confirm', values);
          await onEnrolled();
        } catch (error) {
          if (error instanceof ApiError && error.status === 422) {
            form.setFormError('That code did not match. Check the time on your device and retry.');
            return;
          }
          throw error;
        }
      })}
    >
      <Alert tone="warning">
        Your roles require a second factor. Add this account to an authenticator app, then confirm
        with the code it shows.
      </Alert>
      <p>
        Setup key: <code data-testid="totp-secret">{secret}</code> <CopyButton value={secret} />
      </p>
      <p className="muted">
        Or open the setup link in your authenticator:{' '}
        <a href={uri} data-testid="otpauth-uri">
          otpauth link
        </a>
      </p>
      <TextInput
        label="Code from the app"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={form.values.code}
        onChange={(e) => form.setValue('code', e.target.value.replace(/\D/g, ''))}
        onBlur={() => form.blur('code')}
        error={form.errors.code}
        required
      />
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Confirm authenticator
      </Button>
    </form>
  );
}
