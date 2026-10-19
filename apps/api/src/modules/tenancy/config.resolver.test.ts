import { describe, expect, it } from 'vitest';

import { resolveNearest } from './config.resolver.js';

const path = [
  { kind: 'register' as const, id: 'reg' },
  { kind: 'location' as const, id: 'loc' },
  { kind: 'org_unit' as const, id: 'ou-child' },
  { kind: 'org_unit' as const, id: 'ou-root' },
  { kind: 'tenant' as const, id: 't' },
];

describe('resolveNearest', () => {
  it('register beats location beats org unit beats tenant', () => {
    const candidates = [
      { scopeKind: 'tenant' as const, scopeId: 't', value: 'T', version: 1 },
      { scopeKind: 'org_unit' as const, scopeId: 'ou-root', value: 'R', version: 2 },
      { scopeKind: 'location' as const, scopeId: 'loc', value: 'L', version: 3 },
    ];
    expect(resolveNearest('receipt.header', path, candidates)).toEqual({
      key: 'receipt.header',
      value: 'L',
      resolvedScope: { kind: 'location', id: 'loc' },
      version: 3,
    });
    expect(resolveNearest('receipt.header', path, candidates.slice(0, 2)).value).toBe('R');
    expect(resolveNearest('receipt.header', path, candidates.slice(0, 1)).value).toBe('T');
    expect(
      resolveNearest('receipt.header', path, [
        ...candidates,
        { scopeKind: 'register', scopeId: 'reg', value: 'G', version: 9 },
      ]).value,
    ).toBe('G');
  });

  it('ignores entries on scopes outside the path and falls back to the registry default', () => {
    const resolved = resolveNearest('cash.rounding.enabled', path, [
      { scopeKind: 'location', scopeId: 'other-loc', value: false, version: 1 },
    ]);
    expect(resolved).toEqual({
      key: 'cash.rounding.enabled',
      value: true,
      resolvedScope: 'default',
      version: null,
    });
    expect(resolveNearest('unknown.key', path, []).value).toBeNull();
  });
});
