'use client';

import {
  CreateUserSchema,
  InviteUserSchema,
  USER_STATUSES,
  UpdateUserSchema,
  type UserDto,
} from '@pos/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

import { ResourceTable, RowLink } from '@/components/data-table/ResourceTable';
import { AssignmentsPanel } from '@/components/forms/AssignmentsPanel';
import { CredentialsPanel } from '@/components/forms/CredentialsPanel';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { FormError, SelectInput, TextInput } from '@/components/ui/Field';
import { Alert, CopyButton, KeyValue, PageHeader, Tabs } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import { keys, useApiMutation, useUsers } from '@/lib/api/resources';
import { usePermissions, useSession } from '@/lib/auth/session';
import { formatDateTime, formatRelative } from '@/lib/format';
import { opts } from '@/lib/options';
import { useZodForm } from '@/lib/zod-form';

type Tab = 'profile' | 'roles' | 'credentials';

export default function UsersPage() {
  const perms = usePermissions();
  const session = useSession();
  const query = useUsers();
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<'invite' | 'create' | null>(null);
  const open = query.data?.find((u) => u.id === openId) ?? null;
  const canInvite = perms.has('identity.user.invite');
  const canCreate = perms.has('identity.user.manage');

  const columns = useMemo<ColumnDef<UserDto, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorFn: (r) => r.displayName,
        cell: ({ row }) => (
          <RowLink onClick={() => setOpenId(row.original.id)}>{row.original.displayName}</RowLink>
        ),
      },
      { id: 'email', header: 'Email', accessorFn: (r) => r.email ?? '—' },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => r.status,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'mfa',
        header: 'Second factor',
        accessorFn: (r) => (r.mfaEnabled ? 'Enrolled' : 'Not enrolled'),
      },
      {
        id: 'last',
        header: 'Last sign-in',
        accessorFn: (r) => r.lastLoginAt ?? '',
        cell: ({ row }) => formatRelative(row.original.lastLoginAt),
      },
      {
        id: 'created',
        header: 'Created',
        accessorFn: (r) => r.createdAt,
        cell: ({ row }) => formatDateTime(row.original.createdAt),
      },
    ],
    [],
  );
  const pendingInvites = (query.data ?? []).filter((u) => u.status === 'invited').length;

  return (
    <>
      <PageHeader
        title="Users & invitations"
        description="Staff who can sign in to the admin console or POS. Invited users appear here with status Invited until they accept."
        actions={
          <>
            {canInvite ? (
              <Button variant="primary" onClick={() => setMode('invite')}>
                Invite user
              </Button>
            ) : null}
            {canCreate ? <Button onClick={() => setMode('create')}>Create user</Button> : null}
          </>
        }
      />
      {pendingInvites > 0 ? (
        <Alert tone="info">
          {pendingInvites} pending {pendingInvites === 1 ? 'invitation' : 'invitations'}. Filter by
          status Invited to follow up.
        </Alert>
      ) : null}
      <ResourceTable
        tableId="users"
        caption="Users"
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error ? describeError(query.error) : null}
        onRetry={() => void query.refetch()}
        selectedId={openId}
        defaultHidden={['created']}
        filters={[
          { id: 'q', label: 'Search', type: 'text', placeholder: 'Name or email' },
          { id: 'status', label: 'Status', type: 'select', options: opts(USER_STATUSES) },
        ]}
        matches={(r, f) =>
          (!f.q || `${r.displayName} ${r.email ?? ''}`.toLowerCase().includes(f.q.toLowerCase())) &&
          (!f.status || r.status === f.status)
        }
        emptyTitle="No users yet"
        emptyDescription="Invite a colleague by email. They set their own password when they accept."
        emptyAction={
          canInvite ? (
            <Button variant="primary" onClick={() => setMode('invite')}>
              Invite user
            </Button>
          ) : undefined
        }
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpenId(null)}
        title={open?.displayName ?? ''}
        description={open?.email ?? undefined}
        wide
      >
        {open ? (
          <UserDetail key={open.id} user={open} isSelf={open.id === session.principal?.subjectId} />
        ) : null}
      </Drawer>
      <Drawer open={mode === 'invite'} onClose={() => setMode(null)} title="Invite a user">
        {mode === 'invite' ? <InviteForm onClose={() => setMode(null)} /> : null}
      </Drawer>
      <Drawer open={mode === 'create'} onClose={() => setMode(null)} title="Create a user">
        {mode === 'create' ? <CreateForm onClose={() => setMode(null)} /> : null}
      </Drawer>
    </>
  );
}

function UserDetail({ user, isSelf }: { user: UserDto; isSelf: boolean }) {
  const [tab, setTab] = useState<Tab>('profile');
  return (
    <>
      <Tabs<Tab>
        label="User sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'profile', label: 'Profile' },
          { id: 'roles', label: 'Roles' },
          { id: 'credentials', label: 'Credentials' },
        ]}
      />
      {tab === 'profile' ? <Profile user={user} /> : null}
      {tab === 'roles' ? <AssignmentsPanel userId={user.id} /> : null}
      {tab === 'credentials' ? <CredentialsPanel userId={user.id} isSelf={isSelf} /> : null}
    </>
  );
}

