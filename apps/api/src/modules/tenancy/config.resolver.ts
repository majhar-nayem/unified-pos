import type { Scope } from '@pos/auth';
import { CONFIG_KEYS, type ConfigResolved } from '@pos/contracts';

export interface ConfigCandidate {
  readonly scopeKind: Scope['kind'];
  readonly scopeId: string;
  readonly value: unknown;
  readonly version: number;
}

/**
 * Nearest scope on the path wins: register → department → location → org-unit chain → tenant →
 * platform default from the CONFIG_KEYS registry (docs/02-database-design.md §3.1). Pure.
 */
export function resolveNearest(
  key: string,
  path: readonly Scope[],
  candidates: readonly ConfigCandidate[],
): ConfigResolved {
  for (const scope of path) {
    const hit = candidates.find((c) => c.scopeKind === scope.kind && c.scopeId === scope.id);
    if (hit)
      return {
        key,
        value: hit.value,
        resolvedScope: { kind: scope.kind, id: scope.id },
        version: hit.version,
      };
  }
  const definition = (CONFIG_KEYS as Record<string, { default: unknown } | undefined>)[key];
  return { key, value: definition?.default ?? null, resolvedScope: 'default', version: null };
}

export function isKnownConfigKey(key: string): key is keyof typeof CONFIG_KEYS {
  return Object.hasOwn(CONFIG_KEYS, key);
}
