import { describe, expect, it } from 'vitest';

import { MoneySchema, SyncBatchSchema } from './index.js';

describe('contracts', () => {
  it('accepts bigint-as-string money and rejects numbers', () => {
    expect(MoneySchema.safeParse({ amountMinor: '-450', currency: 'AUD' }).success).toBe(true);
    expect(MoneySchema.safeParse({ amountMinor: 450, currency: 'AUD' }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: '4.50', currency: 'AUD' }).success).toBe(false);
  });

  it('validates a sync batch', () => {
    const batch = {
      deviceId: '0190f8a0-0000-7000-8000-000000000001',
      clientBatchId: '0190f8a0-0000-7000-8000-000000000002',
      commands: [
        {
          clientCommandId: '0190f8a0-0000-7000-8000-000000000003',
          type: 'order.place',
          payload: { orderId: 'x' },
          hlc: '1700000000000:0:reg-1',
          clientTime: '2026-10-18T03:00:00.000Z',
        },
      ],
    };
    expect(SyncBatchSchema.safeParse(batch).success).toBe(true);
  });
});
