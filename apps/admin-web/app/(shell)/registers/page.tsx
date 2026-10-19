'use client';

import { CreateRegisterSchema, UpdateRegisterSchema, type RegisterDto } from '@pos/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

import { ResourceTable, RowLink } from '@/components/data-table/ResourceTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { FormError, SelectInput, TextInput } from '@/components/ui/Field';
import { Alert, PageHeader } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import {
  keys,
  useApiMutation,
  useDepartments,
  useLocations,
  useRegisters,
} from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { REGISTER_KIND_OPTIONS, REGISTER_STATUS_OPTIONS } from '@/lib/options';
import { useZodForm } from '@/lib/zod-form';

export default function RegistersPage() {
  const perms = usePermissions();
  const query = useRegisters();
  const locations = useLocations();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canManage = perms.has('tenancy.register.manage');
  const open = query.data?.find((r) => r.id === openId) ?? null;
  const locationName = useMemo(
    () => new Map((locations.data ?? []).map((l) => [l.id, l.name])),
    [locations.data],
  );

  const columns = useMemo<ColumnDef<RegisterDto, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorFn: (r) => r.name,
        cell: ({ row }) => (
          <RowLink onClick={() => setOpenId(row.original.id)}>{row.original.name}</RowLink>
        ),
      },
      {
        id: 'code',
        header: 'Code',
        accessorFn: (r) => r.code,
        cell: ({ row }) => <code>{row.original.code}</code>,
      },
      {
        id: 'location',
        header: 'Location',
        accessorFn: (r) => locationName.get(r.locationId) ?? '—',
      },
      {
        id: 'kind',
        header: 'Kind',
        accessorFn: (r) => r.kind,
        cell: ({ row }) => titleCase(row.original.kind),
      },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => r.status,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    [locationName],
  );

  return (
    <>
      <PageHeader
        title="Registers"
        description="Logical tills and terminals at a location. A device is enrolled and then assigned to one of these."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add register
            </Button>
          ) : null
        }
      />
      <ResourceTable
        tableId="registers"
        caption="Registers"
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error ? describeError(query.error) : null}
        onRetry={() => void query.refetch()}
        selectedId={openId}
        filters={[
          { id: 'q', label: 'Search', type: 'text', placeholder: 'Name or code' },
          {
            id: 'location',
            label: 'Location',
            type: 'select',
            options: (locations.data ?? []).map((l) => ({ value: l.id, label: l.name })),
          },
          { id: 'kind', label: 'Kind', type: 'select', options: REGISTER_KIND_OPTIONS },
          { id: 'status', label: 'Status', type: 'select', options: REGISTER_STATUS_OPTIONS },
        ]}
        matches={(r, f) =>
          (!f.q || `${r.name} ${r.code}`.toLowerCase().includes(f.q.toLowerCase())) &&
          (!f.location || r.locationId === f.location) &&
          (!f.kind || r.kind === f.kind) &&
          (!f.status || r.status === f.status)
        }
        emptyTitle="No registers yet"
        emptyDescription="Add a register for each till or terminal. Enrolment codes for devices are issued per location and register."
        emptyAction={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add register
            </Button>
          ) : undefined
        }
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpenId(null)}
        title={open?.name ?? ''}
        description={open ? locationName.get(open.locationId) : undefined}
      >
        {open ? (
          <RegisterForm key={`${open.id}-${open.version}`} register={open} canManage={canManage} />
        ) : null}
      </Drawer>
      <Drawer open={creating} onClose={() => setCreating(false)} title="Add register">
        {creating ? <RegisterForm canManage onDone={() => setCreating(false)} /> : null}
      </Drawer>
    </>
  );
}

function RegisterForm({
  register,
  canManage,
  onDone,
}: {
  register?: RegisterDto;
  canManage: boolean;
  onDone?: () => void;
}) {
  const locations = useLocations();
  const form = useZodForm(
    register ? UpdateRegisterSchema : CreateRegisterSchema,
    {
      locationId: register?.locationId ?? '',
      departmentId: register?.departmentId ?? '',
      code: register?.code ?? '',
      name: register?.name ?? '',
      kind: register?.kind ?? 'pos',
      status: register?.status ?? 'active',
    } as Record<string, unknown>,
    {
      toInput: (v) => ({
        code: String(v.code).trim(),
        name: String(v.name).trim(),
        kind: v.kind,
        departmentId: v.departmentId ? v.departmentId : register ? null : undefined,
        ...(register ? { status: v.status } : {}),
      }),
    },
  );
  const locationId = String(form.values.locationId ?? '');
  const departments = useDepartments(locationId || undefined);
  const save = useApiMutation({
    mutationFn: (body: unknown) =>
      register
        ? api<RegisterDto>(`/registers/${register.id}`, {
            method: 'PATCH',
            body,
            ifMatch: register.version,
          })
        : api<RegisterDto>(`/locations/${locationId}/registers`, {
            method: 'POST',
            body,
            idempotent: true,
          }),
    invalidate: [keys.registers],
    success: register ? 'Register saved' : 'Register created',
    silentError: true,
  });
  const s = (k: string) => String(form.values[k] ?? '');
  return (
    <form
      noValidate
      aria-label={register ? 'Edit register' : 'New register'}
      onSubmit={form.handleSubmit(async (body) => {
        if (!register && !locationId) {
          form.setFormError('Choose a location first.');
          return;
        }
        await save.mutateAsync(body);
        onDone?.();
      })}
    >
      <SelectInput
        label="Location"
        placeholder="Choose…"
        options={(locations.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
        value={locationId}
        onChange={(e) => form.setValues({ locationId: e.target.value, departmentId: '' })}
        disabled={Boolean(register) || !canManage}
        required
      />
      <TextInput
        label="Name"
        value={s('name')}
        onChange={(e) => form.setValue('name', e.target.value)}
        onBlur={() => form.blur('name')}
        error={form.errors.name}
        disabled={!canManage}
        required
      />
      <TextInput
        label="Code"
        value={s('code')}
        onChange={(e) => form.setValue('code', e.target.value)}
        onBlur={() => form.blur('code')}
        error={form.errors.code}
        hint="Letters, digits, _ and - only"
        disabled={!canManage}
        required
      />
      <SelectInput
        label="Kind"
        options={REGISTER_KIND_OPTIONS}
        value={s('kind')}
        onChange={(e) => form.setValue('kind', e.target.value)}
        disabled={!canManage}
      />
      <SelectInput
        label="Department"
        placeholder="None"
        options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
        value={s('departmentId')}
        onChange={(e) => form.setValue('departmentId', e.target.value)}
        disabled={!canManage || !locationId}
      />
      {register ? (
        <SelectInput
          label="Status"
          options={REGISTER_STATUS_OPTIONS}
          value={s('status')}
          onChange={(e) => form.setValue('status', e.target.value)}
          disabled={!canManage}
        />
      ) : null}
      <FormError message={form.formError} />
      {canManage ? (
        <Button type="submit" variant="primary" loading={form.submitting}>
          {register ? 'Save changes' : 'Create register'}
        </Button>
      ) : (
        <Alert tone="info">You can view this register but not change it.</Alert>
      )}
    </form>
  );
}
