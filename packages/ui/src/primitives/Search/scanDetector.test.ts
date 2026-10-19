import { describe, expect, it } from 'vitest';

import { createScanDetector, type ScanOptions } from './scanDetector.js';

const options: ScanOptions = { minLength: 4, maxKeyGapMs: 50, terminator: 'Enter' };

function feed(chars: string, gap: number, start = 0) {
  const detector = createScanDetector();
  let t = start;
  for (const key of chars) {
    detector.handleKey({ key }, options, t);
    t += gap;
  }
  return { detector, end: t };
}

describe('scan detector', () => {
  it('reports a scan for a fast burst ended by the terminator', () => {
    const { detector, end } = feed('93001234', 10);
    expect(detector.handleKey({ key: 'Enter' }, options, end)).toEqual({
      kind: 'scan',
      code: '93001234',
    });
  });

  it('resets after a scan', () => {
    const { detector, end } = feed('9300', 5);
    detector.handleKey({ key: 'Enter' }, options, end);
    expect(detector.length).toBe(0);
  });

  it('is not a scan when shorter than minLength', () => {
    const { detector, end } = feed('930', 5);
    expect(detector.handleKey({ key: 'Enter' }, options, end).kind).toBe('ignored');
  });

  it('is not a scan when keys are slow', () => {
    const { detector, end } = feed('93001234', 120);
    expect(detector.handleKey({ key: 'Enter' }, options, end).kind).toBe('ignored');
  });

  it('is not a scan when the terminator arrives late', () => {
    const { detector, end } = feed('9300', 10);
    expect(detector.handleKey({ key: 'Enter' }, options, end + 500).kind).toBe('ignored');
  });

  it('keeps only the trailing fast burst when typing slows then a scan follows', () => {
    const detector = createScanDetector();
    detector.handleKey({ key: 'a' }, options, 0);
    detector.handleKey({ key: 'b' }, options, 500);
    let t = 1000;
    for (const key of '1234') {
      detector.handleKey({ key }, options, t);
      t += 5;
    }
    expect(detector.handleKey({ key: 'Enter' }, options, t)).toEqual({
      kind: 'scan',
      code: '1234',
    });
  });

  it('ignores Shift between characters of an uppercase code', () => {
    const detector = createScanDetector();
    detector.handleKey({ key: 'Shift' }, options, 0);
    detector.handleKey({ key: 'A' }, options, 2);
    detector.handleKey({ key: 'Shift' }, options, 4);
    detector.handleKey({ key: 'B' }, options, 6);
    detector.handleKey({ key: 'C' }, options, 8);
    detector.handleKey({ key: 'D' }, options, 10);
    expect(detector.handleKey({ key: 'Enter' }, options, 12)).toEqual({
      kind: 'scan',
      code: 'ABCD',
    });
  });

  it('resets on non-printable keys, modifiers and key repeat', () => {
    const detector = createScanDetector();
    detector.handleKey({ key: '1' }, options, 0);
    detector.handleKey({ key: 'Backspace' }, options, 1);
    expect(detector.length).toBe(0);
    detector.handleKey({ key: '1' }, options, 2);
    detector.handleKey({ key: 'c', ctrlKey: true }, options, 3);
    expect(detector.length).toBe(0);
    detector.handleKey({ key: '1' }, options, 4);
    detector.handleKey({ key: '1', repeat: true }, options, 5);
    expect(detector.length).toBe(0);
  });

  it('supports a custom terminator', () => {
    const tabOptions = { ...options, terminator: 'Tab' };
    const detector = createScanDetector();
    let t = 0;
    for (const key of '1234') detector.handleKey({ key }, tabOptions, t++);
    expect(detector.handleKey({ key: 'Tab' }, tabOptions, t)).toEqual({
      kind: 'scan',
      code: '1234',
    });
  });
});
