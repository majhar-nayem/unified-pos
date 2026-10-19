'use client';

import { PERMISSIONS } from '@pos/auth';
import { CloneRoleSchema, CreateRoleSchema, type RoleDto } from '@pos/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

import { LimitsEditor } from '@/components/limits/LimitsEditor';
import { ResourceTable, RowLink } from '@/components/data-table/ResourceTable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { FormError, TextInput, TextareaInput } from '@/components/ui/Field';
import { Alert, PageHeader } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import { keys, useApiMutation, useRoles } from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { useZodForm } from '@/lib/zod-form';

const MODULES = Array.from(new Set(PERMISSIONS.map((p) => p.module)));

export default function RolesPage() {
  const perms = usePermissions();
  const query = useRoles();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const open = query.data?.find((r) => r.id === openId) ?? null;
  const canManage = perms.has('access.role.manage');

  const columns = useMemo<ColumnDef<RoleDto, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Role',
        accessorFn: (r) => r.name,
        cell: ({ row }) => (
          <RowLink onClick={() => setOpenId(row.original.id)}>{row.original.name}</RowLink>
        ),
      },
      {
        id: 'key',
        header: 'Key',
        accessorFn: (r) => r.key,
        cell: ({ row }) => <code>{row.original.key}</code>,
      },
      {
        id: 'type',
        header: 'Type',
        accessorFn: (r) => (r.isSystem ? 'System' : 'Custom'),
        cell: ({ row }) => (
          <Badge tone={row.original.isSystem ? 'info' : 'neutral'}>
            {row.original.isSystem ? 'System' : 'Custom'}
          </Badge>
        ),
      },
      { id: 'perms', header: 'Permissions', accessorFn: (r) => r.permissions.length },
      { id: 'limits', header: 'Limits', accessorFn: (r) => Object.keys(r.limits).length },
      {
        id: 'desc',
        header: 'Description',
        accessorFn: (r) => r.description ?? '',
        cell: ({ row }) => <span className="muted">{row.original.description ?? ''}</span>,
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Roles & assignments"
        description="Roles bundle permissions. Grant a role to a person from their user page, scoped to the whole tenant, an org unit, a location or a register. System roles are fixed: clone one to customise it."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create role
            </Button>
          ) : null
        }
      />
      <ResourceTable
        tableId="roles"
        caption="Roles"
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error ? describeError(query.error) : null}
        onRetry={() => void query.refetch()}
        selectedId={openId}
        defaultHidden={['desc']}
        filters={[
          { id: 'q', label: 'Search', type: 'text', placeholder: 'Name or key' },
          {
            id: 'type',
            label: 'Type',
            type: 'select',
            options: [
              { value: 'System', label: 'System' },
              { value: 'Custom', label: 'Custom' },
            ],
          },
        ]}
        matches={(r, f) =>
          (!f.q || `${r.name} ${r.key}`.toLowerCase().includes(f.q.toLowerCase())) &&
          (!f.type || (r.isSystem ? 'System' : 'Custom') === f.type)
        }
        emptyTitle="No roles"
        emptyDescription="System roles are created when the tenant is provisioned. If this list is empty, ask support to re-seed the access catalogue."
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpenId(null)}
        title={open?.name ?? ''}
        description={
          open ? `${open.isSystem ? 'System role' : 'Custom role'} · ${open.key}` : undefined
        }
        wide
      >
        {open ? (
          <RoleDetail key={open.id + open.updatedAt} role={open} canManage={canManage} />
        ) : null}
      </Drawer>
      <Drawer open={creating} onClose={() => setCreating(false)} title="Create role">
        {creating ? (
          <CreateRole
            onDone={(r) => {
              setCreating(false);
              setOpenId(r.id);
            }}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function RoleDetail({ role, canManage }: { role: RoleDto; canManage: boolean }) {
  const perms = usePermissions();
  const editable = !role.isSystem && canManage;
  const [selected, setSelected] = useState<Set<string>>(new Set(role.permissions));
  const [limits, setLimits] = useState(role.limits);
  const [cloning, setCloning] = useState(false);
  const savePerms = useApiMutation({
    mutationFn: () =>
      api<RoleDto>(`/roles/${role.id}/permissions`, {
        method: 'PUT',
        body: { permissions: [...selected] },
      }),
    invalidate: [keys.roles],
    success: 'Permissions saved',
  });
  const saveLimits = useApiMutation({
    mutationFn: () => api<RoleDto>(`/roles/${role.id}/limits`, { method: 'PUT', body: { limits } }),
    invalidate: [keys.roles],
    success: 'Limits saved',
  });
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="stack">
      {role.isSystem ? (
        <Alert tone="info">
          System roles cannot be edited. Clone this role to create a version you can change.
        </Alert>
      ) : null}
      {canManage ? (
        <div>
          <Button onClick={() => setCloning((v) => !v)}>
            {cloning ? 'Cancel clone' : 'Clone role…'}
          </Button>
        </div>
      ) : null}
      {cloning ? <CloneForm role={role} onDone={() => setCloning(false)} /> : null}

      <fieldset className="fieldset">
        <legend>Permissions ({selected.size})</legend>
        {MODULES.map((module) => (
          <div key={module} style={{ marginBottom: 12 }}>
            <strong>{titleCase(module)}</strong>
            <div className="perm-grid">
              {PERMISSIONS.filter((p) => p.module === module).map((p) => (
                <div key={p.key} className="field field-checkbox">
                  <input
                    id={`perm-${p.key}`}
                    type="checkbox"
                    checked={selected.has(p.key)}
                    disabled={!editable}
                    onChange={() => toggle(p.key)}
                  />
                  <label htmlFor={`perm-${p.key}`}>
                    <code>{p.key}</code>
                    {p.isSensitive ? ' · sensitive' : ''}
                  </label>
                  <div className="field-hint" style={{ flexBasis: '100%', marginLeft: 24 }}>
                    {p.description}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {editable ? (
          <Button
            variant="primary"
            onClick={() => savePerms.mutate(undefined)}
            loading={savePerms.isPending}
          >
            Save permissions
          </Button>
        ) : null}
      </fieldset>

      <LimitsEditor
        value={limits}
        onChange={setLimits}
        disabled={role.isSystem || !perms.has('access.limit.manage')}
        legend="Role limits"
      />
      {!role.isSystem && perms.has('access.limit.manage') ? (
        <div>
          <Button
            variant="primary"
            onClick={() => saveLimits.mutate(undefined)}
            loading={saveLimits.isPending}
          >
            Save limits
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CloneForm({ role, onDone }: { role: RoleDto; onDone(): void }) {
  const form = useZodForm(CloneRoleSchema, {
    key: `${role.key}_copy`,
    name: `${role.name} (copy)`,
  } as Record<string, unknown>);
  const clone = useApiMutation({
    mutationFn: (body: unknown) =>
      api<RoleDto>(`/roles/${role.id}/clone`, { method: 'POST', body, idempotent: true }),
    invalidate: [keys.roles],
    success: 'Role cloned',
    silentError: true,
  });
  return (
    <form
      noValidate
      aria-label="Clone role"
      className="card"
      onSubmit={form.handleSubmit(async (b) => {
        await clone.mutateAsync(b);
        onDone();
      })}
    >
      <TextInput
        label="Name"
        value={String(form.values.name)}
        onChange={(e) => form.setValue('name', e.target.value)}
        onBlur={() => form.blur('name')}
        error={form.errors.name}
        required
      />
      <TextInput
        label="Key"
        value={String(form.values.key)}
        onChange={(e) => form.setValue('key', e.target.value)}
        onBlur={() => form.blur('key')}
        error={form.errors.key}
        hint="snake_case, starts with a letter"
        required
      />
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Create copy
      </Button>
    </form>
  );
}

function CreateRole({ onDone }: { onDone(r: RoleDto): void }) {
  const form = useZodForm(
    CreateRoleSchema,
    { key: '', name: '', description: '' } as Record<string, unknown>,
    {
      toInput: (v) => ({
        key: v.key,
        name: String(v.name).trim(),
        ...(String(v.description).trim() ? { description: String(v.description).trim() } : {}),
      }),
    },
  );
  const create = useApiMutation({
    mutationFn: (body: unknown) =>
      api<RoleDto>('/roles', { method: 'POST', body, idempotent: true }),
    invalidate: [keys.roles],
    success: 'Role created',
    silentError: true,
  });
  return (
    <form
      noValidate
      aria-label="Create role"
      onSubmit={form.handleSubmit(async (b) => onDone(await create.mutateAsync(b)))}
    >
      <TextInput
        label="Name"
        value={String(form.values.name)}
        onChange={(e) => form.setValue('name', e.target.value)}
        onBlur={() => form.blur('name')}
        error={form.errors.name}
        required
      />
      <TextInput
        label="Key"
        value={String(form.values.key)}
        onChange={(e) => form.setValue('key', e.target.value)}
        onBlur={() => form.blur('key')}
        error={form.errors.key}
        hint="snake_case, for example floor_lead"
        required
      />
      <TextareaInput
        label="Description"
        value={String(form.values.description)}
        onChange={(e) => form.setValue('description', e.target.value)}
        error={form.errors.description}
        rows={2}
      />
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Create role
      </Button>
      <p className="field-hint">Pick permissions after the role exists.</p>
    </form>
  );
}
