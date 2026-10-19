/**
 * Permission model (docs/01-system-architecture.md §6.3): permission keys granted through role
 * assignments scoped to the tenant hierarchy, with optional ABAC limits (e.g. max discount percent).
 * The server is the authority; clients use the same evaluator only to gate UI.
 */

export * from './catalog.js';
export * from './claims.js';

export type PermissionKey = `${string}.${string}`;

export type ScopeKind = 'tenant' | 'org_unit' | 'location' | 'department' | 'register';

export interface Scope {
  readonly kind: ScopeKind;
  readonly id: string;
}

/**
 * A limit value attached to a permission (ABAC). Semantics are chosen by the value's type:
 * - number: the attribute must be `<=` the limit
 * - boolean `false`: a truthy attribute is forbidden (`true` imposes nothing)
 * - readonly string[]: a string attribute must be a member; an array attribute must be a subset
 * - string: the attribute must be equal
 */
export type LimitValue = number | boolean | string | readonly string[];

export type Limits = Readonly<Record<string, LimitValue>>;

export interface Assignment {
  readonly assignmentId: string;
  readonly role: string;
  readonly permissions: readonly PermissionKey[];
  readonly scope: Scope;
  /** Ids of all scopes nested under `scope` (closure), so an org-unit role covers every location. */
  readonly coveredScopeIds: readonly string[];
  /** ISO 8601 instant; the assignment is inactive before it. */
  readonly validFrom?: string;
  /** ISO 8601 instant; the assignment is inactive from it on (half-open window). */
  readonly validTo?: string;
  /** Effective limits: role limits already merged with assignment overrides (see mergeLimits). */
  readonly limits?: Limits;
}

export interface Principal {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly kind: 'user' | 'device' | 'api_client';
  readonly sessionId?: string;
  readonly deviceId?: string;
  readonly locationId?: string;
  /** True when the session completed a second factor (required for *.admin and finance.* keys). */
  readonly mfaVerified: boolean;
  /** Bumped whenever the subject's assignments change; tokens carrying an older value are stale. */
  readonly assignmentsVersion: number;
  readonly assignments: readonly Assignment[];
}

export type DecisionReason =
  'granted' | 'no_assignment' | 'out_of_scope' | 'expired' | 'limit_exceeded';

export interface ExceededLimit {
  readonly key: string;
  readonly value: LimitValue;
  readonly attribute: AttributeValue;
  readonly assignmentId: string;
}

export interface Decision {
  readonly allowed: boolean;
  readonly reason: DecisionReason;
  /** The assignment that granted the permission. */
  readonly assignmentId?: string;
  /** Effective limits of the granting assignment, for the caller to surface in UI. */
  readonly limits?: Limits;
  /** The first exceeded limit, when `reason === 'limit_exceeded'`. */
  readonly limit?: ExceededLimit;
}

export type AttributeValue = number | boolean | string | readonly string[];

export interface CanOptions {
  /** Attribute values checked against the assignment's limits, e.g. { 'orders.discount.max_percent': 15 }. */
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
  /** Evaluation instant for validity windows (defaults to the wall clock). */
  readonly now?: Date;
}

export function can(
  principal: Principal,
  permission: PermissionKey,
  scope: Scope,
  options: CanOptions = {},
): Decision {
  const now = options.now ?? new Date();
  const attributes = options.attributes ?? {};
  let sawPermission = false;
  let sawInScope = false;
  let exceeded: ExceededLimit | undefined;

  for (const assignment of principal.assignments) {
    if (!assignment.permissions.includes(permission)) continue;
    sawPermission = true;
    if (!covers(assignment, scope)) continue;
    sawInScope = true;
    if (!isActive(assignment, now)) continue;
    const limits = assignment.limits ?? {};
    const violation = firstExceededLimit(limits, attributes);
    if (violation === undefined) {
      return { allowed: true, reason: 'granted', assignmentId: assignment.assignmentId, limits };
    }
    exceeded ??= { ...violation, assignmentId: assignment.assignmentId };
  }

  if (exceeded) return { allowed: false, reason: 'limit_exceeded', limit: exceeded };
  if (sawInScope) return { allowed: false, reason: 'expired' };
  return { allowed: false, reason: sawPermission ? 'out_of_scope' : 'no_assignment' };
}

/** True if the set of permission keys requires a verified second factor (docs §6.3). */
export function requiresMfa(permissions: readonly PermissionKey[]): boolean {
  return permissions.some((key) => /\.admin$/.test(key) || /^finance\./.test(key));
}

/** Effective limits: assignment-level limits override role-level limits per key. */
export function mergeLimits(
  roleLimits: Limits | undefined,
  assignmentLimits: Limits | undefined,
): Limits {
  return { ...(roleLimits ?? {}), ...(assignmentLimits ?? {}) };
}

function covers(assignment: Assignment, scope: Scope): boolean {
  if (assignment.scope.kind === 'tenant') return true;
  return assignment.scope.id === scope.id || assignment.coveredScopeIds.includes(scope.id);
}

function isActive(assignment: Assignment, now: Date): boolean {
  const t = now.getTime();
  if (assignment.validFrom !== undefined && t < Date.parse(assignment.validFrom)) return false;
  if (assignment.validTo !== undefined && t >= Date.parse(assignment.validTo)) return false;
  return true;
}

function firstExceededLimit(
  limits: Limits,
  attributes: Readonly<Record<string, AttributeValue>>,
): Omit<ExceededLimit, 'assignmentId'> | undefined {
  for (const [key, value] of Object.entries(limits)) {
    const attribute = attributes[key];
    if (attribute === undefined) continue;
    if (!satisfiesLimit(value, attribute)) return { key, value, attribute };
  }
  return undefined;
}

function satisfiesLimit(limit: LimitValue, attribute: AttributeValue): boolean {
  if (typeof limit === 'number') {
    return typeof attribute === 'number' && attribute <= limit;
  }
  if (typeof limit === 'boolean') {
    return limit || !attribute || (Array.isArray(attribute) && attribute.length === 0);
  }
  if (typeof limit === 'string') {
    return attribute === limit;
  }
  if (typeof attribute === 'string') return limit.includes(attribute);
  if (Array.isArray(attribute)) return attribute.every((item) => limit.includes(item));
  return false;
}
