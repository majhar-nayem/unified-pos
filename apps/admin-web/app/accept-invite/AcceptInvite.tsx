'use client';

import { AcceptInviteSchema } from '@pos/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/Button';
import { FormError, TextInput } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Misc';
import { api } from '@/lib/api/client';
import { useZodForm } from '@/lib/zod-form';

export function AcceptInvite() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const form = useZodForm(
    AcceptInviteSchema.extend({ confirm: z.string().min(1) }).refine(
      (v) => v.password === v.confirm,
      {
        message: 'Passwords do not match',
        path: ['confirm'],
      },
    ),
    { token, password: '', confirm: '' } as Record<string, unknown>,
    { toInput: (v) => ({ token, password: v.password, confirm: v.confirm }) },
  );
  if (!token) {
    return (
      <div className="login-card">
        <h1>Invitation link incomplete</h1>
        <Alert tone="danger">
          This link is missing its token. Ask your administrator to send it again.
        </Alert>
      </div>
    );
  }
  if (done) {
    return (
      <div className="login-card">
        <h1>Password set</h1>
        <p>
          Your account is ready. Sign in with your organisation name, email and the new password.
        </p>
        <Link href="/login">Go to sign in</Link>
      </div>
    );
  }
  return (
    <div className="login-card">
      <h1>Accept your invitation</h1>
      <form
        noValidate
        onSubmit={form.handleSubmit(async (v) => {
          await api('/users/accept-invite', {
            method: 'POST',
            body: { token: v.token, password: v.password },
          });
          setDone(true);
        })}
      >
        <TextInput
          label="Choose a password"
          type="password"
          autoComplete="new-password"
          value={String(form.values.password)}
          onChange={(e) => form.setValue('password', e.target.value)}
          onBlur={() => form.blur('password')}
          error={form.errors.password}
          hint="At least 12 characters"
          required
        />
        <TextInput
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={String(form.values.confirm)}
          onChange={(e) => form.setValue('confirm', e.target.value)}
          onBlur={() => form.blur('confirm')}
          error={form.errors.confirm}
          required
        />
        <FormError message={form.formError} />
        <Button type="submit" variant="primary" loading={form.submitting}>
          Set password
        </Button>
      </form>
    </div>
  );
}
