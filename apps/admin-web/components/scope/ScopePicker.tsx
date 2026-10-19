'use client';

import { ASSIGNMENT_SCOPE_KINDS, type ScopeKind } from '@pos/contracts';
import { useMemo } from 'react';

import { SelectInput } from '@/components/ui/Field';
import { useLocations, useOrgUnits, useRegisters } from '@/lib/api/resources';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';

export interface ScopeValue {
  kind: ScopeKind;
  id: string;
}

interface ScopePickerProps {
  value: ScopeValue;
  onChange(next: ScopeValue): void;
  kinds?: readonly ScopeKind[];
  error?: string | undefined;
  disabled?: boolean;
  legend?: string;
}

/**
 * Picks a scope in the tenant hierarchy: kind first, then the concrete node. Choosing "Whole
 * tenant" fills in the tenant id, so callers always get a complete `{ kind, id }`.
 */
export function ScopePicker({
  value,
  onChange,
  kinds = ASSIGNMENT_SCOPE_KINDS,
  error,
  disabled,
  legend = 'Scope',
}: ScopePickerProps) {
  const session = useSession();
  const tenantId = session.principal?.tenantId ?? '';
  const orgUnits = useOrgUnits();
  const locations = useLocations();
  const registers = useRegisters();

  const entities = useMemo(() => {
    switch (value.kind) {
      case 'org_unit':
        return (orgUnits.data ?? []).map((u) => ({
          value: u.id,
          label: `${u.name} (${titleCase(u.kind)})`,
        }));
      case 'location':
        return (locations.data ?? []).map((l) => ({ value: l.id, label: l.name }));
      case 'register': {
        const names = new Map((locations.data ?? []).map((l) => [l.id, l.name]));
        return (registers.data ?? []).map((r) => ({
          value: r.id,
          label: `${r.name} · ${names.get(r.locationId) ?? 'location'}`,
        }));
      }
      default:
        return [];
    }
  }, [value.kind, orgUnits.data, locations.data, registers.data]);

  const kindLabel = (k: string) => (k === 'tenant' ? 'Whole tenant' : titleCase(k));
  return (
    <fieldset className="fieldset" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="scope-picker">
        <SelectInput
          label="Applies to"
          options={kinds.map((k) => ({ value: k, label: kindLabel(k) }))}
          value={value.kind}
          onChange={(e) => {
            const kind = e.target.value as ScopeKind;
            onChange({ kind, id: kind === 'tenant' ? tenantId : '' });
          }}
        />
        {value.kind === 'tenant' ? (
          <div className="field">
            <span className="field-label">Coverage</span>
            <span className="muted">Every org unit, location and register in this tenant.</span>
          </div>
        ) : (
          <SelectInput
            label={titleCase(value.kind)}
            placeholder="Choose…"
            options={entities}
            value={value.id}
            onChange={(e) => onChange({ kind: value.kind, id: e.target.value })}
            error={error}
            hint={
              value.kind === 'org_unit'
                ? 'Covers this unit and everything beneath it.'
                : value.kind === 'location'
                  ? 'Covers this location, its departments and registers.'
                  : undefined
            }
          />
        )}
      </div>
    </fieldset>
  );
}
