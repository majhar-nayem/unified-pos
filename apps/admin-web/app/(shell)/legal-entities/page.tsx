'use client';

import {
  CreateLegalEntitySchema,
  UpdateLegalEntitySchema,
  type LegalEntityDto,
} from '@pos/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

import { ResourceTable, RowLink } from '@/components/data-table/ResourceTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { FormError, SelectInput, TextInput, TextareaInput } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import { keys, useApiMutation, useLegalEntities } from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { ACTIVE_ARCHIVED_OPTIONS } from '@/lib/options';
import { useZodForm } from '@/lib/zod-form';

export default function LegalEntitiesPage() {
  const perms = usePermissions();
  const query = useLegalEntities();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canManage = perms.has('tenancy.legal_entity.manage');
  const open = query.data?.find((e) => e.id === openId) ?? null;

  const columns = useMemo<ColumnDef<LegalEntityDto, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessorFn: (r) => r.name,
        cell: ({ row }) => (
          <RowLink onClick={() => setOpenId(row.original.id)}>{row.original.name}</RowLink>
        ),
      },
      { id: 'country', header: 'Country', accessorFn: (r) => r.countryCode },
      {
        id: 'registration',
        header: 'Registration no.',
        accessorFn: (r) => r.registrationNumber ?? '—',
      },
      { id: 'tax', header: 'Tax no.', accessorFn: (r) => r.taxRegistrationNumber ?? '—' },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => r.status,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'updated',
        header: 'Updated',
        accessorFn: (r) => r.updatedAt,
        cell: ({ row }) => formatDateTime(row.original.updatedAt),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Legal entities"
        description="The registered companies that trade. Their details print on receipts and tax invoices."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add legal entity
            </Button>
          ) : null
        }
      />
      <ResourceTable
        tableId="legal-entities"
        caption="Legal entities"
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error ? describeError(query.error) : null}
        onRetry={() => void query.refetch()}
        selectedId={openId}
        filters={[
          { id: 'q', label: 'Search', type: 'text', placeholder: 'Name or number' },
          { id: 'status', label: 'Status', type: 'select', options: ACTIVE_ARCHIVED_OPTIONS },
        ]}
        matches={(r, f) =>
          (!f.q ||
            `${r.name} ${r.registrationNumber ?? ''} ${r.taxRegistrationNumber ?? ''}`
              .toLowerCase()
              .includes(f.q.toLowerCase())) &&
          (!f.status || r.status === f.status)
        }
        emptyTitle="No legal entities yet"
        emptyDescription="Add the company (for example an Australian Pty Ltd) that owns your locations so receipts carry its ABN and legal text."
        emptyAction={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add legal entity
            </Button>
          ) : undefined
        }
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpenId(null)}
        title={open?.name ?? ''}
        description={open ? `Version ${open.version}` : undefined}
      >
        {open ? (
          <EntityForm key={`${open.id}-${open.version}`} entity={open} canManage={canManage} />
        ) : null}
      </Drawer>
      <Drawer open={creating} onClose={() => setCreating(false)} title="Add legal entity">
        {creating ? <EntityForm onDone={() => setCreating(false)} canManage /> : null}
      </Drawer>
    </>
  );
}

function EntityForm({
  entity,
  canManage,
  onDone,
}: {
  entity?: LegalEntityDto;
  canManage: boolean;
  onDone?: () => void;
}) {
  const schema = entity ? UpdateLegalEntitySchema : CreateLegalEntitySchema;
  const form = useZodForm(
    schema,
    {
      name: entity?.name ?? '',
      countryCode: entity?.countryCode ?? 'AU',
      registrationNumber: entity?.registrationNumber ?? '',
      taxRegistrationNumber: entity?.taxRegistrationNumber ?? '',
      receiptLegalText: entity?.receiptLegalText ?? '',
      status: entity?.status ?? 'active',
      'address.line1': entity?.address.line1 ?? '',
      'address.city': entity?.address.city ?? '',
      'address.region': entity?.address.region ?? '',
      'address.postcode': entity?.address.postcode ?? '',
    } as Record<string, unknown>,
    { toInput: (values) => toPayload(values, Boolean(entity)) },
  );
  const save = useApiMutation({
    mutationFn: (body: unknown) =>
      entity
        ? api<LegalEntityDto>(`/legal-entities/${entity.id}`, {
            method: 'PATCH',
            body,
            ifMatch: entity.version,
          })
        : api<LegalEntityDto>('/legal-entities', { method: 'POST', body, idempotent: true }),
    invalidate: [keys.legalEntities],
    success: entity ? 'Legal entity saved' : 'Legal entity created',
    silentError: true,
  });
  const str = (k: string) => String(form.values[k] ?? '');
  const field = (k: string, label: string, extra: { hint?: string; required?: boolean } = {}) => (
    <TextInput
      label={label}
      value={str(k)}
      onChange={(e) => form.setValue(k, e.target.value)}
      onBlur={() => form.blur(k)}
      error={form.errors[k]}
      disabled={!canManage}
      {...extra}
    />
  );
  return (
    <form
      noValidate
      aria-label={entity ? 'Edit legal entity' : 'New legal entity'}
      onSubmit={form.handleSubmit(async (body) => {
        await save.mutateAsync(body);
        onDone?.();
      })}
    >
      <div className="form-grid">
        {field('name', 'Legal name', { required: true })}
        {field('countryCode', 'Country code', { hint: 'ISO 3166 two letters, for example AU' })}
        {field('registrationNumber', 'Company registration no.')}
        {field('taxRegistrationNumber', 'Tax registration no. (ABN)')}
        {field('address.line1', 'Address')}
        {field('address.city', 'City')}
        {field('address.region', 'State or region')}
        {field('address.postcode', 'Postcode')}
        <div className="span-2">
          <TextareaInput
            label="Receipt legal text"
            rows={3}
            value={str('receiptLegalText')}
            onChange={(e) => form.setValue('receiptLegalText', e.target.value)}
            error={form.errors.receiptLegalText}
            disabled={!canManage}
          />
        </div>
        {entity ? (
          <SelectInput
            label="Status"
            options={ACTIVE_ARCHIVED_OPTIONS}
            value={str('status')}
            onChange={(e) => form.setValue('status', e.target.value)}
            disabled={!canManage}
          />
        ) : null}
      </div>
      <FormError message={form.formError} />
      {canManage ? (
        <Button type="submit" variant="primary" loading={form.submitting}>
          {entity ? 'Save changes' : 'Create legal entity'}
        </Button>
      ) : null}
    </form>
  );
}

function toPayload(v: Record<string, unknown>, update: boolean): Record<string, unknown> {
  const str = (k: string) => String(v[k] ?? '').trim();
  const address = Object.fromEntries(
    (['line1', 'city', 'region', 'postcode'] as const)
      .map((k) => [k, str(`address.${k}`)] as const)
      .filter(([, val]) => val),
  );
  const optional = (k: string) =>
    update ? { [k]: str(k) || null } : str(k) ? { [k]: str(k) } : {};
  return {
    name: str('name'),
    countryCode: str('countryCode'),
    address: Object.keys(address).length ? { ...address, countryCode: str('countryCode') } : {},
    ...optional('registrationNumber'),
    ...optional('taxRegistrationNumber'),
    ...optional('receiptLegalText'),
    ...(update ? { status: v.status } : {}),
  };
}
