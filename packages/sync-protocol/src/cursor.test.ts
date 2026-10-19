import { describe, expect, it } from 'vitest';

import { CursorRegressionError, FeedCursors, MemoryCursorStore, feedQuery } from './cursor.js';

describe('FeedCursors', () => {
  it('starts at 0 and advances with applied pages', async () => {
    const cursors = new FeedCursors(new MemoryCursorStore());
    expect(await cursors.next('catalog')).toBe(0);
    await cursors.advance('catalog', {
      cursor: 10,
      records: [
        {
          seq: 9,
          stream: 'catalog',
          entity: 'item',
          entityId: 'a',
          op: 'upsert',
          version: 1,
          payload: {},
        },
        {
          seq: 10,
          stream: 'catalog',
          entity: 'item',
          entityId: 'b',
          op: 'delete',
          version: 2,
          payload: {},
        },
      ],
    });
    expect(await cursors.next('catalog')).toBe(10);
    expect(await cursors.next('config')).toBe(0);
  });

  it('never moves backwards and rejects pages that claim records beyond their cursor', async () => {
    const cursors = new FeedCursors(new MemoryCursorStore());
    await cursors.advance('orders', { cursor: 5, records: [] });
    await expect(cursors.advance('orders', { cursor: 4, records: [] })).rejects.toBeInstanceOf(
      CursorRegressionError,
    );
    await cursors.advance('orders', { cursor: 5, records: [] }); // idempotent re-apply
    await expect(
      cursors.advance('orders', {
        cursor: 6,
        records: [
          {
            seq: 7,
            stream: 'orders',
            entity: 'order',
            entityId: 'x',
            op: 'upsert',
            version: 1,
            payload: {},
          },
        ],
      }),
    ).rejects.toThrow(/beyond its cursor/);
    await cursors.reset('orders', 100);
    expect(await cursors.next('orders')).toBe(100);
  });

  it('formats the feed query', () => {
    expect(feedQuery(['catalog', 'config'], 42)).toBe('streams=catalog%2Cconfig&cursor=42');
  });
});
