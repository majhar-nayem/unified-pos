import { describe, expect, it } from 'vitest';

import { parseStreamEvent } from './event-consumer.js';
import { streamFields } from './publisher.js';

describe('stream event codec', () => {
  it('round-trips an outbox row through stream fields', () => {
    const row = {
      id: '0190f8a0-0000-7000-8000-000000000001',
      tenant_id: '0190f8a0-0000-7000-8000-00000000000a',
      location_id: null,
      aggregate_kind: 'location',
      aggregate_id: '0190f8a0-0000-7000-8000-000000000002',
      aggregate_version: 3,
      event_type: 'location.created',
      payload: { code: 'x' },
      headers: { correlation_id: 'c' },
      occurred_at: new Date('2026-10-18T03:00:00.000Z'),
      published_at: null,
      attempts: 0,
      last_error: null,
    };
    const event = parseStreamEvent('1-0', streamFields(row));
    expect(event).toEqual({
      streamId: '1-0',
      id: row.id,
      tenantId: row.tenant_id,
      locationId: null,
      type: 'location.created',
      aggregateKind: 'location',
      aggregateId: row.aggregate_id,
      aggregateVersion: 3,
      occurredAt: '2026-10-18T03:00:00.000Z',
      payload: { code: 'x' },
      headers: { correlation_id: 'c' },
    });
  });
});
