import type { z } from 'zod';

const GENERIC = /^(Too small|Too big|Invalid |Input not instance)/;

/**
 * Turns a zod issue into copy a person can act on. Messages written by the contract (for example
 * "letters, digits, _ and - only") pass through untouched; only zod's defaults are rewritten.
 */
export function humaniseIssue(issue: z.core.$ZodIssue): string {
  const raw = issue.message;
  if (raw && !GENERIC.test(raw) && !/^Required$/.test(raw))
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  const i = issue as unknown as {
    code: string;
    origin?: string;
    minimum?: number | bigint;
    maximum?: number | bigint;
    format?: string;
    input?: unknown;
  };
  switch (i.code) {
    case 'too_small':
      if (i.origin === 'string')
        return Number(i.minimum) <= 1 ? 'Required' : `Must be at least ${i.minimum} characters`;
      if (i.origin === 'array')
        return Number(i.minimum) <= 1 ? 'Choose at least one' : `Choose at least ${i.minimum}`;
      return `Must be at least ${i.minimum}`;
    case 'too_big':
      if (i.origin === 'string') return `Must be at most ${i.maximum} characters`;
      return `Must be at most ${i.maximum}`;
    case 'invalid_format':
      if (i.format === 'email') return 'Enter a valid email address';
      if (i.format === 'uuid') return 'Choose an option';
      if (i.format === 'datetime') return 'Enter a valid date and time';
      return raw && !GENERIC.test(raw) ? raw : 'Check the format of this value';
    case 'invalid_type':
      return i.input === undefined || i.input === '' || i.input === null
        ? 'Required'
        : 'Unexpected value';
    case 'invalid_value':
      return 'Choose one of the listed options';
    default:
      return raw || 'Invalid value';
  }
}
