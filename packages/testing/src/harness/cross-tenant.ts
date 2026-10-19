import { randomUUID } from 'node:crypto';

import {
  type FixtureRegistry,
  buildPath,
  collectPlaceholders,
  substituteFixtures,
} from './fixture-registry.js';
import { type HarnessOperation, listOperations } from './openapi-walker.js';

export interface HttpRequest {
  readonly method: HarnessOperation['method'];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type HttpInvoke = (request: HttpRequest) => Promise<HttpResponse>;

export type HarnessScenario = 'foreign_tenant' | 'out_of_scope';

export interface HarnessCase {
  readonly operationId: string;
  readonly method: string;
  readonly url: string;
  readonly scenario: HarnessScenario;
  readonly expected: string;
  readonly status: number;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface HarnessReport {
  readonly cases: readonly HarnessCase[];
  readonly failures: readonly HarnessCase[];
  readonly skipped: readonly string[];
}

export interface CrossTenantHarnessOptions {
  readonly doc: unknown;
  readonly invoke: HttpInvoke;
  /** Tenant A's fixtures: used with the foreign (tenant B) token, which must see none of them. */
  readonly foreignFixtures: FixtureRegistry;
  /** Fixtures a location-scoped tenant-A principal must NOT reach (sibling location/register). */
  readonly outOfScopeFixtures: FixtureRegistry;
  readonly tokens: { readonly foreignTenant: string; readonly locationScoped: string };
  /** operationIds to skip, each with a reason. */
  readonly skip?: Readonly<Record<string, string>>;
}

/**
 * docs/03-implementation-plan.md §9: every endpoint invoked with (a) a foreign-tenant token and
 * (b) a same-tenant principal whose scope excludes the target. Both must answer 404 whenever the
 * request names a resource; list/create routes without ids must never leak ids or return 5xx.
 */
export async function runCrossTenantHarness(
  options: CrossTenantHarnessOptions,
): Promise<HarnessReport> {
  const operations = listOperations(options.doc);
  const cases: HarnessCase[] = [];
  const skipped: string[] = [];

  for (const op of operations) {
    if (op.isPublic || op.isOperator) {
      skipped.push(`${op.operationId} (${op.isPublic ? 'public' : 'operator-only'})`);
      continue;
    }
    if (options.skip?.[op.operationId]) {
      skipped.push(`${op.operationId} (${options.skip[op.operationId]})`);
      continue;
    }
    // (a) tenant A's ids must never appear in tenant B's responses
    cases.push(
      await runCase(
        op,
        'foreign_tenant',
        options.foreignFixtures,
        Object.values(options.foreignFixtures),
        [],
        options.tokens.foreignTenant,
        options.invoke,
      ),
    );
    // (b) only the ids that differ from tenant A's in-scope fixtures are forbidden (the sibling location/register)
    const changed = Object.entries(options.outOfScopeFixtures).filter(
      ([name, id]) => options.foreignFixtures[name] !== id,
    );
    const forbidden = changed.map(([, id]) => id);
    const hierarchyNames = changed.map(([name]) => name);
    cases.push(
      await runCase(
        op,
        'out_of_scope',
        options.outOfScopeFixtures,
        forbidden,
        hierarchyNames,
        options.tokens.locationScoped,
        options.invoke,
      ),
    );
  }
  return { cases, failures: cases.filter((c) => !c.ok), skipped };
}

async function runCase(
  op: HarnessOperation,
  scenario: HarnessScenario,
  fixtures: FixtureRegistry,
  forbiddenIds: readonly string[],
  hierarchyFixtureNames: readonly string[],
  token: string,
  invoke: HttpInvoke,
): Promise<HarnessCase> {
  const where = `${op.operationId} (${scenario})`;
  const path = buildPath(op, fixtures);
  const query = op.queryParams
    .filter((q) => q.example !== undefined)
    .map(
      (q) =>
        `${encodeURIComponent(q.name)}=${encodeURIComponent(String(substituteFixtures(q.example, fixtures, `${where} query ${q.name}`)))}`,
    )
    .join('&');
  const url = query ? `${path}?${query}` : path;
  const body =
    op.bodyExample === undefined
      ? undefined
      : substituteFixtures(op.bodyExample, fixtures, `${where} body`);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (op.idempotent) headers['idempotency-key'] = randomUUID();
  if (op.concurrency === 'if-match') headers['if-match'] = '"1"';

  // Tenant-level resources (x-scope tenant: users, roles, …) are reachable by every principal of
  // the tenant, so for the out-of-scope scenario only hierarchy-scoped references count as
  // "naming a resource"; for the foreign-tenant scenario every id does.
  const scopeKind = (op.scope as { kind?: string } | undefined)?.kind;
  const tenantLevel = scopeKind === 'tenant';
  const placeholders = [
    ...collectPlaceholders(op.bodyExample),
    ...op.queryParams.flatMap((q) => [...collectPlaceholders(q.example)]),
  ];
  const hasFixtureRefs =
    scenario === 'foreign_tenant'
      ? placeholders.length > 0
      : placeholders.some((name) => hierarchyFixtureNames.includes(name));
  const hierarchyScoped = op.scope !== undefined && !tenantLevel;
  const namesResource =
    scenario === 'foreign_tenant'
      ? op.pathParams.length > 0 || op.scope !== undefined || hasFixtureRefs
      : hierarchyScoped || hasFixtureRefs;

  const response = await invoke({
    method: op.method,
    url,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const base = {
    operationId: op.operationId,
    method: op.method.toUpperCase(),
    url,
    scenario,
    status: response.status,
  };

  if (
    namesResource &&
    !(scenario === 'foreign_tenant' && tenantLevel && op.pathParams.length === 0 && !hasFixtureRefs)
  ) {
    // A route restricted to other token kinds (device/preauth) rejects before touching data: also a denial.
    const code = (response.body as { error?: { code?: string } } | null)?.error?.code;
    const kindRejected = response.status === 401 && code === 'TOKEN_KIND_NOT_ALLOWED';
    const ok = response.status === 404 || kindRejected;
    return {
      ...base,
      expected: '404 (or 401 TOKEN_KIND_NOT_ALLOWED)',
      ok,
      ...(ok ? {} : { detail: `got ${response.status} ${truncate(response.body)}` }),
    };
  }
  const text = JSON.stringify(response.body ?? null);
  const leaked = forbiddenIds.filter((id) => text.includes(id));
  const ok = response.status < 500 && leaked.length === 0;
  return {
    ...base,
    expected: 'no 5xx, no forbidden ids in body',
    ok,
    ...(ok
      ? {}
      : {
          detail:
            response.status >= 500
              ? `server error ${truncate(response.body)}`
              : `leaked ${leaked.join(', ')}`,
        }),
  };
}

function truncate(body: unknown): string {
  const text = JSON.stringify(body ?? null);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function formatHarnessReport(report: HarnessReport): string {
  const lines = report.failures.map(
    (f) =>
      `  ✗ ${f.operationId} [${f.scenario}] ${f.method} ${f.url}: expected ${f.expected}, ${f.detail ?? `got ${f.status}`}`,
  );
  return `${report.cases.length} cases, ${report.failures.length} failures, ${report.skipped.length} skipped\n${lines.join('\n')}`;
}
