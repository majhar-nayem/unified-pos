/**
 * WCAG 2.2 contrast maths and the tenant-brand guard. Tenant brand colour is constrained to accents and
 * receipts (docs/04-design-plan.md section 3.1): it is accepted only when it keeps the UI contrast floor.
 */
import { palette } from '../tokens.js';

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export const AA_TEXT = 4.5;
export const AA_UI = 3;

/** Parses #rgb, #rrggbb and `rgb(r g b)` / `rgb(r, g, b)`. Returns null for anything else. */
export function parseColor(input: string): Rgb | null {
  const value = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  const fn = /^rgb\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*\)$/.exec(value);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) };
  return null;
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) throw new Error(`Cannot compute contrast for ${JSON.stringify([a, b])}`);
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface BrandAccent {
  readonly solid: string;
  readonly onSolid: string;
}

/**
 * Validates a tenant brand colour against the surface it sits on. Returns the accent pair (colour plus a
 * black or white label that meets 4.5:1), or null when the colour is unusable, in which case the caller
 * keeps the default brand.
 */
export function resolveBrandAccent(
  brandHex: string,
  surfaceColor: string,
  light: string = palette.neutral['0'],
  dark: string = palette.neutral['950'],
): BrandAccent | null {
  const brand = parseColor(brandHex);
  if (!brand) return null;
  if (contrastRatio(brand, surfaceColor) < AA_UI) return null;
  const onLight = contrastRatio(brand, light);
  const onDark = contrastRatio(brand, dark);
  const onSolid = onLight >= onDark ? light : dark;
  if (Math.max(onLight, onDark) < AA_TEXT) return null;
  return { solid: brandHex.trim().toLowerCase(), onSolid };
}
