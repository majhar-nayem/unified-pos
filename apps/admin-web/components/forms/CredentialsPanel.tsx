'use client';

import { SetPasswordRequestSchema, SetPinRequestSchema, type CredentialDto } from '@pos/contracts';
import { useState } from 'react';

import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FormError, SelectInput, TextInput } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import { useApiMutation, useCredentials, useLocations } from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import { useZodForm } from '@/lib/zod-form';

const KIND_LABEL: Record<string, string> = {
  password: 'Password',
  passkey: 'Passkey',
  totp: 'Authenticator app (TOTP)',
  pos_pin: 'POS PIN',
};

/**
 * Credentials management: list what the user has enrolled, reset the password (which revokes their
 * sessions), set a per-location PIN, and sign them out everywhere. The API does not expose
 * per-credential revocation, so none is offered here.
 */
export function CredentialsPanel({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const perms = usePermissions();
  const canManage = perms.has('identity.credential.manage');
  const canPin = perms.has('identity.pin.set');
  const canRevokeSessions = perms.has('identity.session.revoke');
  const credentials = useCredentials(userId, canManage || isSelf);
  const locations = useLocations();
  const [resetting, setResetting] = useState(false);
  const [signOutAll, setSignOutAll] = useState(false);

  const pwForm = useZodForm(
    SetPasswordRequestSchema,
    { newPassword: '' } as Record<string, unknown>,
    {
      toInput: (v) => ({ newPassword: v.newPassword }),
    },
  );
  const reset = useApiMutation({
    mutationFn: (body: unknown) =>
      api<void>(`/users/${userId}/password`, { method: 'PUT', body, idempotent: false }),
    success: 'Password reset. Their sessions were signed out.',
    invalidate: [],
    silentError: true,
  });

  const pinForm = useZodForm(SetPinRequestSchema, { locationId: '', pin: '' } as Record<
    string,
    unknown
  >);
  const setPin = useApiMutation({
    mutationFn: (body: unknown) => api<void>(`/users/${userId}/pin`, { method: 'PUT', body }),
    success: 'POS PIN saved',
    invalidate: [],
    silentError: true,
  });
  const revokeSessions = useApiMutation({
    mutationFn: () => api<{ revoked: number }>(`/users/${userId}/sessions`, { method: 'DELETE' }),
    success: (r) => `Signed out ${r.revoked} ${r.revoked === 1 ? 'session' : 'sessions'}`,
  });

  if (!canManage && !isSelf && !canPin && !canRevokeSessions) {
    return <Alert tone="info">You cannot manage this user’s credentials.</Alert>;
  }
  const rows: CredentialDto[] = credentials.data ?? [];
  return (
    <div className="stack">
      {credentials.isLoading ? <Spinner label="Loading credentials" /> : null}
      {credentials.error ? <Alert tone="danger">{describeError(credentials.error)}</Alert> : null}
      {credentials.data ? (
        rows.length === 0 ? (
          <p className="muted">
            No credentials enrolled. Invited users create a password when they accept.
          </p>
        ) : (
          <table className="table" aria-label="Credentials">
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
                  <td>{KIND_LABEL[c.kind] ?? titleCase(c.kind)}</td>
                  <td>
                    {c.label ?? (c.locationId ? `Location ${c.locationId.slice(0, 8)}` : '—')}
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td>{formatDateTime(c.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}

      {canManage ? (
        resetting ? (
          <form
            noValidate
            aria-label="Reset password"
            className="card"
            onSubmit={pwForm.handleSubmit(async (body) => {
              await reset.mutateAsync(body);
              pwForm.reset();
              setResetting(false);
            })}
          >
            <TextInput
              label="New password"
              type="password"
              autoComplete="new-password"
              value={String(pwForm.values.newPassword)}
              onChange={(e) => pwForm.setValue('newPassword', e.target.value)}
              onBlur={() => pwForm.blur('newPassword')}
              error={pwForm.errors.newPassword}
              hint="At least 12 characters. The user is signed out everywhere."
              required
            />
            <FormError message={pwForm.formError} />
            <div className="inline">
              <Button type="submit" variant="primary" loading={pwForm.submitting}>
                Reset password
              </Button>
              <Button variant="ghost" onClick={() => setResetting(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button onClick={() => setResetting(true)}>Reset password…</Button>
          </div>
        )
      ) : null}

      {canPin ? (
        <form
          noValidate
          aria-label="Set POS PIN"
          className="card"
          onSubmit={pinForm.handleSubmit(async (body) => {
            await setPin.mutateAsync(body);
            pinForm.reset();
          })}
        >
          <h3 className="card-title">POS PIN</h3>
          <div className="form-grid">
            <SelectInput
              label="Location"
              placeholder="Choose…"
              options={(locations.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
              value={String(pinForm.values.locationId)}
              onChange={(e) => pinForm.setValue('locationId', e.target.value)}
              onBlur={() => pinForm.blur('locationId')}
              error={pinForm.errors.locationId}
            />
            <TextInput
              label="PIN"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={String(pinForm.values.pin)}
              onChange={(e) => pinForm.setValue('pin', e.target.value.replace(/\D/g, ''))}
              onBlur={() => pinForm.blur('pin')}
              error={pinForm.errors.pin}
              hint="4 to 8 digits. PINs are per location."
            />
          </div>
          <FormError message={pinForm.formError} />
          <Button type="submit" loading={pinForm.submitting}>
            Save PIN
          </Button>
        </form>
      ) : null}

      {canRevokeSessions ? (
        <div>
          <Button variant="danger" onClick={() => setSignOutAll(true)}>
            Sign out everywhere…
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={signOutAll}
        title="Sign this user out everywhere?"
        message="Every active session ends immediately. They can sign in again."
        confirmLabel="Sign out"
        busy={revokeSessions.isPending}
        onCancel={() => setSignOutAll(false)}
        onConfirm={async () => {
          await revokeSessions.mutateAsync(undefined);
          setSignOutAll(false);
        }}
      />
    </div>
  );
}