function Profile({ user }: { user: UserDto }) {
  const perms = usePermissions();
  const canManage = perms.has('identity.user.manage');
  const form = useZodForm(
    UpdateUserSchema,
    {
      displayName: user.displayName,
      email: user.email ?? '',
      status: user.status === 'invited' ? '' : user.status,
    } as Record<string, unknown>,
    {
      toInput: (v) => ({
        displayName: String(v.displayName).trim(),
        email: String(v.email).trim() ? String(v.email).trim() : null,
        ...(v.status ? { status: v.status } : {}),
      }),
    },
  );
  const update = useApiMutation({
    mutationFn: (body: unknown) => api<UserDto>(`/users/${user.id}`, { method: 'PATCH', body }),
    invalidate: [keys.users],
    success: 'User saved',
    silentError: true,
  });
  return (
    <div className="stack">
      <KeyValue
        items={[
          { label: 'Status', value: <StatusBadge status={user.status} /> },
          { label: 'Second factor', value: user.mfaEnabled ? 'Enrolled' : 'Not enrolled' },
          { label: 'Last sign-in', value: formatDateTime(user.lastLoginAt) },
          { label: 'Created', value: formatDateTime(user.createdAt) },
        ]}
      />
      {canManage ? (
        <form
          noValidate
          aria-label="Edit user"
          onSubmit={form.handleSubmit(async (b) => void (await update.mutateAsync(b)))}
        >
          <TextInput
            label="Display name"
            value={String(form.values.displayName)}
            onChange={(e) => form.setValue('displayName', e.target.value)}
            onBlur={() => form.blur('displayName')}
            error={form.errors.displayName}
          />
          <TextInput
            label="Email"
            type="email"
            value={String(form.values.email)}
            onChange={(e) => form.setValue('email', e.target.value)}
            onBlur={() => form.blur('email')}
            error={form.errors.email}
          />
          {user.status !== 'invited' ? (
            <SelectInput
              label="Status"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'suspended', label: 'Suspended' },
                { value: 'deactivated', label: 'Deactivated' },
              ]}
              value={String(form.values.status)}
              onChange={(e) => form.setValue('status', e.target.value)}
              hint="Suspended users cannot sign in but keep their history."
            />
          ) : null}
          <FormError message={form.formError} />
          <Button type="submit" variant="primary" loading={form.submitting}>
            Save changes
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function InviteForm({ onClose }: { onClose(): void }) {
  const form = useZodForm(InviteUserSchema, { email: '', displayName: '' } as Record<
    string,
    unknown
  >);
  const [issued, setIssued] = useState<{ token: string; email: string } | null>(null);
  const invite = useApiMutation({
    mutationFn: (body: unknown) =>
      api<{ user: UserDto; inviteToken: string }>('/users/invite', {
        method: 'POST',
        body,
        idempotent: true,
      }),
    invalidate: [keys.users],
    success: 'Invitation created',
    silentError: true,
  });
  if (issued) {
    const link = `${typeof window === 'undefined' ? '' : window.location.origin}/accept-invite?token=${encodeURIComponent(issued.token)}`;
    return (
      <div className="stack">
        <Alert tone="success">Invitation created for {issued.email}.</Alert>
        <p>
          Email delivery is not connected yet, so share this one-time link with them yourself. It
          will not be shown again.
        </p>
        <code data-testid="invite-link" style={{ overflowWrap: 'anywhere' }}>
          {link}
        </code>
        <div className="inline">
          <CopyButton value={link} label="Copy link" />
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      noValidate
      aria-label="Invite a user"
      onSubmit={form.handleSubmit(async (b) => {
        const r = await invite.mutateAsync(b);
        setIssued({ token: r.inviteToken, email: r.user.email ?? '' });
      })}
    >
      <TextInput
        label="Name"
        value={String(form.values.displayName)}
        onChange={(e) => form.setValue('displayName', e.target.value)}
        onBlur={() => form.blur('displayName')}
        error={form.errors.displayName}
        required
      />
      <TextInput
        label="Email"
        type="email"
        value={String(form.values.email)}
        onChange={(e) => form.setValue('email', e.target.value)}
        onBlur={() => form.blur('email')}
        error={form.errors.email}
        required
      />
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Create invitation
      </Button>
    </form>
  );
}

function CreateForm({ onClose }: { onClose(): void }) {
  const form = useZodForm(
    CreateUserSchema,
    { email: '', displayName: '', password: '' } as Record<string, unknown>,
    {
      toInput: (v) => ({
        displayName: String(v.displayName).trim(),
        ...(String(v.email).trim() ? { email: String(v.email).trim() } : {}),
        ...(String(v.password) ? { password: v.password } : {}),
      }),
    },
  );
  const create = useApiMutation({
    mutationFn: (body: unknown) =>
      api<UserDto>('/users', { method: 'POST', body, idempotent: true }),
    invalidate: [keys.users],
    success: 'User created',
    silentError: true,
  });
  return (
    <form
      noValidate
      aria-label="Create a user"
      onSubmit={form.handleSubmit(async (b) => {
        await create.mutateAsync(b);
        onClose();
      })}
    >
      <TextInput
        label="Name"
        value={String(form.values.displayName)}
        onChange={(e) => form.setValue('displayName', e.target.value)}
        onBlur={() => form.blur('displayName')}
        error={form.errors.displayName}
        required
      />
      <TextInput
        label="Email"
        type="email"
        value={String(form.values.email)}
        onChange={(e) => form.setValue('email', e.target.value)}
        onBlur={() => form.blur('email')}
        error={form.errors.email}
        hint="Optional for PIN-only staff"
      />
      <TextInput
        label="Initial password"
        type="password"
        autoComplete="new-password"
        value={String(form.values.password)}
        onChange={(e) => form.setValue('password', e.target.value)}
        onBlur={() => form.blur('password')}
        error={form.errors.password}
        hint="Optional, at least 12 characters. Prefer an invitation so people choose their own."
      />
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Create user
      </Button>
    </form>
  );
}
