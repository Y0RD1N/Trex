// The app's look for the browser window: tone, accent and light/dark mode, already resolved to colours by trex
// (src/browserTheme.ts). It is kept in the private Browser home as theme.json, like engine.json, and the
// shell (shell/theme.mjs) follows that file live. The shell validates it again: it is the one that turns the
// values into CSS, so it never trusts what it reads.
import path from 'node:path';
import { jsonRead, writePrivate } from './security.mjs';

export const THEME_FILE = 'theme.json';
/** Must match THEME_COLORS in shell/theme.mjs (tests/browser-theme.test.mjs checks it). */
export const THEME_COLORS = ['app', 'sidebar', 'surface', 'elevated', 'inset', 'selected', 'border', 'borderStrong', 'text', 'muted', 'dim', 'accent', 'accentText', 'accentInk'];
const HEX = /^#[0-9a-f]{6}$/;

/** `{ mode, colors }` when `raw` is exactly a theme, else null. Hex values are lower-cased. */
export function normalizeTheme(raw) {
  if (!raw || typeof raw !== 'object' || (raw.mode !== 'dark' && raw.mode !== 'light')) return null;
  const given = raw.colors;
  if (!given || typeof given !== 'object') return null;
  const colors = {};
  for (const key of THEME_COLORS) {
    const value = typeof given[key] === 'string' ? given[key].trim().toLowerCase() : '';
    if (!HEX.test(value)) return null;
    colors[key] = value;
  }
  return { mode: raw.mode, colors };
}

export function readTheme(home) {
  try { return normalizeTheme(jsonRead(path.join(home, THEME_FILE), null)); } catch { return null; }
}

/** Stores the theme (an identical one is left alone, so the shell is not told twice). Throws when it is not a theme. */
export function saveTheme(home, raw) {
  const theme = normalizeTheme(raw);
  if (!theme) throw new Error('theme must be {"mode":"dark|light","colors":{' + THEME_COLORS.map(name => `"${name}":"#rrggbb"`).join(',') + '}}');
  if (JSON.stringify(readTheme(home)) !== JSON.stringify(theme)) writePrivate(path.join(home, THEME_FILE), JSON.stringify(theme));
  return theme;
}
