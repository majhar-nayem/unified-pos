'use client';

import {
  CONFIG_KEYS,
  CONFIG_KEY_NAMES,
  type ConfigEntryDto,
  type ConfigKey,
  type ScopeKind,
} from '@pos/contracts';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { DiffView } from '@/components/audit/DiffView';
import { ScopePicker, type ScopeValue } from '@/components/scope/ScopePicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FormError, SelectInput, TextInput } from '@/components/ui/Field';
import { Alert, KeyValue, PageHeader, Spinner } from '@/components/ui/Misc';
import { api, describeError } from '@/lib/api/client';
import {
  keys,
  useApiMutation,
  useConfigEffective,
  useConfigHistory,
  useLocations,
  useOrgUnits,
  useRegisters,
} from '@/lib/api/resources';
import { usePermissions, useSession } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';

const PICKABLE: readonly ScopeKind[] = ['tenant', 'org_unit', 'location', 'register'];
const show = (v: unknown) =>
  typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v ?? null);

interface PathNode {
  kind: ScopeKind;
  id: string;
  label: string;
}

export default function ConfigPage() {
  const perms = usePermissions();
  const session = useSession();
  const tenantId = session.principal?.tenantId ?? '';
  const orgUnits = useOrgUnits();
  const locations = useLocations();
  const registers = useRegisters();
  const [key, setKey] = useState<ConfigKey>(CONFIG_KEY_NAMES[0]!);
  const [scope, setScope] = useState<ScopeValue>({ kind: 'tenant', id: tenantId });
  const def = CONFIG_KEYS[key];
  const allowed = PICKABLE.filter((k) => (def.scopes as readonly ScopeKind[]).includes(k));

  useEffect(() => {
    if (scope.kind === 'tenant' && scope.id !== tenantId)
      setScope({ kind: 'tenant', id: tenantId });
  }, [tenantId, scope.kind, scope.id]);
  useEffect(() => {
    if (!allowed.includes(scope.kind)) setScope({ kind: 'tenant', id: tenantId });
  }, [key]);

  // Path from the tenant down to the chosen scope, used for the resolution preview.
  const path = useMemo<PathNode[]>(() => {
    const nodes: PathNode[] = [
      { kind: 'tenant', id: tenantId, label: session.tenant?.name ?? 'Tenant' },
    ];
    if (!scope.id) return nodes;
    const units = new Map((orgUnits.data ?? []).map((u) => [u.id, u]));
    const chain: PathNode[] = [];
    const climb = (unitId: string | null) => {
      const seen = new Set<string>();
      while (unitId && units.has(unitId) && !seen.has(unitId)) {
        seen.add(unitId);
        const u = units.get(unitId)!;
        chain.unshift({ kind: 'org_unit', id: u.id, label: u.name });
        unitId = u.parentId;
      }
    };
    let tail: PathNode[] = [];
    if (scope.kind === 'org_unit') climb(scope.id);
    if (scope.kind === 'location') {
      const loc = locations.data?.find((l) => l.id === scope.id);
      if (loc) {
        climb(loc.orgUnitId);
        tail = [{ kind: 'location', id: loc.id, label: loc.name }];
      }
    }
    if (scope.kind === 'register') {
      const reg = registers.data?.find((r) => r.id === scope.id);
      const loc = reg ? locations.data?.find((l) => l.id === reg.locationId) : undefined;
      if (reg && loc) {
        climb(loc.orgUnitId);
        tail = [
          { kind: 'location', id: loc.id, label: loc.name },
          { kind: 'register', id: reg.id, label: reg.name },
        ];
      }
    }
    return [...nodes, ...chain, ...tail];
  }, [scope, tenantId, orgUnits.data, locations.data, registers.data, session.tenant?.name]);

  const histories = useQueries({
    queries: path.map((node) => ({
      queryKey: [...keys.config, 'history', key, node.kind, node.id],
      queryFn: () =>
        api<ConfigEntryDto[]>('/config/history', {
          query: { key, scopeKind: node.kind, scopeId: node.id },
        }),
      enabled: Boolean(node.id) && perms.has('config.view'),
      retry: false,
    })),
  });
  const effective = useConfigEffective(key, scope.kind, scope.id || undefined);
  const history = useConfigHistory(key, scope.kind, scope.id || undefined);
  const canEdit = perms.has('config.edit');

  const nearestIndex = (() => {
    for (let i = path.length - 1; i >= 0; i--) {
      if (histories[i]?.data?.some((e) => e.isCurrent)) return i;
    }
    return -1;
  })();

  if (!perms.has('config.view'))
    return <Alert tone="warning">You cannot view configuration.</Alert>;

  return (
    <>
      <PageHeader
        title="Configuration"
        description="Settings are set at a scope and inherited downwards. The nearest scope on the path wins. Every change is a new version you can compare and roll back."
      />
      <div className="grid grid-2">
        <section className="card" aria-label="Choose setting and scope">
          <SelectInput
            label="Setting"
            options={CONFIG_KEY_NAMES.map((k) => ({ value: k, label: k }))}
            value={key}
            onChange={(e) => setKey(e.target.value as ConfigKey)}
            hint={def.description}
          />
          <ScopePicker value={scope} onChange={setScope} kinds={allowed} legend="Edit at scope" />
          <p className="field-hint">
            Allowed scopes for this setting: {allowed.map((k) => titleCase(k)).join(', ')}. Default
            value: <code>{show(def.default)}</code>
          </p>
        </section>

        <section className="card" aria-label="Scope resolution preview">
          <h2 className="card-title">Resolution preview</h2>
          {scope.id ? (
            <>
              <table className="table" aria-label="Resolution path">
                <thead>
                  <tr>
                    <th scope="col">Scope</th>
                    <th scope="col">Value set here</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {path.map((node, i) => {
                    const entry = histories[i]?.data?.find((e) => e.isCurrent);
                    const loading = histories[i]?.isLoading;
                    return (
                      <tr key={`${node.kind}-${node.id}`} data-testid={`path-${node.kind}`}>
                        <td>
                          {titleCase(node.kind)}: {node.label}
                        </td>
                        <td>
                          {loading ? (
                            '…'
                          ) : entry ? (
                            <>
                              <code>{show(entry.value)}</code>{' '}
                              <span className="muted">v{entry.version}</span>
                            </>
                          ) : (
                            <span className="muted">inherits</span>
                          )}
                        </td>
                        <td>
                          {i === nearestIndex ? (
                            <Badge tone="success">Wins</Badge>
                          ) : entry ? (
                            <Badge tone="neutral">Overridden</Badge>
                          ) : (
                            ''
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p data-testid="effective-value">
                Effective here: <code>{effective.data ? show(effective.data.value) : '…'}</code>{' '}
                <span className="muted">
                  {effective.data
                    ? effective.data.resolvedScope === 'default'
                      ? '(built-in default)'
                      : `(from ${titleCase(effective.data.resolvedScope.kind)}${effective.data.version ? `, v${effective.data.version}` : ''})`
                    : ''}
                </span>
              </p>
            </>
          ) : (
            <p className="muted">Choose a scope to see which value applies there and why.</p>
          )}
        </section>
      </div>

      {scope.id ? (
        <div className="stack" style={{ marginTop: 16 }}>
          {canEdit ? (
            <EditValue
              key={`${key}-${scope.kind}-${scope.id}-${history.data?.[0]?.version ?? 0}`}
              configKey={key}
              scope={scope}
              current={history.data?.find((e) => e.isCurrent)}
              effectiveValue={effective.data?.value}
            />
          ) : (
            <Alert tone="info">You can view configuration but not change it.</Alert>
          )}
          <History
            configKey={key}
            scope={scope}
            canEdit={canEdit}
            entries={history.data ?? []}
            loading={history.isLoading}
            error={history.error ? describeError(history.error) : null}
          />
        </div>
      ) : null}
    </>
  );
}

function parseInput(key: ConfigKey, raw: string): unknown {
  const type = typeofSchema(key);
  if (type === 'boolean') return raw === 'true';
  if (type === 'number') return raw === '' ? Number.NaN : Number(raw);
  return raw;
}

function typeofSchema(key: ConfigKey): 'boolean' | 'number' | 'string' {
  const d = CONFIG_KEYS[key].default;
  return typeof d === 'boolean' ? 'boolean' : typeof d === 'number' ? 'number' : 'string';
}

function EditValue({
  configKey,
  scope,
  current,
  effectiveValue,
}: {
  configKey: ConfigKey;
  scope: ScopeValue;
  current: ConfigEntryDto | undefined;
  effectiveValue: unknown;
}) {
  const type = typeofSchema(configKey);
  const start = current?.value ?? effectiveValue ?? CONFIG_KEYS[configKey].default;
  const [raw, setRaw] = useState(String(start ?? ''));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const put = useApiMutation({
    mutationFn: (value: unknown) =>
      api<ConfigEntryDto>('/config', {
        method: 'PUT',
        body: {
          key: configKey,
          scopeKind: scope.kind,
          scopeId: scope.id,
          value,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      }),
    invalidate: [keys.config],
    success: 'Configuration saved as a new version',
    silentError: true,
  });

  const validate = (): unknown | undefined => {
    const value = parseInput(configKey, raw);
    const parsed = CONFIG_KEYS[configKey].schema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid value');
      return undefined;
    }
    setError(undefined);
    return parsed.data;
  };

  return (
    <form
      noValidate
      aria-label="Edit configuration value"
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setFormError(null);
        const value = validate();
        if (value === undefined) return;
        try {
          await put.mutateAsync(value);
        } catch (err) {
          setFormError(describeError(err));
        }
      }}
    >
      <h2 className="card-title">Set value at {titleCase(scope.kind)}</h2>
      <div className="form-grid">
        {type === 'boolean' ? (
          <SelectInput
            label="Value"
            options={[
              { value: 'true', label: 'On (true)' },
              { value: 'false', label: 'Off (false)' },
            ]}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            error={error}
          />
        ) : (
          <TextInput
            label="Value"
            type={type === 'number' ? 'number' : 'text'}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setError(undefined);
            }}
            onBlur={() => void validate()}
            error={error}
          />
        )}
        <TextInput
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Kept with this version and in the audit log"
        />
      </div>
      <FormError message={formError} />
      <Button type="submit" variant="primary" loading={put.isPending}>
        Save new version
      </Button>
    </form>
  );
}

function History({
  configKey,
  scope,
  canEdit,
  entries,
  loading,
  error,
}: {
  configKey: ConfigKey;
  scope: ScopeValue;
  canEdit: boolean;
  entries: ConfigEntryDto[];
  loading: boolean;
  error: string | null;
}) {
  const [compareId, setCompareId] = useState<string | null>(null);
  const rollback = useApiMutation({
    mutationFn: (entry: ConfigEntryDto) =>
      api<ConfigEntryDto>('/config', {
        method: 'PUT',
        body: {
          key: configKey,
          scopeKind: scope.kind,
          scopeId: scope.id,
          value: entry.value,
          reason: `Rollback to version ${entry.version}`,
        },
      }),
    invalidate: [keys.config],
    success: (e) => `Rolled back: saved as version ${e.version}`,
  });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const compare = compareId ? byId.get(compareId) : undefined;
  const current = entries.find((e) => e.isCurrent);

  return (
    <section className="card" aria-label="Version history">
      <h2 className="card-title">Version history</h2>
      {loading ? <Spinner label="Loading history" /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!loading && entries.length === 0 ? (
        <p className="muted">Nothing has been set at this scope. The value is inherited.</p>
      ) : null}
      {entries.length > 0 ? (
        <table className="table" aria-label="Versions">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Value</th>
              <th scope="col">Saved</th>
              <th scope="col">Reason</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} data-testid={`version-${e.version}`}>
                <td className="num">
                  v{e.version} {e.isCurrent ? <Badge tone="success">Current</Badge> : null}
                </td>
                <td>
                  <code>{show(e.value)}</code>
                </td>
                <td>{formatDateTime(e.createdAt)}</td>
                <td style={{ whiteSpace: 'normal' }}>{e.reason ?? '—'}</td>
                <td>
                  <div className="row-actions">
                    <Button
                      size="sm"
                      onClick={() => setCompareId(compareId === e.id ? null : e.id)}
                      aria-pressed={compareId === e.id}
                      aria-label={`Compare version ${e.version} with current`}
                    >
                      Compare
                    </Button>
                    {canEdit && !e.isCurrent ? (
                      <Button
                        size="sm"
                        onClick={() => rollback.mutate(e)}
                        loading={rollback.isPending && rollback.variables?.id === e.id}
                        aria-label={`Roll back to version ${e.version}`}
                      >
                        Roll back
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {compare && current ? (
        <div style={{ marginTop: 16 }}>
          <h3 className="card-title">
            Version {compare.version} → current (v{current.version})
          </h3>
          <DiffView
            before={{ [configKey]: compare.value }}
            after={{ [configKey]: current.value }}
            label="Config diff"
          />
        </div>
      ) : null}
      {entries.length > 0 ? (
        <KeyValue
          items={[
            {
              label: 'Rollback',
              value: 'Saves the old value as a new version. Nothing is deleted.',
            },
          ]}
        />
      ) : null}
    </section>
  );
}
