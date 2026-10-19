import { describe, expect, it } from 'vitest';

import { createFormatter } from '../foundation/format.js';

import { createTranslator } from './translate.js';

describe('translator', () => {
  it('resolves base messages and overrides', () => {
    expect(createTranslator('en-AU')('ui.close')).toBe('Close');
    expect(createTranslator('en-AU', { 'ui.close': 'Dismiss now' })('ui.close')).toBe(
      'Dismiss now',
    );
  });
  it('falls back to the base locale and renders the key when missing', () => {
    expect(createTranslator('fr-CA')('ui.close')).toBe('Close');
    expect(createTranslator('en-AU')('nope' as never)).toBe('nope');
  });
  it('handles ICU plural overrides', () => {
    const t = createTranslator('en-AU', {
      'ui.loading': '{n, plural, one {# sale} other {# sales}}',
    });
    expect(t('ui.loading', { n: 1 })).toBe('1 sale');
    expect(t('ui.loading', { n: 3 })).toBe('3 sales');
  });
});

describe('formatter', () => {
  const f = createFormatter('en-AU', 'AUD');
  it('formats integer minor units', () => {
    expect(f.money(3286)).toBe('$32.86');
    expect(f.money(500, 'JPY')).toMatch(/500/);
    expect(f.signedMoney(-450)).toBe('-$4.50');
  });
  it('formats durations', () => {
    expect(f.duration(192)).toBe('3:12');
    expect(f.duration(3792)).toBe('1:03:12');
    expect(f.duration(-5)).toBe('0:00');
  });
});
