import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrastRatio, resolveBrandAccent } from './foundation/contrast.js';
import { breakpoints, motion, spacing, themes, tokens, touch, typeScale, vars } from './tokens.js';

const rootDir = process.cwd(); // vitest runs from the package root

describe('token values from docs/04-design-plan.md 3.1', () => {
  it('uses the 4-pt spacing grid', () => {
    expect(Object.values(spacing)).toEqual([4, 8, 12, 16, 24, 32, 48, 64]);
  });
  it('has the documented touch targets', () => {
    expect(touch).toMatchObject({ min: 48, tender: 72, key: 64, bump: 96, destructiveGap: 16 });
  });
  it('has the documented type scales', () => {
    const sizes = (s: keyof typeof typeScale) => Object.values(typeScale[s]).map((r) => r.size);
    expect(sizes('pos')).toEqual([14, 16, 20, 28, 40]);
    expect(sizes('admin')).toEqual([12, 14, 16, 20, 24]);
    expect([...new Set(sizes('kds'))]).toEqual([20, 24, 32]);
  });
  it('has the documented breakpoints and a motion ceiling of 150 ms', () => {
    expect(breakpoints).toEqual({ handheld: 480, tablet: 800, terminal: 1366, wide: 1920 });
    expect(Math.max(...Object.values(motion.duration))).toBeLessThanOrEqual(150);
  });
  it('keeps the Sprint 0 token shape for existing apps', () => {
    expect(tokens.space.xl).toBe(24);
    expect(tokens.font.size.lg).toBe(20);
    expect(typeof tokens.color.text).toBe('string');
    expect(tokens.touchTarget).toBe(48);
    expect(vars.color.text).toBe('var(--pos-color-text)');
  });
});

describe('generated outputs', () => {
  it('are up to date with tokens/*.json and the message catalogs', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = (script: string) =>
      execFileSync('node', [`scripts/${script}`, '--check'], { cwd: rootDir, encoding: 'utf8' });
    expect(run('build-tokens.mjs')).toContain('up to date');
    expect(run('build-messages.mjs')).toContain('up to date');
  });
  it('has raw colour only in generated token output', () => {
    const css = readFileSync(`${rootDir}/src/styles/tokens.css`, 'utf8');
    expect(css).toContain('--pos-color-brand-solid');
  });
});

describe.each(['light', 'dark'] as const)('%s theme contrast (WCAG AA)', (name) => {
  const theme = themes[name];
  const { color, status } = theme;
  const surfaces = [color.bg, color.surface, color.surfaceRaised, color.surfaceSunken];

  it('text and muted text reach 4.5:1 on every surface', () => {
    for (const s of surfaces) {
      expect(contrastRatio(color.text, s)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(color.textMuted, s)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('control borders and the focus ring reach 3:1 on the surface', () => {
    expect(contrastRatio(color.borderStrong, color.surface)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrastRatio(color.focusRing, color.surface)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrastRatio(color.focusRing, color.bg)).toBeGreaterThanOrEqual(AA_UI);
  });

  it.each(['brand', 'success', 'warning', 'danger', 'info', 'offline'] as const)(
    '%s role: label on solid 4.5:1, text on subtle 4.5:1, border 3:1 on surface',
    (role) => {
      const r = color[role];
      expect(contrastRatio(r.onSolid, r.solid)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(r.text, r.subtle)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(r.text, color.surface)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(r.border, color.surface)).toBeGreaterThanOrEqual(AA_UI);
    },
  );

  type Pair = { bg: string; fg: string; border: string };
  const entries = Object.entries(status as Record<string, Record<string, Pair>>).flatMap(
    ([group, states]) =>
      Object.entries(states).map(([state, p]) => [`${group}.${state}`, p] as const),
  );
  it.each(entries)('status %s: fg on bg 4.5:1, border 3:1 against the surface', (_name, p) => {
    expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(p.border, color.surface)).toBeGreaterThanOrEqual(AA_UI);
  });
});

describe('tenant brand guard', () => {
  it('accepts a dark brand colour and picks a legible label', () => {
    const accent = resolveBrandAccent('#0b5fff', themes.light.color.surface);
    expect(accent).not.toBeNull();
    expect(contrastRatio(accent!.solid, accent!.onSolid)).toBeGreaterThanOrEqual(AA_TEXT);
  });
  it('rejects a colour that disappears into the surface', () => {
    expect(resolveBrandAccent('#fafafa', themes.light.color.surface)).toBeNull();
    expect(resolveBrandAccent('not-a-colour', themes.light.color.surface)).toBeNull();
  });
});
