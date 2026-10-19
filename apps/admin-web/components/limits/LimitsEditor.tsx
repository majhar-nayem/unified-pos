'use client';

import { LIMIT_KEYS, type LimitValueType } from '@pos/auth';
import { LimitsSchema, type LimitsDto } from '@pos/contracts';
import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { SelectInput } from '@/components/ui/Field';

type LimitValue = LimitsDto[string];

function typeOf(key: string, value: LimitValue | undefined): LimitValueType {
  const known = LIMIT_KEYS.find((k) => k.key === key);
  if (known) return known.type;
  if (Array.isArray(value)) return 'string[]';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'number';
}

function defaultFor(type: LimitValueType): LimitValue {
  return type === 'number' ? 0 : type === 'boolean' ? false : type === 'string[]' ? [] : '';
}

interface LimitsEditorProps {
  value: LimitsDto;
  onChange(next: LimitsDto): void;
  /** Limits inherited from the role: shown as the baseline an assignment-level value overrides. */
  inherited?: LimitsDto;
  error?: string | undefined;
  disabled?: boolean;
  legend?: string;
}

/**
 * Edits permission limits (ABAC caps such as the maximum discount percent). Known keys come from
 * the @pos/auth catalog with typed inputs; a limit can only tighten what the role grants, which
 * the server enforces, so the editor shows the inherited value next to each override.
 */
export function LimitsEditor({
  value,
  onChange,
  inherited = {},
  error,
  disabled,
  legend = 'Limits',
}: LimitsEditorProps) {
  const [adding, setAdding] = useState('');
  const hintId = useId();
  const used = new Set(Object.keys(value));
  const available = LIMIT_KEYS.filter((k) => !used.has(k.key));
  const set = (key: string, next: LimitValue) => onChange({ ...value, [key]: next });
  const remove = (key: string) => {
    const copy = { ...value };
    delete copy[key];
    onChange(copy);
  };
  const parsed = LimitsSchema.safeParse(value);

  return (
    <fieldset className="fieldset" disabled={disabled} aria-describedby={hintId}>
      <legend>{legend}</legend>
      <p id={hintId} className="field-hint" style={{ marginTop: 0 }}>
        Limits cap what this grant allows without approval. Leave empty to inherit the role’s
        limits.
      </p>
      {Object.entries(value).length === 0 ? <p className="muted">No limits set.</p> : null}
      {Object.entries(value).map(([key, val]) => {
        const def = LIMIT_KEYS.find((k) => k.key === key);
        const type = typeOf(key, val);
        const base = inherited[key];
        const label = def?.description ?? key;
        const inputId = `limit-${key}`;
        return (
          <div key={key} className="limit-row" data-testid={`limit-${key}`}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor={inputId}>
                {label}
              </label>
              <span className="field-hint mono">{key}</span>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              {type === 'boolean' ? (
                <select
                  id={inputId}
                  className="input"
                  value={String(val)}
                  onChange={(e) => set(key, e.target.value === 'true')}
                >
                  <option value="true">Allowed</option>
                  <option value="false">Not allowed</option>
                </select>
              ) : type === 'number' ? (
                <input
                  id={inputId}
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={typeof val === 'number' ? val : ''}
                  onChange={(e) => set(key, e.target.value === '' ? 0 : Number(e.target.value))}
                />
              ) : type === 'string[]' ? (
                <ListInput
                  id={inputId}
                  value={Array.isArray(val) ? val : []}
                  onChange={(next) => set(key, next)}
                />
              ) : (
                <input
                  id={inputId}
                  className="input"
                  value={typeof val === 'string' ? val : ''}
                  onChange={(e) => set(key, e.target.value)}
                />
              )}
              {base !== undefined ? (
                <span className="field-hint">
                  Role default: {Array.isArray(base) ? base.join(', ') : String(base)}
                </span>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => remove(key)}
              aria-label={`Remove limit ${label}`}
            >
              Remove
            </Button>
          </div>
        );
      })}
      {available.length > 0 ? (
        <div className="inline" style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 260 }}>
            <SelectInput
              label="Add a limit"
              placeholder="Choose a limit…"
              options={available.map((k) => ({ value: k.key, label: k.description }))}
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={!adding}
            onClick={() => {
              const def = LIMIT_KEYS.find((k) => k.key === adding);
              if (!def) return;
              set(adding, defaultFor(def.type));
              setAdding('');
            }}
            style={{ marginBottom: 12 }}
          >
            Add limit
          </Button>
        </div>
      ) : null}
      {!parsed.success ? (
        <div className="field-error" role="alert">
          {parsed.error.issues[0]?.message}
        </div>
      ) : null}
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Comma separated list that keeps what you typed (separators included) while emitting the parsed array. */
function ListInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: readonly string[];
  onChange(next: string[]): void;
}) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => {
    const parsed = parseList(text);
    if (parsed.length !== value.length || parsed.some((v, i) => v !== value[i]))
      setText(value.join(', '));
  }, [value]);
  return (
    <input
      id={id}
      className="input"
      placeholder="comma separated"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
