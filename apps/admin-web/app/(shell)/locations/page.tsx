'use client';

import {
  CreateLocationSchema,
  TimezoneSchema,
  UpdateLocationSchema,
  type BusinessDayDto,
  type LocationDto,
} from '@pos/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

import { ResourceTable, RowLink } from '@/components/data-table/ResourceTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { FormError, SelectInput, TextInput } from '@/components/ui/Field';
import { Alert, KeyValue, PageHeader, Tabs } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import {
  keys,
  useApiMutation,
  useBusinessDays,
  useLegalEntities,
  useLocations,
  useOrgUnits,
} from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import {
  COMMON_TIMEZONES,
  DEPLOYMENT_PROFILE_OPTIONS,
  LOCATION_KIND_OPTIONS,
  LOCATION_STATUS_OPTIONS,
  isValidTimezone,
} from '@/lib/options';
import { useZodForm } from '@/lib/zod-form';

const TimezoneChecked = TimezoneSchema.refine(
  isValidTimezone,
  'Unknown time zone (use an IANA name such as Australia/Sydney)',
);
const CreateSchema = CreateLocationSchema.extend({ timezone: TimezoneChecked });
const UpdateSchema = UpdateLocationSchema.extend({ timezone: TimezoneChecked.optional() });

export default function LocationsPage() {
  const perms = usePermissions();
  const query = useLocations();
  const orgUnits = useOrgUnits();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canManage = perms.has('tenancy.location.manage');
  const open = query.data?.find((l) => l.id === openId) ?? null;
  const unitName = useMemo(
    () => new Map((orgUnits.data ?? []).map((u) => [u.id, u.name])),
    [orgUnits.data],
  );

  const columns = useMemo<ColumnDef<LocationDto, never>[]>(
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
        id: 'kind',
        header: 'Kind',
        accessorFn: (r) => r.kind,
        cell: ({ row }) => titleCase(row.original.kind),
      },
      { id: 'unit', header: 'Org unit', accessorFn: (r) => unitName.get(r.orgUnitId) ?? '—' },
      {
        id: 'profile',
        header: 'Deployment',
        accessorFn: (r) => r.deploymentProfile,
        cell: ({ row }) => titleCase(row.original.deploymentProfile),
      },
      { id: 'timezone', header: 'Time zone', accessorFn: (r) => r.timezone },
      { id: 'boundary', header: 'Day starts', accessorFn: (r) => r.businessDayBoundary },
      { id: 'currency', header: 'Currency', accessorFn: (r) => r.currency },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => r.status,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    [unitName],
  );

  return (
    <>
      <PageHeader
        title="Locations"
        description="Stores, restaurants and warehouses. Each has a time zone and a business day boundary that decide which day a sale belongs to."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add location
            </Button>
          ) : null
        }
      />
      <ResourceTable
        tableId="locations"
        caption="Locations"
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error ? describeError(query.error) : null}
        onRetry={() => void query.refetch()}
        selectedId={openId}
        defaultHidden={['currency', 'unit']}
        filters={[
          { id: 'q', label: 'Search', type: 'text', placeholder: 'Name or code' },
          { id: 'kind', label: 'Kind', type: 'select', options: LOCATION_KIND_OPTIONS },
          {
            id: 'profile',
            label: 'Deployment',
            type: 'select',
            options: DEPLOYMENT_PROFILE_OPTIONS,
          },
          { id: 'status', label: 'Status', type: 'select', options: LOCATION_STATUS_OPTIONS },
        ]}
        matches={(r, f) =>
          (!f.q || `${r.name} ${r.code}`.toLowerCase().includes(f.q.toLowerCase())) &&
          (!f.kind || r.kind === f.kind) &&
          (!f.profile || r.deploymentProfile === f.profile) &&
          (!f.status || r.status === f.status)
        }
        emptyTitle="No locations yet"
        emptyDescription="A location is a place that trades: a store, a restaurant or a warehouse. Add one to enrol registers and open a business day."
        emptyAction={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add location
            </Button>
          ) : undefined
        }
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpenId(null)}
        title={open?.name ?? ''}
        description={open ? `${titleCase(open.kind)} · ${open.code}` : undefined}
        wide
      >
        {open ? (
          <LocationDetail
            key={`${open.id}-${open.version}`}
            location={open}
            canManage={canManage}
          />
        ) : null}
      </Drawer>
      <Drawer open={creating} onClose={() => setCreating(false)} title="Add location">
        {creating ? (
          <LocationForm
            onDone={(created) => {
              setCreating(false);
              setOpenId(created.id);
            }}
            canManage
          />
        ) : null}
      </Drawer>
    </>
  );
}

