import { tokens, touch } from './tokens.js';

/** Publish design tokens as CSS custom properties; `styles.css` only references the variables. */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  const set = (name: string, value: string | number) =>
    root.style.setProperty(`--${name}`, typeof value === 'number' ? `${value}px` : value);
  set('touch', touch.min);
  set('touch-tender', touch.tender);
  set('touch-key', touch.key);
  for (const [key, value] of Object.entries(tokens.space)) set(`space-${key}`, value);
  for (const [key, value] of Object.entries(tokens.radius)) set(`radius-${key}`, value);
  for (const [key, value] of Object.entries(tokens.font.size)) set(`text-${key}`, value);
  for (const [key, value] of Object.entries(tokens.color)) set(`c-${key}`, value);
  set('font', tokens.font.family);
  set('mono', tokens.font.mono);
}
