import type { HarnessOperation } from './openapi-walker.js';

/** Named ids the OpenAPI document refers to through `x-fixture` and `$fixture:<name>` placeholders. */
export type FixtureRegistry = Readonly<Record<string, string>>;

const PLACEHOLDER = /^\$fixture:([A-Za-z0-9_]+)$/;

export class MissingFixtureError extends Error {
  constructor(
    public readonly fixture: string,
    public readonly where: string,
  ) {
    super(`Fixture "${fixture}" referenced by ${where} is not in the registry`);
    this.name = 'MissingFixtureError';
  }
}

/** Replace `$fixture:x` strings anywhere in a JSON value. */
export function substituteFixtures(
  value: unknown,
  registry: FixtureRegistry,
  where: string,
): unknown {
  if (typeof value === 'string') {
    const match = PLACEHOLDER.exec(value);
    if (!match) return value;
    const id = registry[match[1]!];
    if (id === undefined) throw new MissingFixtureError(match[1]!, where);
    return id;
  }
  if (Array.isArray(value))
    return value.map((item, i) => substituteFixtures(item, registry, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substituteFixtures(v, registry, `${where}.${k}`),
      ]),
    );
  }
  return value;
}

export function collectPlaceholders(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    const match = PLACEHOLDER.exec(value);
    if (match) out.add(match[1]!);
  } else if (Array.isArray(value)) value.forEach((v) => collectPlaceholders(v, out));
  else if (value && typeof value === 'object')
    Object.values(value as Record<string, unknown>).forEach((v) => collectPlaceholders(v, out));
  return out;
}

/** Build the request path for an operation from the registry. */
export function buildPath(operation: HarnessOperation, registry: FixtureRegistry): string {
  let path = operation.path;
  for (const param of operation.pathParams) {
    const id = registry[param.fixture];
    if (id === undefined)
      throw new MissingFixtureError(
        param.fixture,
        `${operation.operationId} path param ${param.name}`,
      );
    path = path.replace(`{${param.name}}`, encodeURIComponent(id));
  }
  return path;
}

export interface CompletenessProblem {
  readonly operationId: string;
  readonly problem: string;
}

/**
 * Contract completeness: every fixture name exists, every body has an example, and every
 * non-public non-operator operation with path parameters declares x-scope (so the ScopeGuard runs).
 */
export function checkContractCompleteness(
  operations: readonly HarnessOperation[],
  registry: FixtureRegistry,
): CompletenessProblem[] {
  const problems: CompletenessProblem[] = [];
  for (const op of operations) {
    for (const param of op.pathParams) {
      if (!(param.fixture in registry))
        problems.push({
          operationId: op.operationId,
          problem: `x-fixture "${param.fixture}" is not a known fixture`,
        });
    }
    for (const name of collectPlaceholders(op.bodyExample)) {
      if (!(name in registry))
        problems.push({
          operationId: op.operationId,
          problem: `body example references unknown fixture "${name}"`,
        });
    }
    for (const q of op.queryParams) {
      for (const name of collectPlaceholders(q.example)) {
        if (!(name in registry))
          problems.push({
            operationId: op.operationId,
            problem: `query example references unknown fixture "${name}"`,
          });
      }
    }
    if (op.hasBody && op.bodyExample === undefined)
      problems.push({ operationId: op.operationId, problem: 'request body has no example' });
    if (!op.isPublic && !op.isOperator && op.pathParams.length > 0 && op.scope === undefined) {
      problems.push({ operationId: op.operationId, problem: 'has path parameters but no x-scope' });
    }
  }
  return problems;
}
