'use client';

import { APPROVAL_STATUSES, DecideApprovalSchema, type ApprovalRequestDto } from '@pos/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

import { ResourceTable, RowLink } from '@/components/data-table/ResourceTable';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { FormError, TextareaInput } from '@/components/ui/Field';
import { Alert, JsonView, KeyValue, PageHeader, Tabs } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import { useApiMutation, useApprovals, useLocations, useUsers } from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { formatDateTime, formatRelative, titleCase } from '@/lib/format';
import { useZodForm } from '@/lib/zod-form';

type Status = (typeof APPROVAL_STATUSES)[number];

export default function ApprovalsPage() {
  const perms = usePermissions();
  const [status, setStatus] = useState<Status>('pending');
  const query = useApprovals(status);
  const users = useUsers(perms.has('identity.user.view'));
  const locations = useLocations();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = query.data?.find((a) => a.id === openId) ?? null;
  const userName = useMemo(
    () => new Map((users.data ?? []).map((u) => [u.id, u.displayName])),
    [users.data],
  );
  const locationName = useMemo(
    () => new Map((locations.data ?? []).map((l) => [l.id, l.name])),
    [locations.data],
  );
  const who = (id: string | null) => (id ? (userName.get(id) ?? id.slice(0, 8)) : '—');

  const columns = useMemo<ColumnDef<ApprovalRequestDto, never>[]>(
    () => [
      {
        id: 'kind',
        header: 'Request',
        accessorFn: (r) => r.kind,
        cell: ({ row }) => (
          <RowLink onClick={() => setOpenId(row.original.id)}>
            {titleCase(row.original.kind)}
          </RowLink>
        ),
      },
      { id: 'requester', header: 'Requested by', accessorFn: (r) => who(r.requestedBy) },
      {
        id: 'location',
        header: 'Location',
        accessorFn: (r) => (r.locationId ? (locationName.get(r.locationId) ?? '—') : '—'),
      },
      {
        id: 'requested',
        header: 'Requested',
        accessorFn: (r) => r.requestedAt,
        cell: ({ row }) => formatRelative(row.original.requestedAt),
      },
      {
        id: 'expires',
        header: 'Expires',
        accessorFn: (r) => r.expiresAt,
        cell: ({ row }) =>
          row.original.status === 'pending' ? formatRelative(row.original.expiresAt) : '—',
      },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => r.status,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    [userName, locationName],
  );

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Over-limit actions waiting for a manager: discounts, refunds, voids. Approve or reject here, or at the register with a PIN."
      />
      <Tabs<Status>
        label="Approval status"
        value={status}
        onChange={(s) => {
          setStatus(s);
          setOpenId(null);
        }}
        tabs={APPROVAL_STATUSES.map((s) => ({ id: s, label: titleCase(s) }))}
      />
      <ResourceTable
        tableId={`approvals-${status}`}
        caption={`${titleCase(status)} approval requests`}
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error ? describeError(query.error) : null}
        onRetry={() => void query.refetch()}
        selectedId={openId}
        filters={[
          { id: 'q', label: 'Search', type: 'text', placeholder: 'Kind or requester' },
          {
            id: 'location',
            label: 'Location',
            type: 'select',
            options: (locations.data ?? []).map((l) => ({ value: l.id, label: l.name })),
          },
        ]}
        matches={(r, f) =>
          (!f.q || `${r.kind} ${who(r.requestedBy)}`.toLowerCase().includes(f.q.toLowerCase())) &&
          (!f.location || r.locationId === f.location)
        }
        emptyTitle={status === 'pending' ? 'Nothing waiting for approval' : `No ${status} requests`}
        emptyDescription={
          status === 'pending'
            ? 'When a cashier goes over a limit, the request appears here and at the manager’s register. Requests expire after 15 minutes.'
            : 'Decided and expired requests are kept here for review.'
        }
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpenId(null)}
        title={open ? titleCase(open.kind) : ''}
        description={open ? `Requested by ${who(open.requestedBy)}` : undefined}
        wide
      >
        {open ? (
          <ApprovalDetail
            key={open.id + open.status}
            request={open}
            who={who}
            location={open.locationId ? locationName.get(open.locationId) : undefined}
            onDecided={() => setOpenId(null)}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function ApprovalDetail({
  request,
  who,
  location,
  onDecided,
}: {
  request: ApprovalRequestDto;
  who(id: string | null): string;
  location: string | undefined;
  onDecided(): void;
}) {
  const perms = usePermissions();
  const canDecide = perms.has('approvals.approve');
  const expired = Date.parse(request.expiresAt) < Date.now();
  const pending = request.status === 'pending' && !expired;
  const form = useZodForm(DecideApprovalSchema, { note: '' } as Record<string, unknown>, {
    toInput: (v) => (String(v.note).trim() ? { note: String(v.note).trim() } : {}),
  });
  const decide = useApiMutation({
    mutationFn: ({ action, body }: { action: 'approve' | 'reject'; body: unknown }) =>
      api<ApprovalRequestDto>(`/approvals/${request.id}/${action}`, {
        method: 'POST',
        body,
        idempotent: true,
      }),
    invalidate: [['approvals']],
    success: (r) => (r.status === 'approved' ? 'Request approved' : 'Request rejected'),
    silentError: true,
  });
  const run = (action: 'approve' | 'reject') =>
    form.handleSubmit(async (body) => {
      await decide.mutateAsync({ action, body });
      onDecided();
    })();
  const payload = request.payload as { permission?: string; attributes?: Record<string, unknown> };

  return (
    <div className="stack">
      {request.status === 'pending' && expired ? (
        <Alert tone="warning">This request has expired and can no longer be approved.</Alert>
      ) : null}
      <KeyValue
        items={[
          {
            label: 'Status',
            value: (
              <StatusBadge
                status={expired && request.status === 'pending' ? 'expired' : request.status}
              />
            ),
          },
          { label: 'Location', value: location ?? '—' },
          {
            label: 'Subject',
            value: `${titleCase(request.subjectKind)}${request.subjectId ? ` ${request.subjectId.slice(0, 8)}` : ''}`,
          },
          ...(payload.permission
            ? [{ label: 'Permission', value: <code>{payload.permission}</code> }]
            : []),
          ...Object.entries(payload.attributes ?? {}).map(([k, v]) => ({
            label: k,
            value: <code>{String(v)}</code>,
          })),
          { label: 'Requested', value: formatDateTime(request.requestedAt) },
          { label: 'Expires', value: formatDateTime(request.expiresAt) },
          ...(request.decidedBy
            ? [
                {
                  label: 'Decided by',
                  value: `${who(request.decidedBy)} · ${formatDateTime(request.decidedAt)}`,
                },
              ]
            : []),
          ...(request.decisionNote ? [{ label: 'Note', value: request.decisionNote }] : []),
        ]}
      />
      <details>
        <summary>Full request payload</summary>
        <JsonView value={request.payload} />
      </details>
      {pending && canDecide ? (
        <form noValidate aria-label="Decide request" onSubmit={(e) => e.preventDefault()}>
          <TextareaInput
            label="Note (optional)"
            rows={2}
            value={String(form.values.note)}
            onChange={(e) => form.setValue('note', e.target.value)}
            error={form.errors.note}
          />
          <FormError message={form.formError} />
          <div className="inline">
            <Button variant="primary" loading={form.submitting} onClick={() => void run('approve')}>
              Approve
            </Button>
            <Button onClick={() => void run('reject')} disabled={form.submitting}>
              Reject
            </Button>
          </div>
        </form>
      ) : null}
      {pending && !canDecide ? (
        <Alert tone="info">You can view this request but not decide it.</Alert>
      ) : null}
    </div>
  );
}
