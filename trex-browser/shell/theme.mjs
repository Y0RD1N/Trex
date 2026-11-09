// The app's look, as the browser shell wears it.
//
// trex (the app) owns the palette: it resolves the person's tone, accent and light/dark mode into final
// colours (src/browserTheme.ts) and hands them to the worker, which stores them as `theme.json` in the
// private Browser home, next to `engine.json`. The shell only reads that file, validates every value and
// turns it into CSS custom properties. Nothing here computes a palette, so the two cannot drift apart.
//
// Anything that is not exactly what the app writes is ignored and the shell keeps its built-in dark theme.
import fs from 'node:fs';
import path from 'node:path';

export const THEME_FILE = 'theme.json';
const MAX_BYTES = 4096;
/** The colours the app sends, in the order the shell uses them. */
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

// Status colours depend on the mode, not on the tone or the accent: same values as the app's tokens.css.
const MODE = {
  dark: {
    ok: '#7db58f', warn: '#d9a23f', danger: '#e0674f', okBg: 'rgba(125,181,143,.12)', warnBg: 'rgba(217,162,63,.1)', warnBorder: 'rgba(217,162,63,.32)',
    shadow: '0 8px 24px rgba(0,0,0,.38),0 1px 2px rgba(0,0,0,.3)',
  },
  light: {
    ok: '#2c6c45', warn: '#8a6208', danger: '#a8402c', okBg: 'rgba(44,108,69,.09)', warnBg: 'rgba(138,98,8,.09)', warnBorder: 'rgba(138,98,8,.3)',
    shadow: '0 8px 24px rgba(38,30,12,.2),0 1px 2px rgba(38,30,12,.16)',
  },
};

/** The shell's own custom properties (ui/theme.css) for a theme. */
export function themeVariables({ mode, colors: c }) {
  const m = MODE[mode], rgb = [1, 3, 5].map(at => parseInt(c.accent.slice(at, at + 2), 16)).join(',');
  return {
    '--bg': c.app, '--bg-side': c.sidebar, '--surface': c.surface, '--elevated': c.elevated, '--inset': c.inset, '--selected': c.selected,
    '--text': c.text, '--muted': c.muted, '--dim': c.dim, '--edge': c.border, '--edge-strong': c.borderStrong,
    '--accent': c.accent, '--accent-rgb': rgb, '--accent-ink': c.accentInk, '--accent-text': c.accentText,
    '--ok': m.ok, '--warn': m.warn, '--danger': m.danger, '--ok-bg': m.okBg, '--warn-bg': m.warnBg, '--warn-border': m.warnBorder,
    '--pop-shadow': m.shadow, 'color-scheme': mode,
  };
}

/** What ui/theme.css declares by default: the shell's own dark theme, for putting it back when the stored one goes away. */
export const BUILTIN_THEME = {
  mode: 'dark',
  colors: { app: '#16130e', sidebar: '#110f0b', surface: '#1c1913', elevated: '#221e17', inset: '#29241b', selected: '#2a251c', border: '#342f24', borderStrong: '#4b4434',
    text: '#e8e0cc', muted: '#b0a791', dim: '#968e7a', accent: '#f06a8d', accentText: '#f47f9d', accentInk: '#16130e' },
};

/**
 * A stylesheet that restyles every document using ui/theme.css. A document that is already open takes it as an
 * inserted sheet, which sits before the document's own stylesheets in the cascade: there it must be `important`.
 */
export const themeCss = (theme, { important = false } = {}) =>
  `:root{${Object.entries(themeVariables(theme)).map(([name, value]) => `${name}:${value}${important ? ' !important' : ''}`).join(';')}}`;

/** The theme stored in `root`, or null: missing, unreadable, linked, oversized or not a theme. */
export function readTheme(root) {
  try {
    const file = path.join(root, THEME_FILE), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) return null;
    return normalizeTheme(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { return null; }
}

/**
 * Calls `onChange(theme | null)` whenever the stored theme changes. It polls the one file's metadata
 * (`interval`) rather than watching the directory: on Windows a directory watch aborts the whole process
 * when the folder is reached through an 8.3 short name (libuv asserts), and one `stat` a second is free.
 * `check()` re-reads at once, for moments the caller knows something may have changed (the window focusing).
 */
export function watchTheme(root, onChange, delay = 120, interval = 750) {
  const file = path.join(root, THEME_FILE);
  let last = JSON.stringify(readTheme(root)), timer = null;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = readTheme(root), json = JSON.stringify(next);
      if (json !== last) { last = json; onChange(next); }
    }, delay);
    timer.unref?.();
  };
  fs.watchFile(file, { persistent: false, interval }, check);
  return { check, stop() { clearTimeout(timer); fs.unwatchFile(file, check); } };
}
