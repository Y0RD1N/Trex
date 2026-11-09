import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import * as worker from '../worker/browser-theme.mjs';
import * as shell from '../shell/theme.mjs';

const colors = {
  app: '#16130e', sidebar: '#110f0b', surface: '#1c1913', elevated: '#221e17', inset: '#29241b', selected: '#2a251c',
  border: '#342f24', borderStrong: '#4b4434', text: '#e8e0cc', muted: '#b0a791', dim: '#968e7a',
  accent: '#f06a8d', accentText: '#f47f9d', accentInk: '#0b0e13',
};
const dark = { mode: 'dark', colors }, light = { mode: 'light', colors: { ...colors, app: '#f2ede0', text: '#1e1a13', accent: '#a8305a' } };
const homes = [];
const tempHome = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-theme-')); homes.push(dir); return dir; };
afterEach(() => { for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await wait(20); } return check(); };

describe('the app theme shared with the browser window', () => {
  it('is validated the same way by the worker that stores it and the shell that wears it', () => {
    assert.deepEqual(worker.THEME_COLORS, shell.THEME_COLORS);
    const inputs = [
      dark, light, { ...dark, colors: { ...colors, accent: '#F06A8D' } },
      { mode: 'sepia', colors }, { mode: 'dark' }, null, 'dark', { mode: 'dark', colors: { ...colors, text: undefined } },
      ...['red', '#fff', 'rgb(1, 2, 3)', '#16130e;}body{display:none', 'url(https://evil.test/x)', '#16130g', '', 7].map(bad => ({ mode: 'dark', colors: { ...colors, app: bad } })),
    ];
    for (const input of inputs) assert.deepEqual(worker.normalizeTheme(input), shell.normalizeTheme(input), JSON.stringify(input));
    assert.equal(shell.normalizeTheme(inputs[2]).colors.accent, '#f06a8d', 'hex is lower-cased');
    assert.equal(shell.normalizeTheme({ ...dark, extra: 1, colors: { ...colors, extra: '#000000' } }).colors.extra, undefined, 'unknown colours are dropped');
  });

  it('becomes CSS custom properties that carry only validated colours and the mode\'s status colours', () => {
    const css = shell.themeCss(shell.normalizeTheme(dark));
    assert.match(css, /^:root\{[^{}]*\}$/);
    for (const expected of ['--bg:#16130e', '--bg-side:#110f0b', '--edge-strong:#4b4434', '--accent:#f06a8d', '--accent-rgb:240,106,141', '--accent-ink:#0b0e13', '--accent-text:#f47f9d', '--danger:#e0674f', 'color-scheme:dark']) assert.ok(css.includes(expected), expected);
    const bright = shell.themeCss(shell.normalizeTheme(light));
    for (const expected of ['--bg:#f2ede0', '--text:#1e1a13', '--accent-rgb:168,48,90', '--danger:#a8402c', '--warn:#8a6208', 'color-scheme:light']) assert.ok(bright.includes(expected), expected);
    assert.ok(!/(url\(|javascript:|<|>|@import)/i.test(css + bright));
  });

  it('puts the built-in theme back exactly as ui/theme.css declares it, and outranks the document when painted live', () => {
    const declared = fs.readFileSync(new URL('../shell/ui/theme.css', import.meta.url), 'utf8');
    const variables = shell.themeVariables(shell.BUILTIN_THEME);
    for (const [name, value] of Object.entries(variables)) {
      const found = new RegExp(`(?:^|[\\s{;])${name}:\\s*([^;]+);`).exec(declared)?.[1].trim();
      assert.equal(found, value, `${name} in theme.css`);
    }
    assert.deepEqual(shell.normalizeTheme(shell.BUILTIN_THEME), shell.BUILTIN_THEME);
    assert.ok(!shell.themeCss(shell.BUILTIN_THEME).includes('!important'));
    const live = shell.themeCss(shell.normalizeTheme(dark), { important: true });
    assert.equal(live.split(';').length, Object.keys(variables).length);
    assert.ok(live.split(';').every(declaration => declaration.replace('}', '').endsWith(' !important')), 'every variable is important');
  });

  it('is stored once by the worker and read by the shell; an identical theme is not rewritten', () => {
    const home = tempHome(), file = path.join(home, 'theme.json');
    assert.equal(worker.readTheme(home), null);
    assert.equal(shell.readTheme(home), null);
    assert.throws(() => worker.saveTheme(home, { mode: 'dark', colors: { ...colors, app: 'red' } }), /theme must be/);
    assert.equal(fs.existsSync(file), false, 'an invalid theme leaves nothing behind');
    assert.deepEqual(worker.saveTheme(home, dark), dark);
    assert.deepEqual(shell.readTheme(home), dark);
    const before = fs.statSync(file, { bigint: true }).ino;
    worker.saveTheme(home, { ...dark, colors: { ...colors, accent: '#F06A8D' } });
    assert.equal(fs.statSync(file, { bigint: true }).ino, before, 'same colours: the file is left alone');
    worker.saveTheme(home, light);
    assert.deepEqual(shell.readTheme(home), light);
  });

  it('ignores a theme file that is oversized, hard-linked, a link or not JSON, and keeps the built-in theme', () => {
    const home = tempHome(), file = path.join(home, 'theme.json');
    fs.writeFileSync(file, JSON.stringify({ ...dark, padding: 'x'.repeat(5000) }));
    assert.equal(shell.readTheme(home), null, 'oversized');
    fs.writeFileSync(file, '{not json');
    assert.equal(shell.readTheme(home), null, 'not JSON');
    fs.writeFileSync(file, JSON.stringify(dark));
    fs.linkSync(file, path.join(home, 'other-name'));
    assert.equal(shell.readTheme(home), null, 'hard-linked');
    fs.rmSync(path.join(home, 'other-name'));
    assert.deepEqual(shell.readTheme(home), dark);
    fs.rmSync(file);
    const target = path.join(home, 'real.json');
    fs.writeFileSync(target, JSON.stringify(dark));
    try { fs.symlinkSync(target, file); } catch { return; } // creating links needs a privilege on some Windows setups
    assert.equal(shell.readTheme(home), null, 'symbolic link');
  });

  it('is followed live: written, changed and removed', async () => {
    const home = tempHome(), seen = [];
    const watch = shell.watchTheme(home, theme => seen.push(theme?.mode ?? null), 30, 50);
    try {
      worker.saveTheme(home, dark);
      assert.ok(await until(() => seen.length === 1), 'a new theme is noticed');
      worker.saveTheme(home, dark);
      worker.saveTheme(home, light);
      assert.ok(await until(() => seen.length === 2), 'a different theme is noticed');
      await wait(150);
      assert.deepEqual(seen, ['dark', 'light'], 'writing the same theme again does not repaint');
      fs.rmSync(path.join(home, 'theme.json'));
      watch.check();
      assert.ok(await until(() => seen.length === 3), 'removing it returns to the built-in theme');
      assert.deepEqual(seen, ['dark', 'light', null]);
    } finally { watch.stop(); }
  });
});
