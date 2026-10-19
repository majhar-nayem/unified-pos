'use client';

import { CreateDepartmentSchema, type DepartmentDto } from '@pos/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useState } from 'react';

import { ResourceTable } from '@/components/data-table/ResourceTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { FormError, SelectInput, TextInput } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import { keys, useApiMutation, useDepartments, useLocations } from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { DEPARTMENT_KIND_OPTIONS } from '@/lib/options';
import { useZodForm } from '@/lib/zod-form';

export default function DepartmentsPage() {
  const perms = usePermissions();
  const locations = useLocations();
  const [locationId, setLocationId] = useState('');
  const [creating, setCreating] = useState(false);
  const canManage = perms.has('tenancy.department.manage');

  useEffect(() => {
    if (!locationId && locations.data?.[0]) setLocationId(locations.data[0].id);
  }, [locations.data, locationId]);

  const departments = useDepartments(locationId || undefined);
  const columns = useMemo<ColumnDef<DepartmentDto, never>[]>(
    () => [
      { id: 'name', header: 'Name', accessorFn: (r) => r.name },
      {
        id: 'code',
        header: 'Code',
        accessorFn: (r) => r.code,
        cell: ({ row }) => <code>{row.original.code}</code>,
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
    [],
  );

  return (
    <>
      <PageHeader
        title="Departments"
        description="Sections inside a location, such as bar, bakery or retail floor. Registers and reports can be grouped by department."
        actions={
          canManage && locationId ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add department
            </Button>
          ) : null
        }
      />
      <div style={{ maxWidth: 360 }}>
        <SelectInput
          label="Location"
          options={(locations.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        />
      </div>
      <ResourceTable
        tableId={`departments`}
        caption="Departments"
        columns={columns}
        rows={departments.data ?? []}
        getRowId={(r) => r.id}
        loading={departments.isLoading}
        error={
          departments.error
            ? describeError(departments.error)
            : locations.error
              ? describeError(locations.error)
              : null
        }
        filters={[{ id: 'q', label: 'Search', type: 'text', placeholder: 'Name or code' }]}
        matches={(r, f) => !f.q || `${r.name} ${r.code}`.toLowerCase().includes(f.q.toLowerCase())}
        emptyTitle={locationId ? 'No departments at this location' : 'Choose a location'}
        emptyDescription={
          locationId
            ? 'Departments are optional. Add one to group registers or reports within the location.'
            : 'Departments belong to a location. Pick one above.'
        }
        emptyAction={
          canManage && locationId ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add department
            </Button>
          ) : undefined
        }
      />
      <Drawer open={creating} onClose={() => setCreating(false)} title="Add department">
        {creating ? (
          <DepartmentForm locationId={locationId} onDone={() => setCreating(false)} />
        ) : null}
      </Drawer>
    </>
  );
}

function DepartmentForm({ locationId, onDone }: { locationId: string; onDone(): void }) {
  const form = useZodForm(CreateDepartmentSchema, { code: '', name: '', kind: 'general' } as Record<
    string,
    unknown
  >);
  const create = useApiMutation({
    mutationFn: (body: unknown) =>
      api<DepartmentDto>(`/locations/${locationId}/departments`, {
        method: 'POST',
        body,
        idempotent: true,
      }),
    invalidate: [keys.departments(locationId)],
    success: 'Department created',
    silentError: true,
  });
  return (
    <form
      noValidate
      aria-label="New department"
      onSubmit={form.handleSubmit(async (b) => {
        await create.mutateAsync(b);
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
        label="Code"
        value={String(form.values.code)}
        onChange={(e) => form.setValue('code', e.target.value)}
        onBlur={() => form.blur('code')}
        error={form.errors.code}
        hint="Letters, digits, _ and - only"
        required
      />
      <SelectInput
        label="Kind"
        options={DEPARTMENT_KIND_OPTIONS}
        value={String(form.values.kind)}
        onChange={(e) => form.setValue('kind', e.target.value)}
      />
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Create department
      </Button>
    </form>
  );
}
