'use client';

import { type QueryKey, keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CursorPaging } from './types';

export interface CursorPage<T, C> {
  items: readonly T[];
  nextCursor: C | null;
}

/**
 * Server-side cursor pagination over a react-query fetcher. Keeps a stack of cursors so Previous
 * works without the server supporting backwards paging; any change to `resetKey` (filters, page
 * size) returns to the first page.
 */
export function useCursorPages<T, C extends string | number>(options: {
  queryKey: QueryKey;
  resetKey: string;
  fetchPage(args: {
    cursor: C | undefined;
    limit: number;
    signal: AbortSignal;
  }): Promise<CursorPage<T, C>>;
  initialPageSize?: number;
  enabled?: boolean;
}) {
  const [pageSize, setPageSize] = useState(options.initialPageSize ?? 25);
  const [cursors, setCursors] = useState<(C | undefined)[]>([undefined]);
  const pageIndex = cursors.length - 1;
  const cursor = cursors[pageIndex];

  useEffect(() => {
    setCursors([undefined]);
  }, [options.resetKey, pageSize]);

  const query = useQuery({
    queryKey: [...options.queryKey, options.resetKey, pageSize, cursor ?? 'first'],
    queryFn: ({ signal }) => options.fetchPage({ cursor, limit: pageSize, signal }),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });

  const next = query.data?.nextCursor ?? null;
  const onNext = useCallback(() => {
    if (next !== null) setCursors((prev) => [...prev, next]);
  }, [next]);
  const onPrev = useCallback(
    () => setCursors((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)),
    [],
  );
  const onReset = useCallback(() => setCursors([undefined]), []);

  const paging = useMemo<CursorPaging>(
    () => ({
      pageIndex,
      hasNext: next !== null,
      fetching: query.isFetching,
      onNext,
      onPrev,
      onReset,
      pageSize,
      onPageSize: setPageSize,
    }),
    [pageIndex, next, query.isFetching, onNext, onPrev, onReset, pageSize],
  );

  return { query, rows: (query.data?.items ?? []) as readonly T[], paging };
}
