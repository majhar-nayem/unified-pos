'use client';

import { useState } from 'react';

import { diffValues, summariseDiff, type DiffKind } from '@/lib/diff';

const MARK: Record<DiffKind, string> = {
  added: '+ added',
  removed: '− removed',
  changed: '~ changed',
  same: 'unchanged',
};

/**
 * Before/after diff used by the audit browser and config history. Each row states what happened in
 * words as well as colour; unchanged rows are hidden until asked for.
 */
export function DiffView({
  before,
  after,
  label = 'Changes',
}: {
  before: unknown;
  after: unknown;
  label?: string;
}) {
  const [showSame, setShowSame] = useState(false);
  const rows = diffValues(before, after);
  const summary = summariseDiff(rows);
  const visible = rows.filter((r) => showSame || r.kind !== 'same');
  if (rows.length === 0) return <p className="muted">No recorded values.</p>;
  return (
    <div>
      <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span aria-live="polite">
          {label}: {summary.changed} changed, {summary.added} added, {summary.removed} removed
        </span>
        {rows.some((r) => r.kind === 'same') ? (
          <label className="inline">
            <input
              type="checkbox"
              checked={showSame}
              onChange={(e) => setShowSame(e.target.checked)}
            />{' '}
            Show unchanged
          </label>
        ) : null}
      </div>
      <div className="diff" role="table" aria-label={label}>
        <div className="diff-row diff-head" role="row">
          <div role="columnheader">Field</div>
          <div role="columnheader">Before</div>
          <div role="columnheader">After</div>
        </div>
        {visible.length === 0 ? (
          <div className="diff-row" role="row">
            <div style={{ gridColumn: 'span 3' }} role="cell">
              Nothing changed.
            </div>
          </div>
        ) : null}
        {visible.map((row) => (
          <div key={row.path} className="diff-row" role="row" data-kind={row.kind}>
            <div role="cell">
              <code>{row.path}</code>
              <div className="muted" style={{ fontSize: 12 }}>
                {MARK[row.kind]}
              </div>
            </div>
            <div
              role="cell"
              className={
                row.kind === 'changed' || row.kind === 'removed' ? 'diff-before' : 'diff-same'
              }
            >
              <code>{row.before ?? '—'}</code>
            </div>
            <div
              role="cell"
              className={
                row.kind === 'changed' || row.kind === 'added' ? 'diff-after' : 'diff-same'
              }
            >
              <code>{row.after ?? '—'}</code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
