import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { humaniseIssue } from './zod-messages';

const first = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  if (r.success) throw new Error('expected a failure');
  return humaniseIssue(r.error.issues[0]!);
};

describe('humaniseIssue', () => {
  it('rewrites zod defaults into plain language', () => {
    expect(first(z.string().min(1), '')).toBe('Required');
    expect(first(z.string().min(3), 'ab')).toBe('Must be at least 3 characters');
    expect(first(z.string().max(2), 'abc')).toBe('Must be at most 2 characters');
    expect(first(z.string().email(), 'nope')).toBe('Enter a valid email address');
    expect(first(z.string().uuid(), '')).toBe('Choose an option');
    expect(first(z.number().max(20), 99)).toBe('Must be at most 20');
    expect(first(z.number().min(1), 0)).toBe('Must be at least 1');
    expect(first(z.string(), undefined)).toBe('Required');
    expect(first(z.enum(['a', 'b']), 'c')).toBe('Choose one of the listed options');
    expect(first(z.array(z.string()).min(1), [])).toBe('Choose at least one');
  });

  it('keeps messages written by the contract, capitalised', () => {
    expect(first(z.string().regex(/^\d+$/, 'digits only'), 'x')).toBe('Digits only');
    expect(
      first(
        z.string().refine(() => false, 'Passwords do not match'),
        'x',
      ),
    ).toBe('Passwords do not match');
  });
});
