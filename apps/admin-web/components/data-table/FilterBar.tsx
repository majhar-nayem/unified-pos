'use client';

import { Button } from '@/components/ui/Button';

import type { FilterDef, FilterValues } from './types';

interface FilterBarProps {
  defs: readonly FilterDef[];
  values: FilterValues;
  onChange(next: FilterValues): void;
}

/** Filter inputs plus removable chips for what is applied, so active filters are never hidden. */
export function FilterBar({ defs, values, onChange }: FilterBarProps) {
  const active = defs.filter((d) => values[d.id]);
  const set = (id: string, value: string) => {
    const next = { ...values };
    if (value) next[id] = value;
    else delete next[id];
    onChange(next);
  };
  return (
    <div role="search" aria-label="Filter rows">
      <div className="table-toolbar">
        {defs.map((def) => {
          const id = `filter-${def.id}`;
          return (
            <div key={def.id} className="field">
              <label className="field-label" htmlFor={id}>
                {def.label}
              </label>
              {def.type === 'select' ? (
                <select
                  id={id}
                  className="input"
                  value={values[def.id] ?? ''}
                  onChange={(e) => set(def.id, e.target.value)}
                >
                  <option value="">All</option>
                  {def.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  className="input"
                  type={def.type === 'date' ? 'datetime-local' : 'search'}
                  placeholder={def.placeholder}
                  value={values[def.id] ?? ''}
                  onChange={(e) => set(def.id, e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
      {active.length > 0 ? (
        <div className="chips" aria-label="Applied filters" style={{ marginBottom: 12 }}>
          {active.map((def) => (
            <span key={def.id} className="chip">
              {def.label}:{' '}
              <strong>
                {def.options?.find((o) => o.value === values[def.id])?.label ?? values[def.id]}
              </strong>
              <button
                type="button"
                aria-label={`Remove filter ${def.label}`}
                onClick={() => set(def.id, '')}
              >
                ×
              </button>
            </span>
          ))}
          <Button size="sm" variant="ghost" onClick={() => onChange({})}>
            Clear all
          </Button>
        </div>
      ) : null}
    </div>
  );
}
