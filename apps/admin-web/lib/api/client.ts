/**
 * Browser-side API client. Every call goes through the same-origin proxy at /api/v1/*, which holds
 * the tokens in httpOnly cookies, so this module never sees a credential.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; correlationId?: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Resource version for optimistic concurrency (sent as If-Match). */
  ifMatch?: number;
  /** POST routes marked idempotent on the server require an Idempotency-Key. */
  idempotent?: boolean;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  etag: number | null;
  replayed: boolean;
}

export const UNAUTHENTICATED_EVENT = 'pos:unauthenticated';

export function buildQuery(query: ApiRequest['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export async function apiRaw<T>(path: string, init: ApiRequest = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.ifMatch !== undefined) headers['if-match'] = `"${init.ifMatch}"`;
  if (init.idempotent) headers['idempotency-key'] = newIdempotencyKey();
  const res = await fetch(`/api/v1${path}${buildQuery(init.query)}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) {
    const body = parsed as Partial<ApiErrorBody> | undefined;
    const error = body?.error;
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    }
    throw new ApiError(
      res.status,
      error?.code ?? `HTTP_${res.status}`,
      error?.message ?? res.statusText ?? 'Request failed',
      error?.details,
      error?.correlationId,
    );
  }
  const etagHeader = res.headers.get('etag');
  const etagMatch = etagHeader ? /^(?:W\/)?"?(\d+)"?$/.exec(etagHeader) : null;
  return {
    data: parsed as T,
    status: res.status,
    etag: etagMatch?.[1] ? Number(etagMatch[1]) : null,
    replayed: res.headers.get('idempotency-replayed') === 'true',
  };
}

export async function api<T>(path: string, init: ApiRequest = {}): Promise<T> {
  return (await apiRaw<T>(path, init)).data;
}

/** Session endpoints live outside /api/v1 (they set cookies). */
export async function sessionCall<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/session${path}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const error = (parsed as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? `HTTP_${res.status}`,
      error?.message ?? 'Request failed',
      error?.details,
    );
  }
  return parsed as T;
}

/**
 * Flattens the API's 422 `details` (`{ body: treeifyError, query: ..., params: ... }` or a flat
 * `{ field: message }` map) into `path → message` for inline display.
 */
export function flattenValidationDetails(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!details || typeof details !== 'object') return out;
  const walk = (node: unknown, prefix: string): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      errors?: unknown;
      properties?: Record<string, unknown>;
      items?: unknown[];
    };
    if (Array.isArray(n.errors) && n.errors.length > 0 && prefix) {
      out[prefix] ??= String(n.errors[0]);
    }
    if (n.properties) {
      for (const [key, child] of Object.entries(n.properties)) {
        walk(child, prefix ? `${prefix}.${key}` : key);
      }
    }
    if (Array.isArray(n.items)) {
      n.items.forEach((child, index) => walk(child, `${prefix}[${index}]`));
    }
  };
  for (const [part, value] of Object.entries(details as Record<string, unknown>)) {
    if (part === 'body' || part === 'query' || part === 'params') {
      if (value && typeof value === 'object' && 'errors' in (value as object)) {
        const tree = value as { errors?: unknown };
        if (Array.isArray(tree.errors) && tree.errors.length > 0) {
          out._form ??= String(tree.errors[0]);
        }
        walk(value, '');
      }
    } else if (typeof value === 'string') {
      out[part] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      out[part] = value[0];
    }
  }
  return out;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 412) return 'Someone else changed this record. Reload and try again.';
    if (error.status === 403) return 'You do not have permission for this action.';
    if (error.status === 404) return 'Not found, or outside your scope.';
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
