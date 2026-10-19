import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiError } from './api/client';
import { useZodForm } from './zod-form';

const Schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  code: z.string().regex(/^[A-Z]+$/, 'capitals only'),
});

const initial = { name: '', email: '', code: '' };

describe('useZodForm', () => {
  it('shows nothing until a field is touched, then validates that field on blur', () => {
    const { result } = renderHook(() => useZodForm(Schema, initial));
    expect(result.current.errors).toEqual({});
    act(() => result.current.blur('email'));
    expect(result.current.errors.email).toBe('Enter a valid email address');
    expect(result.current.errors.name).toBeUndefined();
  });

  it('clears an error as soon as the touched field becomes valid', () => {
    const { result } = renderHook(() => useZodForm(Schema, initial));
    act(() => result.current.blur('code'));
    expect(result.current.errors.code).toBe('Capitals only');
    act(() => result.current.setValue('code', 'ABC'));
    expect(result.current.errors.code).toBeUndefined();
  });

  it('blocks submit with every field error and does not call the handler', async () => {
    const onValid = vi.fn();
    const { result } = renderHook(() => useZodForm(Schema, initial));
    await act(async () => result.current.handleSubmit(onValid)());
    expect(onValid).not.toHaveBeenCalled();
    expect(Object.keys(result.current.errors).sort()).toEqual(['code', 'email', 'name']);
  });

  it('passes parsed output to the handler and toggles submitting', async () => {
    const seen: unknown[] = [];
    const { result } = renderHook(() =>
      useZodForm(Schema, { name: 'a', email: 'a@b.test', code: 'ZZ' }),
    );
    await act(async () =>
      result.current.handleSubmit(async (v) => {
        seen.push(v);
      })(),
    );
    expect(seen).toEqual([{ name: 'a', email: 'a@b.test', code: 'ZZ' }]);
    expect(result.current.submitting).toBe(false);
  });

  it('maps a server 422 tree onto fields and keeps the form editable', async () => {
    const details = { body: { errors: [], properties: { email: { errors: ['already used'] } } } };
    const { result } = renderHook(() =>
      useZodForm(Schema, { name: 'a', email: 'a@b.test', code: 'ZZ' }),
    );
    await act(async () =>
      result.current.handleSubmit(async () => {
        throw new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', details);
      })(),
    );
    expect(result.current.errors.email).toBe('already used');
    expect(result.current.formError).toBeNull();
  });

  it('shows other API errors as a form message, with a friendlier text for version conflicts', async () => {
    const { result } = renderHook(() =>
      useZodForm(Schema, { name: 'a', email: 'a@b.test', code: 'ZZ' }),
    );
    await act(async () =>
      result.current.handleSubmit(async () => {
        throw new ApiError(412, 'VERSION_CONFLICT', 'The resource was modified by someone else');
      })(),
    );
    expect(result.current.formError).toBe(
      'Someone else changed this record. Reload and try again.',
    );
    await act(async () =>
      result.current.handleSubmit(async () => {
        throw new ApiError(409, 'CONFLICT', 'Conflict');
      })(),
    );
    expect(result.current.formError).toBe('Conflict');
  });

  it('validates the mapped payload when toInput is given, keyed by payload path', () => {
    const Wire = z.object({ address: z.object({ city: z.string().min(2) }) });
    const { result } = renderHook(() =>
      useZodForm(Wire, { 'address.city': '' } as Record<string, unknown>, {
        toInput: (v) => ({ address: { city: String(v['address.city']) } }),
      }),
    );
    act(() => result.current.blur('address.city'));
    expect(result.current.errors['address.city']).toBe('Must be at least 2 characters');
  });
});
