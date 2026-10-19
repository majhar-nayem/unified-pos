import { describe, expect, it } from 'vitest';

import { buildPath, checkContractCompleteness, substituteFixtures } from './fixture-registry.js';
import { listOperations } from './openapi-walker.js';

const doc = {
  openapi: '3.1.0',
  paths: {
    '/v1/locations/{locationId}': {
      get: {
        operationId: 'tenancy.location.get',
        parameters: [{ name: 'locationId', in: 'path', required: true, 'x-fixture': 'locationId' }],
        'x-scope': { kind: 'location', param: 'locationId' },
        responses: {},
      },
      patch: {
        operationId: 'tenancy.location.update',
        parameters: [{ name: 'locationId', in: 'path', 'x-fixture': 'locationId' }],
        requestBody: { content: { 'application/json': { schema: {} } } },
        responses: {},
      },
    },
    '/v1/config': {
      put: {
        operationId: 'config.put',
        parameters: [],
        requestBody: {
          content: {
            'application/json': {
              schema: {},
              example: { scopeId: '$fixture:locationId', value: 1 },
            },
          },
        },
        responses: {},
        'x-idempotent': true,
      },
    },
    '/v1/health': {
      get: { operationId: 'platform.health', parameters: [], responses: {}, 'x-public': true },
    },
  },
};

describe('harness helpers', () => {
  it('lists operations with fixtures, scope and flags', () => {
    const ops = listOperations(doc);
    expect(ops.map((o) => o.operationId)).toEqual([
      'config.put',
      'platform.health',
      'tenancy.location.get',
      'tenancy.location.update',
    ]);
    const get = ops.find((o) => o.operationId === 'tenancy.location.get')!;
    expect(get.pathParams).toEqual([{ name: 'locationId', fixture: 'locationId' }]);
    expect(get.scope).toEqual({ kind: 'location', param: 'locationId' });
    expect(ops.find((o) => o.operationId === 'config.put')!.idempotent).toBe(true);
    expect(buildPath(get, { locationId: 'abc' })).toBe('/v1/locations/abc');
  });

  it('substitutes placeholders and fails loudly on unknown fixtures', () => {
    expect(
      substituteFixtures({ a: ['$fixture:x', 1], b: '$fixture:y' }, { x: '1', y: '2' }, 'op'),
    ).toEqual({ a: ['1', 1], b: '2' });
    expect(() => substituteFixtures('$fixture:nope', {}, 'op')).toThrow(/nope/);
  });

  it('reports incomplete contracts', () => {
    const problems = checkContractCompleteness(listOperations(doc), { locationId: 'x' });
    expect(problems).toEqual([
      { operationId: 'tenancy.location.update', problem: 'request body has no example' },
      { operationId: 'tenancy.location.update', problem: 'has path parameters but no x-scope' },
    ]);
  });
});
