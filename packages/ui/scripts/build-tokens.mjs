// Token build: tokens/*.json -> src/styles/tokens.css, src/tokens.ts, dist/tokens.resolved.json.
//
// The JSON files are the single source of truth (docs/04-design-plan.md section 8). Both outputs are
// committed so `tsc --noEmit` works without a build; `--check` fails when they are stale (used by a test).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const readJson = (name) => JSON.parse(readFileSync(join(root, 'tokens', name), 'utf8'));

const core = readJson('core.json');
const type = readJson('type.json');
const colorDoc = readJson('color.json');

// ---------------------------------------------------------------------------------------------
// Reference resolution: "{palette.blue.700}" -> "#1d4ed8", also inside composite strings.

const palette = colorDoc.palette;

function lookup(path) {
  let node = { palette };
  for (const part of path.split('.')) {
    node = node?.[part];
    if (node === undefined) throw new Error(`Unresolved token reference {${path}}`);
  }
  if (typeof node !== 'object' || !('$value' in node)) throw new Error(`{${path}} is not a leaf`);
  return node.$value;
}

function resolveValue(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{([^}]+)\}/g, (_, path) => String(resolveValue(lookup(path))));
}

/** Collapses `{ $value }` leaves into plain values, resolving references. Drops `$` metadata. */
function collapse(node) {
  if (node && typeof node === 'object') {
    if ('$value' in node) return resolveValue(node.$value);
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue;
      out[key] = collapse(child);
    }
    return out;
  }
  return node;
}

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// ---------------------------------------------------------------------------------------------
// Resolved data

const space = collapse(core.space);
const touch = collapse(core.touch);
const control = collapse(core.control);
const radius = collapse(core.radius);
const border = collapse(core.border);
const focus = collapse(core.focus);
const fontFamily = collapse(core.font.family);
const fontWeight = collapse(core.font.weight);
const motion = { duration: collapse(core.motion.duration), easing: collapse(core.motion.easing) };
const breakpoints = collapse(core.breakpoint);
const zIndex = collapse(core.zIndex);
const textScale = collapse(core.textScale);

const typeScale = {};
for (const [surface, roles] of Object.entries(type.scale)) {
  typeScale[surface] = {};
  for (const [role, def] of Object.entries(roles)) {
    typeScale[surface][role] = { size: def.$value, lineHeight: def.lineHeight };
  }
}
const defaultTheme = type.defaultTheme;
const surfaces = Object.keys(typeScale);
const roles = Object.keys(typeScale.pos);

const themes = {};
for (const [name, theme] of Object.entries(colorDoc.themes)) themes[name] = collapse(theme);
const themeNames = Object.keys(themes);
const palettes = collapse(palette);

// ---------------------------------------------------------------------------------------------
// CSS custom properties

const P = '--pos-';
const lines = (indent, entries) => entries.map(([k, v]) => `${indent}${k}: ${v};`).join('\n');

function themeEntries(theme) {
  const entries = [];
  for (const [key, value] of Object.entries(theme.color)) {
    if (key === 'shadow') {
      for (const [level, shadow] of Object.entries(value))
        entries.push([`${P}shadow-${level}`, shadow]);
    } else if (typeof value === 'object') {
      for (const [part, hex] of Object.entries(value)) {
        entries.push([`${P}color-${kebab(key)}-${kebab(part)}`, hex]);
      }
    } else {
      entries.push([`${P}color-${kebab(key)}`, value]);
    }
  }
  for (const [group, states] of Object.entries(theme.status)) {
    for (const [state, parts] of Object.entries(states)) {
      for (const [part, hex] of Object.entries(parts)) {
        entries.push([`${P}status-${kebab(group)}-${kebab(state)}-${part}`, hex]);
      }
    }
  }
  return entries;
}

function scaleEntries(surface) {
  const entries = [];
  for (const role of roles) {
    const { size, lineHeight } = typeScale[surface][role];
    entries.push([`${P}text-${role}-size`, `calc(${size}px * var(${P}text-scale))`]);
    entries.push([`${P}text-${role}-line`, `calc(${lineHeight}px * var(${P}text-scale))`]);
  }
  const controlHeight = surface === 'admin' ? control.adminComfortable : control[surface];
  entries.push([`${P}control-height`, `${controlHeight}px`]);
  return entries;
}

