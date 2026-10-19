'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

import { AuditTimeline } from '@/components/audit/AuditTimeline';
import { DiffView } from '@/components/audit/DiffView';
import { ResourceTable, RowLink } from '@/components/data-table/ResourceTable';
import type { FilterValues } from '@/components/data-table/types';
import { useCursorPages } from '@/components/data-table/useCursorPages';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { Alert, KeyValue, PageHeader } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import {
  type AuditEntry,
  type AuditPage,
  type ChainVerification,
  useApiMutation,
  useLocations,
  useUsers,
} from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { formatDateTime, shortId, titleCase } from '@/lib/format';

const toIso = (local: string | undefined) => {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

export default function AuditPage() {
  const perms = usePermissions();
  const users = useUsers(perms.has('identity.user.view'));
  const locations = useLocations();
  const [filters, setFilters] = useState<FilterValues>({});
  const [startAt, setStartAt] = useState<number | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const [focus, setFocus] = useState<AuditEntry | null>(null);
  const userName = useMemo(
    () => new Map((users.data ?? []).map((u) => [u.id, u.displayName])),
    [users.data],
  );
  const locationName = useMemo(
    () => new Map((locations.data ?? []).map((l) => [l.id, l.name])),
    [locations.data],
  );

  const resetKey = JSON.stringify([filters, startAt]);
  const { query, rows, paging } = useCursorPages<AuditEntry, number>({
    queryKey: ['audit', 'list'],
    resetKey,
    initialPageSize: 25,
    fetchPage: ({ cursor, limit }) =>
      api<AuditPage>('/audit', {
        query: {
          resourceKind: filters.resourceKind?.trim(),
          action: filters.action?.trim(),
          actorId: filters.actorId,
          from: toIso(filters.from),
          to: toIso(filters.to),
          cursor: cursor ?? startAt,
          limit,
        },
      }),
  });
  const open = focus ?? rows.find((r) => r.id === openId) ?? null;

  const verify = useApiMutation({
    mutationFn: () => api<ChainVerification>('/audit/verify', { method: 'POST', idempotent: true }),
  });
  const jumpLatest = useApiMutation({
    mutationFn: () => api<{ headSeq: number | null }>('/audit/head'),
  });

  const actor = (e: AuditEntry) =>
    e.actorId
      ? (userName.get(e.actorId) ?? `${titleCase(e.actorKind)} ${shortId(e.actorId)}`)
      : titleCase(e.actorKind);

  const columns = useMemo<ColumnDef<AuditEntry, never>[]>(
    () => [
      {
        id: 'seq',
        header: '#',
        accessorFn: (r) => r.seq,
        cell: ({ row }) => <span className="num">{row.original.seq}</span>,
      },
      {
        id: 'time',
        header: 'When',
        accessorFn: (r) => r.occurredAt,
        cell: ({ row }) => formatDateTime(row.original.occurredAt),
      },
      { id: 'actor', header: 'Who', accessorFn: (r) => actor(r) },
      {
        id: 'action',
        header: 'Action',
        accessorFn: (r) => r.action,
        cell: ({ row }) => (
          <RowLink
            onClick={() => {
              setFocus(null);
              setOpenId(row.original.id);
            }}
          >
            {row.original.action}
          </RowLink>
        ),
      },
      {
        id: 'resource',
        header: 'Resource',
        accessorFn: (r) => `${r.resourceKind} ${shortId(r.resourceId)}`,
        cell: ({ row }) => (
          <>
            {titleCase(row.original.resourceKind)} <code>{shortId(row.original.resourceId)}</code>
          </>
        ),
      },
      {
        id: 'location',
        header: 'Location',
        accessorFn: (r) =>
          r.locationId ? (locationName.get(r.locationId) ?? shortId(r.locationId)) : '—',
      },
      { id: 'reason', header: 'Reason', accessorFn: (r) => r.reason ?? '—' },
    ],
    [userName, locationName],
  );

  if (!perms.has('audit.view')) return <Alert tone="warning">You cannot view the audit log.</Alert>;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every write is recorded with who, when and the before and after values. Entries are hash-chained and cannot be edited."
        actions={
          <>
            <Button
              onClick={async () => {
                const head = await jumpLatest.mutateAsync(undefined);
                setStartAt(Math.max(0, (head.headSeq ?? 0) - paging.pageSize));
              }}
              loading={jumpLatest.isPending}
            >
              Jump to latest
            </Button>
            {startAt !== undefined ? (
              <Button variant="ghost" onClick={() => setStartAt(undefined)}>
                Back to oldest
              </Button>
            ) : null}
            {perms.has('audit.verify') ? (
              <Button onClick={() => verify.mutate(undefined)} loading={verify.isPending}>
                Verify chain
              </Button>
            ) : null}
          </>
        }
      />
      {verify.data ? (
        <Alert tone={verify.data.ok && verify.data.headMatches ? 'success' : 'danger'}>
          {verify.data.ok && verify.data.headMatches
            ? `Chain verified: ${verify.data.checked} entries checked, head at #${verify.data.headSeq ?? 0}.`
            : `Chain verification failed${verify.data.firstBrokenSeq ? ` at entry #${verify.data.firstBrokenSeq}` : ''}. Treat the log as suspect and escalate.`}
        </Alert>
      ) : null}
      <p className="muted" aria-live="polite">
        The API lists oldest entries first; use Jump to latest for recent activity.
      </p>
      <ResourceTable
        tableId="audit"
        caption="Audit entries"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error ? describeError(query.error) : null}
        onRetry={() => void query.refetch()}
        paging={paging}
        onFiltersChange={(f) => setFilters(f)}
        selectedId={openId}
        defaultHidden={['reason']}
        filters={[
          { id: 'action', label: 'Action', type: 'text', placeholder: 'tenancy.config.changed' },
          { id: 'resourceKind', label: 'Resource kind', type: 'text', placeholder: 'location' },
          ...(users.data
            ? [
                {
                  id: 'actorId',
                  label: 'Actor',
                  type: 'select' as const,
                  options: users.data.map((u) => ({ value: u.id, label: u.displayName })),
                },
              ]
            : []),
          { id: 'from', label: 'From', type: 'date' },
          { id: 'to', label: 'To', type: 'date' },
        ]}
        emptyTitle="No audit entries yet"
        emptyDescription="Entries appear as soon as anyone changes something: creating a location, granting a role, editing configuration."
        filteredEmptyTitle="No entries match these filters"
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => {
          setOpenId(null);
          setFocus(null);
        }}
        title={open?.action ?? ''}
        description={open ? `Entry #${open.seq}` : undefined}
        wide
      >
        {open ? (
          <div className="stack">
            <KeyValue
              items={[
                { label: 'When', value: formatDateTime(open.occurredAt) },
                {
                  label: 'Who',
                  value: (
                    <>
                      {actor(open)} <Badge tone="neutral">{open.actorKind}</Badge>
                    </>
                  ),
                },
                {
                  label: 'Resource',
                  value: (
                    <>
                      {titleCase(open.resourceKind)} <code>{open.resourceId ?? '—'}</code>
                    </>
                  ),
                },
                ...(open.locationId
                  ? [
                      {
                        label: 'Location',
                        value: locationName.get(open.locationId) ?? open.locationId,
                      },
                    ]
                  : []),
                ...(open.reason ? [{ label: 'Reason', value: open.reason }] : []),
                ...(open.approvalId
                  ? [{ label: 'Approval', value: <code>{open.approvalId}</code> }]
                  : []),
                ...(open.correlationId
                  ? [{ label: 'Correlation id', value: <code>{open.correlationId}</code> }]
                  : []),
              ]}
            />
            <section aria-label="Before and after">
              <h3 className="card-title">What changed</h3>
              <DiffView before={open.before} after={open.after} label="Audit diff" />
            </section>
            {open.resourceId ? (
              <section aria-label="Resource history">
                <h3 className="card-title">History of this resource</h3>
                <AuditTimeline
                  resourceId={open.resourceId}
                  currentId={open.id}
                  onSelect={(id) => {
                    void api<AuditPage>('/audit', {
                      query: { resourceId: open.resourceId, limit: 50 },
                    }).then((p) => setFocus(p.items.find((i) => i.id === id) ?? null));
                  }}
                />
              </section>
            ) : null}
            <details>
              <summary>Integrity hashes</summary>
              <KeyValue
                items={[
                  { label: 'Previous', value: <code>{open.prevHash ?? '(first entry)'}</code> },
                  { label: 'Hash', value: <code>{open.hash}</code> },
                ]}
              />
            </details>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
