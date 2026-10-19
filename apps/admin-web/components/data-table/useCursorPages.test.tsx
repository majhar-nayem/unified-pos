import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useCursorPages } from './useCursorPages';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** 7 items, cursor = last seq on the previous page. */
const ITEMS = Array.from({ length: 7 }, (_, i) => ({ seq: i + 1 }));
const fetchPage = vi.fn(
  async ({ cursor, limit }: { cursor: number | undefined; limit: number }) => {
    const rest = ITEMS.filter((i) => i.seq > (cursor ?? 0));
    const items = rest.slice(0, limit);
    return { items, nextCursor: rest.length > limit ? items[items.length - 1]!.seq : null };
  },
);

describe('useCursorPages', () => {
  it('walks forward with cursors, back with the stack, and resets when the key changes', async () => {
    const { result, rerender } = renderHook(
      ({ resetKey }) =>
        useCursorPages<{ seq: number }, number>({
          queryKey: ['t'],
          resetKey,
          fetchPage,
          initialPageSize: 3,
        }),
      { wrapper, initialProps: { resetKey: 'a' } },
    );
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([1, 2, 3]));
    expect(result.current.paging).toMatchObject({ pageIndex: 0, hasNext: true });

    act(() => result.current.paging.onNext());
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([4, 5, 6]));
    act(() => result.current.paging.onNext());
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([7]));
    expect(result.current.paging.hasNext).toBe(false);
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 6, limit: 3 }));

    act(() => result.current.paging.onPrev());
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([4, 5, 6]));

    rerender({ resetKey: 'b' });
    await waitFor(() => expect(result.current.paging.pageIndex).toBe(0));
    await waitFor(() => expect(result.current.rows.map((r) => r.seq)).toEqual([1, 2, 3]));
  });

  it('a new page size returns to the first page', async () => {
    const { result } = renderHook(
      () =>
        useCursorPages<{ seq: number }, number>({
          queryKey: ['size'],
          resetKey: 'x',
          fetchPage,
          initialPageSize: 3,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    act(() => result.current.paging.onNext());
    await waitFor(() => expect(result.current.paging.pageIndex).toBe(1));
    act(() => result.current.paging.onPageSize(5));
    await waitFor(() => expect(result.current.paging.pageIndex).toBe(0));
    await waitFor(() => expect(result.current.rows).toHaveLength(5));
  });
});
