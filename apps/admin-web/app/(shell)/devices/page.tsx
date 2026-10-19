'use client';

import {
  CreateEnrollmentCodeSchema,
  DEVICE_ENROLLMENT_STATUSES,
  type DeviceDto,
} from '@pos/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useState } from 'react';

import { ResourceTable, RowLink } from '@/components/data-table/ResourceTable';
import { Badge, StatusBadge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Drawer } from '@/components/ui/Drawer';
import { CheckboxInput, FormError, SelectInput } from '@/components/ui/Field';
import { Alert, CopyButton, KeyValue, PageHeader, Tabs } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import { keys, useApiMutation, useDevices, useLocations, useRegisters } from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { HEALTH_LABEL, type DeviceHealth, deviceHealth } from '@/lib/device-health';
import { formatDateTime, formatRelative, titleCase } from '@/lib/format';
import { DEVICE_KIND_OPTIONS, opts } from '@/lib/options';
import { useZodForm } from '@/lib/zod-form';

const HEALTH_TONE: Record<DeviceHealth, Tone> = {
  healthy: 'success',
  delayed: 'warning',
  offline: 'danger',
  never_connected: 'warning',
  inactive: 'neutral',
};

interface IssuedCode {
  code: string;
  expiresAt: string;
  kind: string;
  locationName: string;
}

