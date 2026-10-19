'use client';

import {
  SetPasswordRequestSchema,
  TotpVerifyRequestSchema,
  type CredentialDto,
} from '@pos/contracts';
import { startRegistration } from '@simplewebauthn/browser';
import { z } from 'zod';
import { useState } from 'react';

import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FormError, TextInput } from '@/components/ui/Field';
import { Alert, CopyButton, PageHeader, Spinner } from '@/components/ui/Misc';
import { useToast } from '@/components/ui/Toast';
import { api, describeError } from '@/lib/api/client';
import { keys, useApiMutation, useCredentials } from '@/lib/api/resources';
import { useSession } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { useZodForm } from '@/lib/zod-form';

const KIND: Record<string, string> = {
  password: 'Password',
  passkey: 'Passkey',
  totp: 'Authenticator app (TOTP)',
  pos_pin: 'POS PIN',
};

export default function AccountPage() {
  const session = useSession();
  const userId = session.principal?.subjectId;
  const credentials = useCredentials(userId, true);
  return (
    <>
      <PageHeader
        title="My account"
        description="Your sign-in methods. Roles that can change settings or money require a second factor: an authenticator app or a passkey."
      />
      <div className="stack">
        <section className="card" aria-label="Sign-in methods">
          <h2 className="card-title">Sign-in methods</h2>
          {credentials.isLoading ? <Spinner label="Loading" /> : null}
          {credentials.error ? (
            <Alert tone="danger">{describeError(credentials.error)}</Alert>
          ) : null}
          {credentials.data ? <CredentialTable rows={credentials.data} /> : null}
        </section>
        <div className="grid grid-2">
          <PasskeyCard userId={userId} />
          <TotpCard />
        </div>
        <PasswordCard />
      </div>
    </>
  );
}

function CredentialTable({ rows }: { rows: CredentialDto[] }) {
  if (rows.length === 0) return <p className="muted">Nothing enrolled yet.</p>;
  return (
    <table className="table" aria-label="Your credentials">
      <thead>
        <tr>
          <th scope="col">Type</th>
          <th scope="col">Label</th>
          <th scope="col">Status</th>
          <th scope="col">Last used</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id}>
            <td>{KIND[c.kind] ?? c.kind}</td>
            <td>{c.label ?? '—'}</td>
            <td>
              <StatusBadge status={c.status} />
            </td>
            <td>{formatDateTime(c.lastUsedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PasskeyCard({ userId }: { userId: string | undefined }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useApiMutation({
    mutationFn: async () => undefined,
    invalidate: [keys.credentials(userId ?? '')],
  });
  async function add() {
    setError(null);
    setBusy(true);
    try {
      const body = label.trim() ? { label: label.trim() } : {};
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>(
        '/users/me/passkeys/options',
        {
          method: 'POST',
          body,
        },
      );
      const response = await startRegistration({ optionsJSON });
      await api('/users/me/passkeys', {
        method: 'POST',
        body: { ...body, response },
        idempotent: true,
      });
      setLabel('');
      toast.success('Passkey added');
      await refresh.mutateAsync(undefined);
    } catch (e) {
      setError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'The passkey request was cancelled or timed out.'
          : describeError(e),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="Add a passkey">
      <h2 className="card-title">Passkey</h2>
      <p className="muted">
        Use your device’s fingerprint, face or PIN, or a security key, as your second factor.
      </p>
      <TextInput
        label="Name (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        hint="For example “MacBook Touch ID”"
      />
      <FormError message={error} />
      <Button variant="primary" onClick={() => void add()} loading={busy}>
        Add a passkey
      </Button>
    </section>
  );
}

function TotpCard() {
  const toast = useToast();
  const session = useSession();
  const [uri, setUri] = useState<string | null>(null);
  const form = useZodForm(TotpVerifyRequestSchema, { code: '' });
  const begin = useApiMutation({
    mutationFn: () => api<{ otpauthUri: string }>('/users/me/totp/enroll', { method: 'POST' }),
    silentError: false,
  });
  const secret = uri ? (new URL(uri).searchParams.get('secret') ?? '') : '';
  return (
    <section className="card" aria-label="Authenticator app">
      <h2 className="card-title">Authenticator app</h2>
      {!uri ? (
        <>
          <p className="muted">Set up or replace the app that generates your 6-digit codes.</p>
          <Button
            onClick={async () => setUri((await begin.mutateAsync(undefined)).otpauthUri)}
            loading={begin.isPending}
          >
            Set up authenticator
          </Button>
        </>
      ) : (
        <form
          noValidate
          aria-label="Confirm authenticator"
          onSubmit={form.handleSubmit(async (body) => {
            await api('/users/me/totp/confirm', { method: 'POST', body });
            toast.success('Authenticator saved');
            setUri(null);
            form.reset();
            await session.reload();
          })}
        >
          <p>
            Setup key: <code data-testid="account-totp-secret">{secret}</code>{' '}
            <CopyButton value={secret} />
          </p>
          <TextInput
            label="Code from the app"
            inputMode="numeric"
            maxLength={6}
            autoComplete="one-time-code"
            value={form.values.code}
            onChange={(e) => form.setValue('code', e.target.value.replace(/\D/g, ''))}
            onBlur={() => form.blur('code')}
            error={form.errors.code}
          />
          <FormError message={form.formError} />
          <Button type="submit" variant="primary" loading={form.submitting}>
            Confirm
          </Button>
        </form>
      )}
    </section>
  );
}

function PasswordCard() {
  const form = useZodForm(
    SetPasswordRequestSchema.extend({ confirm: z.string().min(1) }).refine(
      (v) => v.newPassword === v.confirm,
      {
        message: 'Passwords do not match',
        path: ['confirm'],
      },
    ),
    { currentPassword: '', newPassword: '', confirm: '' } as Record<string, unknown>,
  );
  const change = useApiMutation({
    mutationFn: (body: unknown) => api<void>('/users/me/password', { method: 'PUT', body }),
    success: 'Password changed',
    silentError: true,
  });
  return (
    <form
      noValidate
      aria-label="Change password"
      className="card"
      onSubmit={form.handleSubmit(async (v) => {
        await change.mutateAsync({
          currentPassword: v.currentPassword,
          newPassword: v.newPassword,
        });
        form.reset();
      })}
    >
      <h2 className="card-title">Change password</h2>
      <div className="form-grid">
        <TextInput
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={String(form.values.currentPassword)}
          onChange={(e) => form.setValue('currentPassword', e.target.value)}
          onBlur={() => form.blur('currentPassword')}
          error={form.errors.currentPassword}
        />
        <span />
        <TextInput
          label="New password"
          type="password"
          autoComplete="new-password"
          value={String(form.values.newPassword)}
          onChange={(e) => form.setValue('newPassword', e.target.value)}
          onBlur={() => form.blur('newPassword')}
          error={form.errors.newPassword}
          hint="At least 12 characters"
        />
        <TextInput
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={String(form.values.confirm)}
          onChange={(e) => form.setValue('confirm', e.target.value)}
          onBlur={() => form.blur('confirm')}
          error={form.errors.confirm}
        />
      </div>
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Change password
      </Button>
    </form>
  );
}
