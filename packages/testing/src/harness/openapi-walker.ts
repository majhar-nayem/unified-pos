/** Reads the API's OpenAPI 3.1 document (with the kernel's x-* extensions) into harness operations. */

export interface HarnessParam {
  readonly name: string;
  readonly fixture: string;
}

export interface HarnessQueryParam {
  readonly name: string;
  readonly required: boolean;
  readonly example?: unknown;
}

export interface HarnessOperation {
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
  readonly operationId: string;
  readonly pathParams: readonly HarnessParam[];
  readonly queryParams: readonly HarnessQueryParam[];
  readonly scope?: unknown;
  readonly permission?: string;
  readonly isPublic: boolean;
  readonly isOperator: boolean;
  readonly idempotent: boolean;
  readonly concurrency?: string;
  readonly bodyExample?: unknown;
  readonly hasBody: boolean;
}

interface OpenApiLike {
  openapi?: string;
  paths?: Record<string, Record<string, Record<string, unknown>>>;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export function listOperations(doc: unknown): HarnessOperation[] {
  const document = doc as OpenApiLike;
  const operations: HarnessOperation[] = [];
  for (const [path, verbs] of Object.entries(document.paths ?? {})) {
    for (const [method, raw] of Object.entries(verbs)) {
      if (!METHODS.has(method)) continue;
      const op = raw as Record<string, unknown>;
      const parameters = (op.parameters as Array<Record<string, unknown>> | undefined) ?? [];
      const body = op.requestBody as
        { content?: Record<string, { example?: unknown }> } | undefined;
      const json = body?.content?.['application/json'];
      operations.push({
        method: method as HarnessOperation['method'],
        path,
        operationId: String(op.operationId ?? `${method} ${path}`),
        pathParams: parameters
          .filter((p) => p.in === 'path')
          .map((p) => ({ name: String(p.name), fixture: String(p['x-fixture'] ?? p.name) })),
        queryParams: parameters
          .filter((p) => p.in === 'query')
          .map((p) => ({
            name: String(p.name),
            required: p.required === true,
            ...('example' in p ? { example: p.example } : {}),
          })),
        ...(op['x-scope'] !== undefined ? { scope: op['x-scope'] } : {}),
        ...(typeof op['x-permission'] === 'string' ? { permission: op['x-permission'] } : {}),
        isPublic: op['x-public'] === true,
        isOperator: op['x-operator'] === true,
        idempotent: op['x-idempotent'] === true,
        ...(typeof op['x-concurrency'] === 'string' ? { concurrency: op['x-concurrency'] } : {}),
        ...(json && 'example' in json ? { bodyExample: json.example } : {}),
        hasBody: body !== undefined,
      });
    }
  }
  return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
}
