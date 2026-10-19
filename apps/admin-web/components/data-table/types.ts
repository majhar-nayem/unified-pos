export interface FilterDef {
  id: string;
  label: string;
  type: 'text' | 'select' | 'date';
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
}

export type FilterValues = Record<string, string>;

/**
 * Server-side cursor paging contract. `cursor` is opaque to the table: the audit log uses a
 * numeric sequence, other resources a UUIDv7 id. The table only ever asks for "the next page".
 */
export interface CursorPaging {
  pageIndex: number;
  hasNext: boolean;
  fetching: boolean;
  onNext(): void;
  onPrev(): void;
  onReset(): void;
  pageSize: number;
  onPageSize(size: number): void;
}