function buildCss() {
  const global = [
    ...Object.entries(space).map(([k, v]) => [`${P}space-${k}`, `${v}px`]),
    ...Object.entries(touch).map(([k, v]) => [`${P}touch-${kebab(k)}`, `${v}px`]),
    ...Object.entries(control).map(([k, v]) => [`${P}control-${kebab(k)}`, `${v}px`]),
    ...Object.entries(radius).map(([k, v]) => [`${P}radius-${k}`, `${v}px`]),
    ...Object.entries(border).map(([k, v]) => [`${P}border-${k}`, `${v}px`]),
    ...Object.entries(focus).map(([k, v]) => [`${P}focus-${k}`, `${v}px`]),
    ...Object.entries(fontFamily).map(([k, v]) => [`${P}font-${k}`, v]),
    ...Object.entries(fontWeight).map(([k, v]) => [`${P}weight-${k}`, String(v)]),
    ...Object.entries(motion.duration).map(([k, v]) => [`${P}duration-${k}`, `${v}ms`]),
    ...Object.entries(motion.easing).map(([k, v]) => [`${P}easing-${k}`, v]),
    ...Object.entries(breakpoints).map(([k, v]) => [`${P}bp-${k}`, `${v}px`]),
    ...Object.entries(zIndex).map(([k, v]) => [`${P}z-${k}`, String(v)]),
    [`${P}text-scale`, String(textScale.normal)],
  ];

  const out = [];
  out.push('/* GENERATED by scripts/build-tokens.mjs from tokens/*.json. Do not edit by hand. */');
  out.push('');
  out.push(`:root {\n${lines('  ', global)}\n}`);
  out.push('');
  out.push(`[data-text-scale='large'] {\n  ${P}text-scale: ${textScale.large};\n}`);
  out.push('');

  // Surface blocks: type scale and control height. POS is the :root default.
  for (const surface of surfaces) {
    const selector =
      surface === 'pos' ? `:root,\n[data-surface='pos']` : `[data-surface='${surface}']`;
    out.push(`${selector} {\n${lines('  ', scaleEntries(surface))}\n}`);
    out.push('');
  }
  out.push(
    `[data-surface='admin'][data-density='compact'] {\n  ${P}control-height: ${control.adminCompact}px;\n}`,
  );
  out.push('');

  // Themes. Light is the default; KDS defaults to dark when no explicit data-theme is set.
  const darkSelectors = themeNames
    .filter((n) => n !== 'light')
    .map((n) => `[data-theme='${n}']`)
    .concat(
      surfaces
        .filter((s) => defaultTheme[s] === 'dark')
        .map((s) => `[data-surface='${s}']:not([data-theme])`),
    );
  out.push(
    `:root,\n[data-theme='light'] {\n${lines('  ', themeEntries(themes.light))}\n  color-scheme: light;\n}`,
  );
  out.push('');
  out.push(
    `${darkSelectors.join(',\n')} {\n${lines('  ', themeEntries(themes.dark))}\n  color-scheme: dark;\n}`,
  );
  out.push('');
  // Status palette hooks: `data-palette="payment-captured"` exposes --palette-bg/fg/border to components.
  for (const [group, states] of Object.entries(themes.light.status)) {
    for (const state of Object.keys(states)) {
      const id = `${kebab(group)}-${kebab(state)}`;
      out.push(
        `[data-palette='${id}'] {\n  --palette-bg: var(${P}status-${id}-bg);\n  --palette-fg: var(${P}status-${id}-fg);\n  --palette-border: var(${P}status-${id}-border);\n}`,
      );
      out.push('');
    }
  }
  out.push(
    `@media (prefers-reduced-motion: reduce) {\n  :root {\n    ${P}duration-fast: 0ms;\n    ${P}duration-base: 0ms;\n  }\n}`,
  );
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// TypeScript module

/** Replaces every leaf of a (nested) object by `fn(path)`. */
function mapLeaves(node, fn, path = []) {
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, mapLeaves(v, fn, [...path, k])]),
    );
  }
  return fn(path);
}

