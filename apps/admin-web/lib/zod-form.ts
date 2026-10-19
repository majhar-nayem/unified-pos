'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';

import { ApiError, flattenValidationDetails } from './api/client';
import { humaniseIssue } from './zod-messages';

export type FieldErrors = Record<string, string>;

export interface ZodForm<TInput extends Record<string, unknown>, TOutput> {
  values: TInput;
  errors: FieldErrors;
  /** Error not tied to a field (server message, network). */
  formError: string | null;
  submitting: boolean;
  setValue<K extends keyof TInput>(name: K, value: TInput[K]): void;
  setValues(patch: Partial<TInput>): void;
  /** Validate a single field on blur: inline validation without waiting for submit. */
  blur(name: keyof TInput & string): void;
  handleSubmit(
    onValid: (output: TOutput) => Promise<void> | void,
  ): (e?: { preventDefault(): void }) => Promise<void>;
  reset(next?: TInput): void;
  setFormError(message: string | null): void;
}

function issuesToErrors(issues: readonly z.core.$ZodIssue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join('.') || '_form';
    errors[path] ??= humaniseIssue(issue);
  }
  return errors;
}

/** Minimal form state bound to a zod schema: inline field errors, server 422 mapping, submit guard. */
export function useZodForm<
  S extends z.ZodType,
  TInput extends Record<string, unknown> = z.input<S> & Record<string, unknown>,
>(
  schema: S,
  initial: TInput,
  options: { toInput?: (values: TInput) => unknown } = {},
): ZodForm<TInput, z.output<S>> {
  const [values, setValuesState] = useState<TInput>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const touched = useRef<Set<string>>(new Set());

  const validate = useCallback(
    (candidate: TInput): { ok: true; data: z.output<S> } | { ok: false; errors: FieldErrors } => {
      const result = schema.safeParse(options.toInput ? options.toInput(candidate) : candidate);
      if (result.success) return { ok: true, data: result.data as z.output<S> };
      return { ok: false, errors: issuesToErrors(result.error.issues) };
    },
    [schema, options.toInput],
  );

  const setValue = useCallback(
    <K extends keyof TInput>(name: K, value: TInput[K]) => {
      setValuesState((prev) => {
        const next = { ...prev, [name]: value };
        if (touched.current.has(String(name))) {
          const r = validate(next);
          setErrors((old) => {
            const copy = { ...old };
            delete copy[String(name)];
            if (!r.ok && r.errors[String(name)]) copy[String(name)] = r.errors[String(name)]!;
            return copy;
          });
        }
        return next;
      });
      setFormError(null);
    },
    [validate],
  );

  const setValues = useCallback((patch: Partial<TInput>) => {
    setValuesState((prev) => ({ ...prev, ...patch }));
  }, []);

  const blur = useCallback(
    (name: keyof TInput & string) => {
      touched.current.add(name);
      setValuesState((current) => {
        const r = validate(current);
        setErrors((old) => {
          const copy = { ...old };
          delete copy[name];
          if (!r.ok && r.errors[name]) copy[name] = r.errors[name]!;
          return copy;
        });
        return current;
      });
    },
    [validate],
  );

  const handleSubmit = useCallback(
    (onValid: (output: z.output<S>) => Promise<void> | void) =>
      async (e?: { preventDefault(): void }) => {
        e?.preventDefault();
        if (submitting) return;
        const r = validate(values);
        if (!r.ok) {
          for (const key of Object.keys(r.errors)) touched.current.add(key);
          setErrors(r.errors);
          setFormError(r.errors._form ?? null);
          return;
        }
        setErrors({});
        setFormError(null);
        setSubmitting(true);
        try {
          await onValid(r.data);
        } catch (error) {
          if (error instanceof ApiError && error.status === 422) {
            const server = flattenValidationDetails(error.details);
            const { _form, ...fields } = server;
            setErrors(fields);
            setFormError(_form ?? (Object.keys(fields).length === 0 ? error.message : null));
          } else if (error instanceof ApiError) {
            setFormError(
              error.status === 412
                ? 'Someone else changed this record. Reload and try again.'
                : error.message,
            );
          } else {
            setFormError(error instanceof Error ? error.message : 'Something went wrong');
          }
        } finally {
          setSubmitting(false);
        }
      },
    [submitting, validate, values],
  );

  const reset = useCallback(
    (next?: TInput) => {
      setValuesState(next ?? initial);
      setErrors({});
      setFormError(null);
      touched.current.clear();
    },
    [initial],
  );

  return useMemo(
    () => ({
      values,
      errors,
      formError,
      submitting,
      setValue,
      setValues,
      blur,
      handleSubmit,
      reset,
      setFormError,
    }),
    [values, errors, formError, submitting, setValue, setValues, blur, handleSubmit, reset],
  );
}
