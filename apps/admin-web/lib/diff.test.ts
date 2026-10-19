import { describe, expect, it } from 'vitest';

import { diffValues, flatten, summariseDiff } from './diff';

describe('diff', () => {
  it('flattens nested objects to dotted paths and treats arrays as leaves', () => {
    expect(flatten({ a: { b: 1, c: [1, 2] }, d: 'x' })).toEqual({
      'a.b': '1',
      'a.c': '[1,2]',
      d: '"x"',
    });
    expect(flatten('plain')).toEqual({ '(value)': '"plain"' });
  });

  it('classifies added, removed, changed and unchanged paths in a stable order', () => {
    const rows = diffValues(
      { name: 'A', limit: 10, gone: true, same: 1 },
      { name: 'B', limit: 10, added: 'x', same: 1 },
    );
    expect(rows.map((r) => [r.path, r.kind])).toEqual([
      ['added', 'added'],
      ['gone', 'removed'],
      ['limit', 'same'],
      ['name', 'changed'],
      ['same', 'same'],
    ]);
    expect(summariseDiff(rows)).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it('handles a create (no before) and a delete (no after)', () => {
    expect(diffValues(null, { a: 1 }).map((r) => r.kind)).toEqual(['added']);
    expect(diffValues({ a: 1 }, null).map((r) => r.kind)).toEqual(['removed']);
    expect(diffValues(null, null)).toEqual([]);
  });

  it('distinguishes null from absent', () => {
    expect(diffValues({ a: null }, { a: 1 })[0]!.kind).toBe('changed');
  });
});
