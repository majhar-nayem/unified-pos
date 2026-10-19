'use client';

import { useQuery } from '@tanstack/react-query';

import { Spinner } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import type { AuditPage } from '@/lib/api/resources';
import { formatDateTime } from '@/lib/format';

/** Everything recorded against one resource, oldest first. */
export function AuditTimeline({
  resourceId,
  currentId,
  onSelect,
}: {
  resourceId: string;
  currentId: string;
  onSelect?(id: string): void;
}) {
  const q = useQuery({
    queryKey: ['audit', 'timeline', resourceId],
    queryFn: () => api<AuditPage>('/audit', { query: { resourceId, limit: 50 } }),
  });
  if (q.isLoading) return <Spinner label="Loading history" />;
  if (q.error) return <p role="alert">{describeError(q.error)}</p>;
  const items = q.data?.items ?? [];
  if (items.length <= 1)
    return <p className="muted">This is the only recorded change for this resource.</p>;
  return (
    <ol className="timeline" aria-label="Changes to this resource">
      {items.map((e) => (
        <li key={e.id} aria-current={e.id === currentId ? 'true' : undefined}>
          <div>
            <strong>{e.action}</strong>{' '}
            {e.id === currentId ? (
              <span className="muted">(this entry)</span>
            ) : onSelect ? (
              <button type="button" className="row-link" onClick={() => onSelect(e.id)}>
                Open
              </button>
            ) : null}
          </div>
          <div className="muted">
            {formatDateTime(e.occurredAt)} · #{e.seq}
            {e.reason ? ` · ${e.reason}` : ''}
          </div>
        </li>
      ))}
    </ol>
  );
}
