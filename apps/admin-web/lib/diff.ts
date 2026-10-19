export type DiffKind = 'added' | 'removed' | 'changed' | 'same';
export interface DiffRow {
  path: string;
  kind: DiffKind;
  before: string | null;
  after: string | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Flattens nested objects to dotted paths; arrays and primitives are leaves (compared as JSON). */
export function flatten(
  value: unknown,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix || '(value)'] = JSON.stringify(value === undefined ? null : value);
  }
  return out;
}

export function diffValues(before: unknown, after: unknown): DiffRow[] {
  const b = before === null || before === undefined ? {} : flatten(before);
  const a = after === null || after === undefined ? {} : flatten(after);
  const paths = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort();
  return paths.map((path) => {
    const bv = path in b ? b[path]! : null;
    const av = path in a ? a[path]! : null;
    const kind: DiffKind =
      bv === null ? 'added' : av === null ? 'removed' : bv === av ? 'same' : 'changed';
    return { path, kind, before: bv, after: av };
  });
}

export function summariseDiff(rows: readonly DiffRow[]): {
  added: number;
  removed: number;
  changed: number;
} {
  return {
    added: rows.filter((r) => r.kind === 'added').length,
    removed: rows.filter((r) => r.kind === 'removed').length,
    changed: rows.filter((r) => r.kind === 'changed').length,
  };
}
