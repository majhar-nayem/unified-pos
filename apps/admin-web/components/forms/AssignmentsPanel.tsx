'use client';

import {
  CreateRoleAssignmentSchema,
  type RoleAssignmentDto,
  type RoleDto,
  type ScopeKind,
} from '@pos/contracts';
import { mergeLimits } from '@pos/auth';
import { useMemo, useState } from 'react';

import { LimitsEditor } from '@/components/limits/LimitsEditor';
import { ScopePicker, type ScopeValue } from '@/components/scope/ScopePicker';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FormError, SelectInput, TextInput } from '@/components/ui/Field';
import { Alert, Spinner } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import {
  keys,
  useApiMutation,
  useAssignments,
  useLocations,
  useOrgUnits,
  useRegisters,
  useRoles,
} from '@/lib/api/resources';
import { usePermissions, useSession } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import { useZodForm } from '@/lib/zod-form';

function limitText(limits: Record<string, unknown>): string {
  const entries = Object.entries(limits);
  if (entries.length === 0) return 'none';
  return entries.map(([k, v]) => `${k} ≤ ${Array.isArray(v) ? v.join('|') : String(v)}`).join(', ');
}

export function AssignmentsPanel({ userId }: { userId: string }) {
  const perms = usePermissions();
  const canView = perms.has('access.assignment.view');
  const canGrant = perms.has('access.assignment.grant');
  const canRevoke = perms.has('access.assignment.revoke');
  const assignments = useAssignments(userId, canView);
  const roles = useRoles(perms.has('access.role.view'));
  const orgUnits = useOrgUnits();
  const locations = useLocations();
  const registers = useRegisters();
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<RoleAssignmentDto | null>(null);

  const scopeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of orgUnits.data ?? []) map.set(u.id, u.name);
    for (const l of locations.data ?? []) map.set(l.id, l.name);
    for (const r of registers.data ?? []) map.set(r.id, r.name);
    return map;
  }, [orgUnits.data, locations.data, registers.data]);

  const revoke = useApiMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<void>(`/role-assignments/${id}`, { method: 'DELETE', body: reason ? { reason } : {} }),
    invalidate: [keys.assignments(userId)],
    success: 'Role assignment revoked',
  });

  if (!canView) return <Alert tone="info">You cannot view role assignments.</Alert>;
  const rows = assignments.data ?? [];
  return (
    <div className="stack">
      {assignments.isLoading ? <Spinner label="Loading assignments" /> : null}
      {assignments.error ? <Alert tone="danger">{describeError(assignments.error)}</Alert> : null}
      {assignments.data && rows.length === 0 ? (
        <p className="muted">
          This user holds no roles. Without an assignment they cannot see or do anything.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <table className="table" aria-label="Role assignments">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Scope</th>
              <th scope="col">Limits</th>
              <th scope="col">Valid</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{titleCase(a.roleKey)}</td>
                <td>
                  {titleCase(a.scope.kind)}
                  {a.scope.kind !== 'tenant'
                    ? `: ${scopeName.get(a.scope.id) ?? a.scope.id.slice(0, 8)}`
                    : ''}
                </td>
                <td style={{ whiteSpace: 'normal' }}>{limitText(a.limits)}</td>
                <td>{a.validTo ? `until ${formatDateTime(a.validTo)}` : 'open ended'}</td>
                <td>
                  {canRevoke ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setRevoking(a)}
                      aria-label={`Revoke ${a.roleKey}`}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canGrant ? (
        granting ? (
          <GrantForm
            userId={userId}
            roles={roles.data ?? []}
            onDone={() => setGranting(false)}
            onCancel={() => setGranting(false)}
          />
        ) : (
          <div>
            <Button variant="primary" onClick={() => setGranting(true)}>
              Assign a role
            </Button>
          </div>
        )
      ) : null}
      <ConfirmDialog
        open={Boolean(revoking)}
        title="Revoke this role?"
        message={
          revoking
            ? `${titleCase(revoking.roleKey)} will stop applying to this user immediately.`
            : ''
        }
        confirmLabel="Revoke role"
        reason={{ label: 'Reason (kept in the audit log)' }}
        busy={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={async (reason) => {
          if (!revoking) return;
          await revoke.mutateAsync({ id: revoking.id, reason });
          setRevoking(null);
        }}
      />
    </div>
  );
}

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? local : d.toISOString();
}

