'use client';

import { CreateOrgUnitSchema, UpdateOrgUnitSchema, type OrgUnitDto } from '@pos/contracts';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { CheckboxInput, FormError, SelectInput, TextInput } from '@/components/ui/Field';
import { Alert, KeyValue, PageHeader, Spinner } from '@/components/ui/Misc';
import { StatusBadge } from '@/components/ui/Badge';
import { api, describeError } from '@/lib/api/client';
import {
  keys,
  useApiMutation,
  useLegalEntities,
  useLocations,
  useOrgUnits,
} from '@/lib/api/resources';
import { usePermissions } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import { ORG_UNIT_KIND_OPTIONS } from '@/lib/options';
import { type TreeNode, buildTree, descendantIds } from '@/lib/tree';
import { useZodForm } from '@/lib/zod-form';

export default function OrganisationPage() {
  const perms = usePermissions();
  const units = useOrgUnits();
  const locations = useLocations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const canManage = perms.has('tenancy.org_unit.manage');

  const tree = useMemo(() => buildTree(units.data ?? []), [units.data]);
  const selected = units.data?.find((u) => u.id === selectedId) ?? null;
  const locationCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of locations.data ?? [])
      counts.set(l.orgUnitId, (counts.get(l.orgUnitId) ?? 0) + 1);
    return counts;
  }, [locations.data]);

  function renderNode(node: TreeNode, depth: number) {
    const open = !collapsed.has(node.unit.id);
    return (
      <li
        key={node.unit.id}
        role="treeitem"
        aria-expanded={node.children.length ? open : undefined}
        aria-level={depth + 1}
        aria-selected={selectedId === node.unit.id}
      >
        <div className={`tree-node${selectedId === node.unit.id ? ' selected' : ''}`}>
          {node.children.length > 0 ? (
            <button
              type="button"
              className="tree-toggle"
              aria-label={`${open ? 'Collapse' : 'Expand'} ${node.unit.name}`}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.unit.id)) next.delete(node.unit.id);
                  else next.add(node.unit.id);
                  return next;
                })
              }
            >
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span className="tree-toggle" aria-hidden="true">
              ·
            </span>
          )}
          <button type="button" className="tree-label" onClick={() => setSelectedId(node.unit.id)}>
            {node.unit.name}
          </button>
          <span className="muted">{titleCase(node.unit.kind)}</span>
          {node.unit.status === 'archived' ? <StatusBadge status="archived" /> : null}
          {locationCount.get(node.unit.id) ? (
            <span className="muted">· {locationCount.get(node.unit.id)} locations</span>
          ) : null}
        </div>
        {node.children.length > 0 && open ? (
          <ul className="tree" role="group">
            {node.children.map((c) => renderNode(c, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <>
      <PageHeader
        title="Organisation tree"
        description="Companies, brands and regions. Permissions and configuration flow down this tree; locations hang off it."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreatingUnder(selectedId)}>
              {selectedId ? 'Add child unit' : 'Add unit'}
            </Button>
          ) : null
        }
      />
      {units.isLoading ? <Spinner label="Loading the organisation" /> : null}
      {units.error ? <Alert tone="danger">{describeError(units.error)}</Alert> : null}
      {units.data && units.data.length === 0 ? (
        <EmptyState
          title="No organisation units yet"
          description="Every tenant starts with a root unit. Create one to start grouping locations."
          action={
            canManage ? (
              <Button variant="primary" onClick={() => setCreatingUnder(null)}>
                Add unit
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {tree.length > 0 ? (
        <div className="card">
          <ul className="tree tree-root" role="tree" aria-label="Organisation units">
            {tree.map((n) => renderNode(n, 0))}
          </ul>
        </div>
      ) : null}

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelectedId(null)}
        title={selected?.name ?? ''}
        description={selected ? `${titleCase(selected.kind)} · code ${selected.code}` : undefined}
      >
        {selected ? (
          <OrgUnitDetail
            key={`${selected.id}-${selected.version}`}
            unit={selected}
            units={units.data ?? []}
            canManage={canManage}
            onAddChild={() => setCreatingUnder(selected.id)}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={creatingUnder !== undefined}
        onClose={() => setCreatingUnder(undefined)}
        title="Add organisation unit"
      >
        {creatingUnder !== undefined ? (
          <CreateOrgUnitForm
            parentId={creatingUnder}
            units={units.data ?? []}
            onDone={(created) => {
              setCreatingUnder(undefined);
              setSelectedId(created.id);
            }}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function OrgUnitDetail({
  unit,
  units,
  canManage,
  onAddChild,
}: {
  unit: OrgUnitDto;
  units: readonly OrgUnitDto[];
  canManage: boolean;
  onAddChild(): void;
}) {
  const legal = useLegalEntities();
  const form = useZodForm(UpdateOrgUnitSchema, {
    name: unit.name,
    code: unit.code,
    kind: unit.kind,
    reportingBoundary: unit.reportingBoundary,
    status: unit.status,
  } as Record<string, unknown>);
  const update = useApiMutation({
    mutationFn: (body: unknown) =>
      api<OrgUnitDto>(`/org-units/${unit.id}`, { method: 'PATCH', body, ifMatch: unit.version }),
    invalidate: [keys.orgUnits],
    success: 'Organisation unit saved',
    silentError: true,
  });
  const excluded = descendantIds(units, unit.id);
  const [parentId, setParentId] = useState(unit.parentId ?? '');
  const [moveError, setMoveError] = useState<string | null>(null);
  const reparent = useApiMutation({
    mutationFn: (newParent: string | null) =>
      api<OrgUnitDto>(`/org-units/${unit.id}/reparent`, {
        method: 'POST',
        body: { parentId: newParent },
        ifMatch: unit.version,
        idempotent: true,
      }),
    invalidate: [keys.orgUnits, keys.locations],
    success: 'Organisation unit moved',
    silentError: true,
  });

  return (
    <div className="stack">
      <KeyValue
        items={[
          { label: 'Status', value: <StatusBadge status={unit.status} /> },
          { label: 'Reporting boundary', value: unit.reportingBoundary ? 'Yes' : 'No' },
          { label: 'Updated', value: formatDateTime(unit.updatedAt) },
          { label: 'Version', value: unit.version },
        ]}
      />
      {canManage ? (
        <>
          <form
            noValidate
            aria-label="Edit unit"
            onSubmit={form.handleSubmit(async (body) => {
              await update.mutateAsync(body);
            })}
          >
            <div className="form-grid">
              <TextInput
                label="Name"
                value={String(form.values.name ?? '')}
                onChange={(e) => form.setValue('name', e.target.value)}
                onBlur={() => form.blur('name')}
                error={form.errors.name}
              />
              <TextInput
                label="Code"
                value={String(form.values.code ?? '')}
                onChange={(e) => form.setValue('code', e.target.value)}
                onBlur={() => form.blur('code')}
                error={form.errors.code}
              />
              <SelectInput
                label="Kind"
                options={ORG_UNIT_KIND_OPTIONS}
                value={String(form.values.kind ?? '')}
                onChange={(e) => form.setValue('kind', e.target.value)}
                error={form.errors.kind}
              />
              <SelectInput
                label="Legal entity"
                placeholder="None"
                options={(legal.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
                value={String(form.values.legalEntityId ?? unit.legalEntityId ?? '')}
                onChange={(e) => form.setValue('legalEntityId', e.target.value || null)}
              />
              <CheckboxInput
                label="Reporting boundary"
                hint="Reports roll up at this unit."
                checked={Boolean(form.values.reportingBoundary)}
                onChange={(e) => form.setValue('reportingBoundary', e.target.checked)}
              />
              <SelectInput
                label="Status"
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'archived', label: 'Archived' },
                ]}
                value={String(form.values.status ?? '')}
                onChange={(e) => form.setValue('status', e.target.value)}
              />
            </div>
            <FormError message={form.formError} />
            <Button type="submit" variant="primary" loading={form.submitting}>
              Save changes
            </Button>
          </form>

          <fieldset className="fieldset">
            <legend>Move in the tree</legend>
            <SelectInput
              label="New parent"
              placeholder="No parent (root)"
              options={units
                .filter((u) => !excluded.has(u.id))
                .map((u) => ({ value: u.id, label: `${u.name} (${titleCase(u.kind)})` }))}
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              hint="Units under this one cannot be chosen: a unit cannot sit inside itself."
            />
            <FormError message={moveError} />
            <Button
              loading={reparent.isPending}
              disabled={(unit.parentId ?? '') === parentId}
              onClick={async () => {
                setMoveError(null);
                try {
                  await reparent.mutateAsync(parentId || null);
                } catch (e) {
                  setMoveError(describeError(e));
                }
              }}
            >
              Move unit
            </Button>
          </fieldset>
          <div>
            <Button onClick={onAddChild}>Add child unit</Button>
          </div>
        </>
      ) : (
        <Alert tone="info">You can view this unit but not change it.</Alert>
      )}
    </div>
  );
}

function CreateOrgUnitForm({
  parentId,
  units,
  onDone,
}: {
  parentId: string | null;
  units: readonly OrgUnitDto[];
  onDone(created: OrgUnitDto): void;
}) {
  const form = useZodForm(CreateOrgUnitSchema, {
    parentId,
    kind: 'region',
    code: '',
    name: '',
  } as Record<string, unknown>);
  const create = useApiMutation({
    mutationFn: (body: unknown) =>
      api<OrgUnitDto>('/org-units', { method: 'POST', body, idempotent: true }),
    invalidate: [keys.orgUnits],
    success: 'Organisation unit created',
    silentError: true,
  });
  return (
    <form
      noValidate
      aria-label="Add unit"
      onSubmit={form.handleSubmit(async (body) => onDone(await create.mutateAsync(body)))}
    >
      <SelectInput
        label="Parent"
        placeholder="No parent (root)"
        options={units.map((u) => ({ value: u.id, label: u.name }))}
        value={String(form.values.parentId ?? '')}
        onChange={(e) => form.setValue('parentId', e.target.value || null)}
        error={form.errors.parentId}
      />
      <TextInput
        label="Name"
        value={String(form.values.name)}
        onChange={(e) => form.setValue('name', e.target.value)}
        onBlur={() => form.blur('name')}
        error={form.errors.name}
        required
      />
      <TextInput
        label="Code"
        value={String(form.values.code)}
        onChange={(e) => form.setValue('code', e.target.value)}
        onBlur={() => form.blur('code')}
        error={form.errors.code}
        hint="Letters, digits, _ and - only"
        required
      />
      <SelectInput
        label="Kind"
        options={ORG_UNIT_KIND_OPTIONS}
        value={String(form.values.kind)}
        onChange={(e) => form.setValue('kind', e.target.value)}
      />
      <FormError message={form.formError} />
      <Button type="submit" variant="primary" loading={form.submitting}>
        Create unit
      </Button>
    </form>
  );
}