function buildTs() {
  const j = (value, indent = 0) =>
    JSON.stringify(value, null, 2).replace(/\n/g, `\n${' '.repeat(indent)}`);
  const light = themes.light;

  const legacySize = {
    xs: typeScale.admin.caption.size,
    sm: typeScale.pos.caption.size,
    md: typeScale.pos.body.size,
    lg: typeScale.pos.emphasis.size,
    xl: typeScale.pos.heading.size,
    display: typeScale.pos.display.size,
  };
  const legacyColor = {
    bg: light.color.bg,
    surface: light.color.surface,
    surfaceRaised: light.color.surfaceRaised,
    border: light.color.border,
    text: light.color.text,
    textMuted: light.color.textMuted,
    primary: light.color.brand.solid,
    primaryText: light.color.brand.onSolid,
    success: light.color.success.solid,
    warning: light.color.warning.solid,
    danger: light.color.danger.solid,
    info: light.color.info.solid,
  };
  const legacySpace = Object.fromEntries(
    ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'].map((k) => [k, space[k]]),
  );
  const legacyRadius = { sm: radius.sm, md: radius.md, lg: radius.lg, pill: radius.pill };

  const varsCore = {
    space: mapLeaves(space, ([k]) => `var(${P}space-${k})`),
    touch: mapLeaves(touch, ([k]) => `var(${P}touch-${kebab(k)})`),
    radius: mapLeaves(radius, ([k]) => `var(${P}radius-${k})`),
    border: mapLeaves(border, ([k]) => `var(${P}border-${k})`),
    focus: mapLeaves(focus, ([k]) => `var(${P}focus-${k})`),
    font: {
      sans: `var(${P}font-sans)`,
      mono: `var(${P}font-mono)`,
      weight: mapLeaves(fontWeight, ([k]) => `var(${P}weight-${k})`),
    },
    motion: {
      duration: mapLeaves(motion.duration, ([k]) => `var(${P}duration-${k})`),
      easing: mapLeaves(motion.easing, ([k]) => `var(${P}easing-${k})`),
    },
    text: Object.fromEntries(
      roles.map((r) => [r, { size: `var(${P}text-${r}-size)`, line: `var(${P}text-${r}-line)` }]),
    ),
    controlHeight: `var(${P}control-height)`,
  };
  const varsColor = mapLeaves(light.color, (path) => {
    const [first, ...rest] = path;
    if (first === 'shadow') return `var(${P}shadow-${rest[0]})`;
    return `var(${P}color-${[first, ...rest].map(kebab).join('-')})`;
  });
  const varsStatus = mapLeaves(
    light.status,
    ([group, state, part]) => `var(${P}status-${kebab(group)}-${kebab(state)}-${part})`,
  );

  const unionOf = (obj) =>
    Object.keys(obj)
      .map((k) => `'${k}'`)
      .join(' | ');
  const statusUnions = Object.entries(light.status)
    .map(([group, states]) => {
      const name = group.charAt(0).toUpperCase() + group.slice(1);
      return `export type ${name}Status = ${unionOf(states)};`;
    })
    .join('\n');

  return `/* GENERATED by scripts/build-tokens.mjs from tokens/*.json. Do not edit by hand. */
/* Raw colour values are allowed here and nowhere else (see eslint/no-raw-color.js). */

/**
 * Static values (light theme, POS scale). Backward compatible with the Sprint 0 shape. Prefer \`vars\`,
 * which follows the active theme through CSS custom properties.
 */
export const tokens = {
  color: ${j(legacyColor, 2)},
  space: ${j(legacySpace, 2)},
  radius: ${j(legacyRadius, 2)},
  font: {
    family: ${JSON.stringify(fontFamily.sans)},
    mono: ${JSON.stringify(fontFamily.mono)},
    size: ${j(legacySize, 4)},
    weight: ${j(fontWeight, 4)},
  },
  /** Minimum touch target on POS surfaces. */
  touchTarget: ${touch.min},
} as const;

export type Tokens = typeof tokens;

export const spacing = ${j(space)} as const;
export const touch = ${j(touch)} as const;
export const control = ${j(control)} as const;
export const radii = ${j(radius)} as const;
export const borders = ${j(border)} as const;
export const focusRing = ${j(focus)} as const;
export const fontFamily = ${j(fontFamily)} as const;
export const fontWeight = ${j(fontWeight)} as const;
export const motion = ${j(motion)} as const;
export const breakpoints = ${j(breakpoints)} as const;
export const zIndex = ${j(zIndex)} as const;
export const textScale = ${j(textScale)} as const;
export const typeScale = ${j(typeScale)} as const;
export const defaultThemeBySurface = ${j(defaultTheme)} as const;
export const palette = ${j(palettes)} as const;

/** Resolved colour roles and status palettes per theme. Used by contrast tests and tenant-brand checks. */
export const themes = ${j(themes)} as const;

/** CSS custom property references. Same shape as the token groups; resolved by the active theme. */
export const vars = {
  ...${j(varsCore)},
  color: ${j(varsColor, 2)},
  status: ${j(varsStatus, 2)},
} as const;

export type ThemeName = ${unionOf(themes)};
export type Surface = ${unionOf(typeScale)};
export type TypeRole = ${roles.map((r) => `'${r}'`).join(' | ')};
export type SemanticRole = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'offline';
export type StatusGroup = ${unionOf(light.status)};
${statusUnions}
`;
}

// ---------------------------------------------------------------------------------------------

const prettierRc = (await resolveConfig(join(root, 'src/tokens.ts'))) ?? {};
const outputs = [
  [join(root, 'src/styles/tokens.css'), await format(buildCss(), { ...prettierRc, parser: 'css' })],
  [join(root, 'src/tokens.ts'), await format(buildTs(), { ...prettierRc, parser: 'typescript' })],
];
const resolved = JSON.stringify(
  {
    space,
    touch,
    control,
    radius,
    border,
    focus,
    fontFamily,
    fontWeight,
    motion,
    breakpoints,
    zIndex,
    textScale,
    typeScale,
    defaultTheme,
    palette: palettes,
    themes,
  },
  null,
  2,
);

if (check) {
  let stale = false;
  for (const [file, content] of outputs) {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      /* missing counts as stale */
    }
    if (current !== content) {
      console.error(`stale: ${file}`);
      stale = true;
    }
  }
  if (stale) {
    console.error('Token outputs are stale. Run: pnpm --filter @pos/ui tokens');
    process.exit(1);
  }
  console.log('token outputs are up to date');
} else {
  for (const [file, content] of outputs) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`wrote ${file.replace(`${root}/`, '')}`);
  }
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/tokens.resolved.json'), `${resolved}\n`);
  console.log('wrote dist/tokens.resolved.json');
}