function GrantForm({
  userId,
  roles,
  onDone,
  onCancel,
}: {
  userId: string;
  roles: readonly RoleDto[];
  onDone(): void;
  onCancel(): void;
}) {
  const session = useSession();
  const form = useZodForm(
    CreateRoleAssignmentSchema,
    {
      roleId: '',
      scope: { kind: 'location', id: '' } as ScopeValue,
      validTo: '',
      reason: '',
      limits: {} as Record<string, string | number | boolean | string[]>,
    } as Record<string, unknown>,
    {
      toInput: (v) => {
        const scope = v.scope as ScopeValue;
        const limits = v.limits as Record<string, never>;
        const validTo = toIso(String(v.validTo ?? ''));
        return {
          userId,
          roleId: v.roleId,
          scope: {
            kind: scope.kind,
            id: scope.kind === 'tenant' ? (session.principal?.tenantId ?? scope.id) : scope.id,
          },
          ...(validTo ? { validTo } : {}),
          ...(String(v.reason).trim() ? { reason: String(v.reason).trim() } : {}),
          ...(Object.keys(limits).length ? { limits } : {}),
        };
      },
    },
  );
  const grant = useApiMutation({
    mutationFn: (body: unknown) =>
      api<RoleAssignmentDto>('/role-assignments', { method: 'POST', body, idempotent: true }),
    invalidate: [keys.assignments(userId)],
    success: 'Role assigned',
    silentError: true,
  });
  const role = roles.find((r) => r.id === form.values.roleId);
  const scope = form.values.scope as ScopeValue;
  const limits = form.values.limits as Record<string, never>;
  const effective = mergeLimits(role?.limits, limits);

  return (
    <form
      noValidate
      aria-label="Assign a role"
      className="card"
      onSubmit={form.handleSubmit(async (body) => {
        await grant.mutateAsync(body);
        onDone();
      })}
    >
      <h3 className="card-title">Assign a role</h3>
      <SelectInput
        label="Role"
        placeholder="Choose a role…"
        options={roles.map((r) => ({ value: r.id, label: r.name }))}
        value={String(form.values.roleId)}
        onChange={(e) => form.setValue('roleId', e.target.value)}
        onBlur={() => form.blur('roleId')}
        error={form.errors.roleId}
        hint={role?.description ?? undefined}
        required
      />
      <ScopePicker
        value={scope}
        onChange={(next) => form.setValue('scope', next)}
        error={form.errors['scope.id']}
      />
      <LimitsEditor
        value={limits}
        onChange={(next) => form.setValue('limits', next as never)}
        inherited={role?.limits ?? {}}
        error={form.errors.limits}
      />
      {role && Object.keys(effective).length > 0 ? (
        <p className="field-hint" data-testid="effective-limits">
          Effective limits for this grant: {limitText(effective)}
        </p>
      ) : null}
      <div className="form-grid">
        <TextInput
          label="Expires (optional)"
          type="datetime-local"
          value={String(form.values.validTo)}
          onChange={(e) => form.setValue('validTo', e.target.value)}
          error={form.errors.validTo}
        />
        <TextInput
          label="Reason"
          value={String(form.values.reason)}
          onChange={(e) => form.setValue('reason', e.target.value)}
          error={form.errors.reason}
          hint="Kept in the audit log"
        />
      </div>
      <FormError message={form.formError} />
      <div className="inline">
        <Button type="submit" variant="primary" loading={form.submitting}>
          Assign role
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export type { ScopeKind };