export default function DevicesPage() {
  const perms = usePermissions();
  const [tab, setTab] = useState<'devices' | 'codes'>('devices');
  const devices = useDevices();
  const locations = useLocations();
  const registers = useRegisters();
  const [openId, setOpenId] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedCode[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const open = devices.data?.find((d) => d.id === openId) ?? null;

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const locationName = useMemo(
    () => new Map((locations.data ?? []).map((l) => [l.id, l.name])),
    [locations.data],
  );
  const registerName = useMemo(
    () => new Map((registers.data ?? []).map((r) => [r.id, r.name])),
    [registers.data],
  );

  const columns = useMemo<ColumnDef<DeviceDto, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Device',
        accessorFn: (r) => r.name,
        cell: ({ row }) => (
          <RowLink onClick={() => setOpenId(row.original.id)}>{row.original.name}</RowLink>
        ),
      },
      {
        id: 'kind',
        header: 'Kind',
        accessorFn: (r) => r.kind,
        cell: ({ row }) => titleCase(row.original.kind),
      },
      {
        id: 'location',
        header: 'Location',
        accessorFn: (r) => locationName.get(r.locationId) ?? '—',
      },
      {
        id: 'register',
        header: 'Register',
        accessorFn: (r) => (r.registerId ? (registerName.get(r.registerId) ?? '—') : 'Unassigned'),
      },
      {
        id: 'health',
        header: 'Health',
        accessorFn: (r) => HEALTH_LABEL[deviceHealth(r, now)],
        cell: ({ row }) => {
          const h = deviceHealth(row.original, now);
          return <Badge tone={HEALTH_TONE[h]}>{HEALTH_LABEL[h]}</Badge>;
        },
      },
      {
        id: 'seen',
        header: 'Last seen',
        accessorFn: (r) => r.lastSeenAt ?? '',
        cell: ({ row }) => formatRelative(row.original.lastSeenAt, now),
      },
      { id: 'version', header: 'App version', accessorFn: (r) => r.appVersion ?? '—' },
      {
        id: 'status',
        header: 'Enrolment',
        accessorFn: (r) => r.enrollmentStatus,
        cell: ({ row }) => <StatusBadge status={row.original.enrollmentStatus} />,
      },
    ],
    [locationName, registerName, now],
  );

  const canEnroll = perms.has('devices.enroll');
  const rows = devices.data ?? [];
  const unhealthy = rows.filter((d) =>
    ['offline', 'never_connected'].includes(deviceHealth(d, now)),
  ).length;

  return (
    <>
      <PageHeader
        title="Devices"
        description="Enrolled tills, kitchen screens and hubs. Health comes from when each device last called the API."
        actions={
          canEnroll ? (
            <Button variant="primary" onClick={() => setTab('codes')}>
              Generate enrolment code
            </Button>
          ) : null
        }
      />
      <Tabs<'devices' | 'codes'>
        label="Device sections"
        value={tab}
        onChange={(next) => {
          setTab(next);
          if (next === 'devices') void devices.refetch();
        }}
        tabs={[
          { id: 'devices', label: 'Devices', count: rows.length },
          ...(canEnroll ? [{ id: 'codes' as const, label: 'Enrolment codes' }] : []),
        ]}
      />
      {tab === 'devices' ? (
        <>
          {unhealthy > 0 ? (
            <Alert tone="warning">
              {unhealthy} {unhealthy === 1 ? 'device needs' : 'devices need'} attention: offline for
              over an hour or never connected.
            </Alert>
          ) : null}
          <ResourceTable
            tableId="devices"
            caption="Devices"
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            loading={devices.isLoading}
            error={devices.error ? describeError(devices.error) : null}
            onRetry={() => void devices.refetch()}
            selectedId={openId}
            defaultHidden={['version']}
            filters={[
              { id: 'q', label: 'Search', type: 'text', placeholder: 'Device name' },
              {
                id: 'health',
                label: 'Health',
                type: 'select',
                options: (Object.keys(HEALTH_LABEL) as DeviceHealth[]).map((h) => ({
                  value: h,
                  label: HEALTH_LABEL[h],
                })),
              },
              { id: 'kind', label: 'Kind', type: 'select', options: DEVICE_KIND_OPTIONS },
              {
                id: 'status',
                label: 'Enrolment',
                type: 'select',
                options: opts(DEVICE_ENROLLMENT_STATUSES),
              },
              {
                id: 'location',
                label: 'Location',
                type: 'select',
                options: (locations.data ?? []).map((l) => ({ value: l.id, label: l.name })),
              },
            ]}
            matches={(r, f) =>
              (!f.q || r.name.toLowerCase().includes(f.q.toLowerCase())) &&
              (!f.health || deviceHealth(r, now) === f.health) &&
              (!f.kind || r.kind === f.kind) &&
              (!f.status || r.enrollmentStatus === f.status) &&
              (!f.location || r.locationId === f.location)
            }
            emptyTitle="No devices enrolled"
            emptyDescription="Generate an enrolment code, then enter it in the POS app on the new device. Codes are single use and expire after 15 minutes."
            emptyAction={
              canEnroll ? (
                <Button variant="primary" onClick={() => setTab('codes')}>
                  Generate enrolment code
                </Button>
              ) : undefined
            }
          />
        </>
      ) : (
        <CodesPanel issued={issued} onIssued={(c) => setIssued((prev) => [c, ...prev])} />
      )}
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpenId(null)}
        title={open?.name ?? ''}
        description={
          open ? `${titleCase(open.kind)} · ${locationName.get(open.locationId) ?? ''}` : undefined
        }
      >
        {open ? (
          <DeviceDetail
            key={open.id + open.enrollmentStatus}
            device={open}
            now={now}
            register={open.registerId ? registerName.get(open.registerId) : undefined}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function DeviceDetail({
  device,
  now,
  register,
}: {
  device: DeviceDto;
  now: number;
  register: string | undefined;
}) {
  const perms = usePermissions();
  const health = deviceHealth(device, now);
  const [confirming, setConfirming] = useState(false);
  const [wipe, setWipe] = useState(false);
  const revoke = useApiMutation({
    mutationFn: (reason: string) =>
      api<DeviceDto>(`/devices/${device.id}/revoke`, {
        method: 'POST',
        body: {
          reason: [wipe ? '[wipe requested]' : '', reason].filter(Boolean).join(' ') || undefined,
        },
        idempotent: true,
      }),
    invalidate: [keys.devices],
    success: wipe ? 'Device revoked and wipe requested' : 'Device revoked',
  });
  const canRevoke = perms.has('devices.revoke') && device.enrollmentStatus === 'enrolled';
  return (
    <div className="stack">
      <KeyValue
        items={[
          {
            label: 'Health',
            value: <Badge tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Badge>,
          },
          { label: 'Enrolment', value: <StatusBadge status={device.enrollmentStatus} /> },
          {
            label: 'Last seen',
            value: `${formatDateTime(device.lastSeenAt)} (${formatRelative(device.lastSeenAt, now)})`,
          },
          { label: 'Enrolled', value: formatDateTime(device.enrolledAt) },
          ...(device.revokedAt
            ? [{ label: 'Revoked', value: formatDateTime(device.revokedAt) }]
            : []),
          { label: 'Register', value: register ?? 'Unassigned' },
          { label: 'Platform', value: device.platform ? titleCase(device.platform) : '—' },
          { label: 'App version', value: device.appVersion ?? '—' },
          { label: 'Device id', value: <code>{device.id}</code> },
        ]}
      />
      {health === 'offline' ? (
        <Alert tone="warning">
          No contact for over an hour. Check power and network at the site before revoking.
        </Alert>
      ) : null}
      {canRevoke ? (
        <>
          <CheckboxInput
            label="Also request a remote wipe"
            checked={wipe}
            onChange={(e) => setWipe(e.target.checked)}
            hint="Recorded in the audit log with the revocation. The API has no wipe command yet, so the device keeps its local data until the POS shell supports it."
          />
          <div>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Revoke device…
            </Button>
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={`Revoke ${device.name}?`}
        message="The device is signed out and can no longer sync or take payments. Enrolling it again needs a new code."
        confirmLabel="Revoke device"
        reason={{ label: 'Reason (kept in the audit log)' }}
        busy={revoke.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={async (reason) => {
          await revoke.mutateAsync(reason);
          setConfirming(false);
        }}
      />
    </div>
  );
}

function CodesPanel({ issued, onIssued }: { issued: IssuedCode[]; onIssued(c: IssuedCode): void }) {
  const locations = useLocations();
  const registers = useRegisters();
  const form = useZodForm(
    CreateEnrollmentCodeSchema,
    { locationId: '', registerId: '', kind: 'pos' } as Record<string, unknown>,
    {
      toInput: (v) => ({
        locationId: v.locationId,
        kind: v.kind,
        ...(v.registerId ? { registerId: v.registerId } : {}),
      }),
    },
  );
  const create = useApiMutation({
    mutationFn: (body: unknown) =>
      api<{ code: string; expiresAt: string }>('/devices/enrollment-codes', {
        method: 'POST',
        body,
        idempotent: true,
      }),
    success: 'Enrolment code generated',
    silentError: true,
  });
  const locationId = String(form.values.locationId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="grid grid-2">
      <form
        noValidate
        aria-label="Generate enrolment code"
        className="card"
        onSubmit={form.handleSubmit(async (body) => {
          const r = await create.mutateAsync(body);
          onIssued({
            code: r.code,
            expiresAt: r.expiresAt,
            kind: String((body as { kind: string }).kind),
            locationName: locations.data?.find((l) => l.id === locationId)?.name ?? '',
          });
        })}
      >
        <h2 className="card-title">Generate an enrolment code</h2>
        <SelectInput
          label="Location"
          placeholder="Choose…"
          options={(locations.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
          value={locationId}
          onChange={(e) => form.setValues({ locationId: e.target.value, registerId: '' })}
          onBlur={() => form.blur('locationId')}
          error={form.errors.locationId}
          required
        />
        <SelectInput
          label="Device kind"
          options={DEVICE_KIND_OPTIONS}
          value={String(form.values.kind)}
          onChange={(e) => form.setValue('kind', e.target.value)}
          error={form.errors.kind}
        />
        <SelectInput
          label="Register (optional)"
          placeholder="Assign later"
          options={(registers.data ?? [])
            .filter((r) => r.locationId === locationId)
            .map((r) => ({ value: r.id, label: r.name }))}
          value={String(form.values.registerId)}
          onChange={(e) => form.setValue('registerId', e.target.value)}
          disabled={!locationId}
        />
        <FormError message={form.formError} />
        <Button type="submit" variant="primary" loading={form.submitting}>
          Generate code
        </Button>
      </form>
      <section className="card" aria-label="Codes issued this session">
        <h2 className="card-title">Codes issued this session</h2>
        <p className="muted">
          Codes are shown once. They are single use and expire 15 minutes after issue. The API has
          no way to cancel a code early, so an unused code simply lapses.
        </p>
        {issued.length === 0 ? <p className="muted">None yet.</p> : null}
        <ul className="attention-list">
          {issued.map((c) => {
            const expired = Date.parse(c.expiresAt) <= now;
            return (
              <li key={c.code} className="attention-item">
                <div>
                  <code data-testid="enrolment-code" style={{ fontSize: 16, fontWeight: 700 }}>
                    {c.code}
                  </code>
                  <div className="muted">
                    {titleCase(c.kind)} · {c.locationName} ·{' '}
                    {expired ? 'expired' : `expires ${formatRelative(c.expiresAt, now)}`}
                  </div>
                </div>
                <CopyButton value={c.code} />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