function LocationDetail({ location, canManage }: { location: LocationDto; canManage: boolean }) {
  const [tab, setTab] = useState<'details' | 'days'>('details');
  return (
    <>
      <Tabs<'details' | 'days'>
        label="Location sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'details', label: 'Details' },
          { id: 'days', label: 'Business days' },
        ]}
      />
      {tab === 'details' ? (
        <LocationForm location={location} canManage={canManage} />
      ) : (
        <BusinessDays location={location} />
      )}
    </>
  );
}

function BusinessDays({ location }: { location: LocationDto }) {
  const perms = usePermissions();
  const days = useBusinessDays(location.id);
  const open = useApiMutation({
    mutationFn: () =>
      api<BusinessDayDto>(`/locations/${location.id}/business-days/open`, {
        method: 'POST',
        body: {},
        idempotent: true,
      }),
    invalidate: [keys.businessDays(location.id)],
    success: 'Business day opened',
  });
  const rows = days.data ?? [];
  return (
    <div className="stack">
      <KeyValue
        items={[
          { label: 'Time zone', value: location.timezone },
          { label: 'Day boundary', value: `${location.businessDayBoundary} local time` },
        ]}
      />
      {days.error ? <Alert tone="danger">{describeError(days.error)}</Alert> : null}
      {perms.has('tenancy.business_day.open') ? (
        <div>
          <Button onClick={() => open.mutate(undefined)} loading={open.isPending}>
            Open today’s business day
          </Button>
        </div>
      ) : null}
      {rows.length === 0 && !days.isLoading ? (
        <p className="muted">No business days yet. Registers cannot trade until a day is open.</p>
      ) : (
        <table className="table" aria-label="Business days">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col">Opened</th>
              <th scope="col">Closed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.businessDate}>
                <td className="num">{d.businessDate}</td>
                <td>
                  <StatusBadge status={d.status} />
                </td>
                <td>{formatDateTime(d.openedAt)}</td>
                <td>{formatDateTime(d.closedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LocationForm({
  location,
  canManage,
  onDone,
}: {
  location?: LocationDto;
  canManage: boolean;
  onDone?: (created: LocationDto) => void;
}) {
  const orgUnits = useOrgUnits();
  const legal = useLegalEntities();
  const form = useZodForm(
    location ? UpdateSchema : CreateSchema,
    {
      orgUnitId: location?.orgUnitId ?? '',
      legalEntityId: location?.legalEntityId ?? '',
      code: location?.code ?? '',
      name: location?.name ?? '',
      kind: location?.kind ?? 'store',
      deploymentProfile: location?.deploymentProfile ?? 'cloud_only',
      timezone: location?.timezone ?? 'Australia/Sydney',
      currency: location?.currency ?? 'AUD',
      locale: location?.locale ?? 'en-AU',
      businessDayBoundary: location?.businessDayBoundary ?? '04:00',
      status: location?.status ?? 'onboarding',
    } as Record<string, unknown>,
    {
      toInput: (v) => {
        const base = {
          orgUnitId: v.orgUnitId,
          code: String(v.code).trim(),
          name: String(v.name).trim(),
          kind: v.kind,
          deploymentProfile: v.deploymentProfile,
          timezone: String(v.timezone).trim(),
          currency: String(v.currency).trim().toUpperCase(),
          locale: String(v.locale).trim(),
          businessDayBoundary: v.businessDayBoundary,
        };
        return location
          ? { ...base, legalEntityId: v.legalEntityId || null, status: v.status }
          : { ...base, ...(v.legalEntityId ? { legalEntityId: v.legalEntityId } : {}) };
      },
    },
  );
  const save = useApiMutation({
    mutationFn: (body: unknown) =>
      location
        ? api<LocationDto>(`/locations/${location.id}`, {
            method: 'PATCH',
            body,
            ifMatch: location.version,
          })
        : api<LocationDto>('/locations', { method: 'POST', body, idempotent: true }),
    invalidate: [keys.locations],
    success: location ? 'Location saved' : 'Location created',
    silentError: true,
  });
  const s = (k: string) => String(form.values[k] ?? '');
  const text = (
    k: string,
    label: string,
    extra: { hint?: string; required?: boolean; list?: string } = {},
  ) => (
    <TextInput
      label={label}
      value={s(k)}
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
      aria-label={location ? 'Edit location' : 'New location'}
      onSubmit={form.handleSubmit(async (body) => {
        const result = await save.mutateAsync(body);
        onDone?.(result as LocationDto);
      })}
    >
      <datalist id="timezones">
        {COMMON_TIMEZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <div className="form-grid">
        {text('name', 'Name', { required: true })}
        {text('code', 'Code', { required: true, hint: 'Letters, digits, _ and - only' })}
        <SelectInput
          label="Kind"
          options={LOCATION_KIND_OPTIONS}
          value={s('kind')}
          onChange={(e) => form.setValue('kind', e.target.value)}
          disabled={!canManage}
          error={form.errors.kind}
        />
        <SelectInput
          label="Org unit"
          placeholder="Choose…"
          options={(orgUnits.data ?? []).map((u) => ({ value: u.id, label: u.name }))}
          value={s('orgUnitId')}
          onChange={(e) => form.setValue('orgUnitId', e.target.value)}
          onBlur={() => form.blur('orgUnitId')}
          error={form.errors.orgUnitId}
          disabled={!canManage}
          required
        />
        <SelectInput
          label="Legal entity"
          placeholder="None"
          options={(legal.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
          value={s('legalEntityId')}
          onChange={(e) => form.setValue('legalEntityId', e.target.value)}
          disabled={!canManage}
        />
        <SelectInput
          label="Deployment profile"
          options={DEPLOYMENT_PROFILE_OPTIONS}
          value={s('deploymentProfile')}
          onChange={(e) => form.setValue('deploymentProfile', e.target.value)}
          hint="Cloud only needs connectivity; autonomous devices keep trading offline; a store hub serves the whole site."
          disabled={!canManage}
          error={form.errors.deploymentProfile}
        />
        {text('timezone', 'Time zone', {
          list: 'timezones',
          hint: 'IANA name, for example Australia/Sydney',
          required: true,
        })}
        <TextInput
          label="Business day boundary"
          type="time"
          value={s('businessDayBoundary')}
          onChange={(e) => form.setValue('businessDayBoundary', e.target.value)}
          onBlur={() => form.blur('businessDayBoundary')}
          error={form.errors.businessDayBoundary}
          hint="Sales before this local time count towards the previous day."
          disabled={!canManage}
        />
        {text('currency', 'Currency', { hint: 'ISO 4217, for example AUD', required: true })}
        {text('locale', 'Locale', { hint: 'For example en-AU' })}
        {location ? (
          <SelectInput
            label="Status"
            options={LOCATION_STATUS_OPTIONS}
            value={s('status')}
            onChange={(e) => form.setValue('status', e.target.value)}
            disabled={!canManage}
          />
        ) : null}
      </div>
      <FormError message={form.formError} />
      {canManage ? (
        <Button type="submit" variant="primary" loading={form.submitting}>
          {location ? 'Save changes' : 'Create location'}
        </Button>
      ) : (
        <Alert tone="info">You can view this location but not change it.</Alert>
      )}
    </form>
  );
}
