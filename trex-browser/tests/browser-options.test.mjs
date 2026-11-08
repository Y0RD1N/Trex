// Regressions found auditing the agent tools: fill_form on selects and checkboxes given as text,
// certain (not "uncertain") failures for fields that cannot take input, dialogs already closed,
// snapshot selectors that match nothing, clickable elements without a role, readable errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../worker/browser.mjs';
import { context } from '../worker/security.mjs';
import { flatten, compact } from '../worker/observe.mjs';
import { fakePage } from './fixtures/fake-page.mjs';

function form() {
  return [{ role: 'generic', ref: 'e1', children: [
    { role: 'heading', name: 'Pedido', level: 1, ref: 'e2' },
    { role: 'textbox', name: 'Nombre', ref: 'e3', text: '' },
    { role: 'checkbox', name: 'Acepto', ref: 'e4' },
    { role: 'combobox', name: 'Color', ref: 'e5', children: [{ role: 'option', name: 'Rojo', selected: true }, { role: 'option', name: 'Azul' }] },
  ] }];
}
function fixture(t) {
  const page = fakePage({ tree: form() });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-browser-options-'));
  for (const name of ['artifacts', 'receipts']) fs.mkdirSync(path.join(home, name));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = new BrowserService(home), ctx = context({ cwd: home, mode: 'full', clientId: 'owner' }), state = service.state(ctx);
  state.owner = ctx.clientId; state.browser = {}; state.tabs.set('tab-1', page); state.selected = 'tab-1';
  page.kinds = new Map([['e3', { tag: 'INPUT', type: 'text' }], ['e4', { tag: 'INPUT', type: 'checkbox' }], ['e5', { tag: 'SELECT', type: 'select-one' }]]);
  page.options = new Map([['e5', [{ value: 'r', label: 'Rojo' }, { value: 'a', label: 'Azul' }]]]);
  let n = 0; const call = (name, args = {}) => service.call(ctx, name, args, `op-${++n}`, 5000);
  return { service, ctx, state, page, call };
}

test('browser_fill_form fills a select by label or value and a checkbox given as text', async t => {
  const { call, page } = fixture(t);
  const snap = (await call('browser_snapshot')).data, at = ref => ({ tabId: 'tab-1', ref, revision: snap.revision });
  const done = await call('browser_fill_form', { fields: [{ ...at('tab-1-e3'), value: 'Ada' }, { ...at('tab-1-e5'), value: 'Azul' }, { ...at('tab-1-e4'), value: 'true' }] });
  assert.equal(done.data.filled, 3);
  assert.equal(done.data.mismatches, undefined);
  assert.deepEqual(page.actions.filter(a => a[0] !== 'press').map(a => a.slice(0, 3)), [['fill', 'e3', 'Ada'], ['select', 'e5', 'Azul'], ['check', 'e4', true]]);
  await call('browser_fill_form', { fields: [{ ...at('tab-1-e4'), value: 'off' }] });
  assert.deepEqual(page.actions.at(-1).slice(0, 3), ['check', 'e4', false]);
});

test('a select without the requested option fails with certainty and lists the options; the space is not paused', async t => {
  const { call, state } = fixture(t);
  const snap = (await call('browser_snapshot')).data;
  await assert.rejects(call('browser_select_option', { tabId: 'tab-1', ref: 'tab-1-e5', revision: snap.revision, values: ['Verde'] }),
    { message: /^Nothing was selected: no option matches "Verde"\. Options: "Rojo", "Azul"\.$/ });
  assert.ok(!state.pauseReason, 'a certain failure must not pause the browser');
  const ok = await call('browser_select_option', { tabId: 'tab-1', ref: 'tab-1-e5', revision: snap.revision, values: ['Azul'] });
  assert.deepEqual(ok.data.selected, ['Azul']);
});

test('a dialog that is already closed is reported, not treated as an uncertain action', async t => {
  const { call, state } = fixture(t);
  state.dialog = { dialog: { accept: async () => { throw new Error('dialog.accept: Protocol error (Page.handleJavaScriptDialog): No dialog is showing'); }, dismiss: async () => {} }, tabId: 'tab-1', type: 'confirm', message: '¿Seguro?' };
  const result = await call('browser_handle_dialog', { accept: true });
  assert.equal(result.data.handled, false);
  assert.equal(result.data.alreadyClosed, true);
  assert.equal(state.dialog, null);
  assert.ok(!state.pauseReason, 'the space must keep working');
});

test('a dialog that fails for another reason pauses as uncertain and names the cause', async t => {
  const { call, state } = fixture(t);
  state.dialog = { dialog: { accept: async () => { throw new Error('Target closed'); }, dismiss: async () => {} }, tabId: 'tab-1', type: 'alert', message: 'x' };
  await assert.rejects(call('browser_handle_dialog', { accept: true }), { code: 'UNCERTAIN', message: /uncertain \(Target closed\)/ });
  assert.equal(state.pauseReason, 'uncertain');
});

test('a snapshot selector that matches nothing says so instead of timing out', async t => {
  const { call } = fixture(t);
  await assert.rejects(call('browser_snapshot', { selector: '#no-existe' }), { message: /^No element matches the selector "#no-existe"/ });
});

test('listing tabs after the last one was closed still works', async t => {
  const { call, state } = fixture(t);
  state.tabs.clear(); state.selected = null;
  const listed = await call('browser_tabs', { action: 'list' });
  assert.deepEqual(listed.data.tabs, []);
});

test('plain elements with a click handler are listed as clickable, other generic ones are not', () => {
  const tree = [{ role: 'generic', ref: 'e1', children: [
    { role: 'generic', ref: 'e2', cursor: 'pointer', text: 'Añadir al carrito' },
    { role: 'generic', ref: 'e3', text: 'Solo texto' },
    { role: 'generic', ref: 'e4', cursor: 'pointer' },
    { role: 'button', name: 'Comprar', ref: 'e5' },
  ] }];
  const { entries } = flatten(tree);
  const { lines } = compact(entries, 'tab-1');
  assert.deepEqual(lines, ['tab-1-e2 clickable Añadir al carrito', 'tab-1-e5 button Comprar']);
});

test('error text keeps URLs and selectors and hides local file paths', async () => {
  const source = fs.readFileSync(new URL('../worker/worker.mjs', import.meta.url), 'utf8');
  const cleanError = new Function(`${/function cleanError\(message\)\{[\s\S]*?\.slice\(0,2000\);\}/.exec(source)[0]};return cleanError;`)();
  assert.equal(cleanError('page.goto: net::ERR_NAME_NOT_RESOLVED at http://no-existe.invalid/'), 'page.goto: net::ERR_NAME_NOT_RESOLVED at http://no-existe.invalid/');
  assert.equal(cleanError('at http://localhost:3000/dashboard/settings'), 'at http://localhost:3000/dashboard/settings');
  assert.equal(cleanError(`waiting for locator('a[href="/docs"]')`), `waiting for locator('a[href="/docs"]')`);
  assert.equal(cleanError("ENOENT: open '/home/yordi/Documentos/secreto.txt'"), "ENOENT: open '[private path]'");
  assert.equal(cleanError('EACCES C:\\Users\\yordi\\Desktop\\a.txt'), 'EACCES [private path]');
  assert.equal(cleanError('see https://example.com/home/page.html'), 'see https://example.com/home/page.html');
});

test('uploaded files carry the type their extension implies, so sites that check file.type accept them', async () => {
  const { uploadSnapshot } = await import('../worker/security.mjs');
  const dev = process.env.TREX_BROWSER_DEV, launcher = process.env.TREX_BROWSER_LAUNCHER;
  process.env.TREX_BROWSER_DEV = '1'; delete process.env.TREX_BROWSER_LAUNCHER;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trex-upload-')));
  try {
    for (const [name, mime] of [['foto.PNG', 'image/png'], ['doc.pdf', 'application/pdf'], ['datos.csv', 'text/csv'], ['raro.xyz', 'application/octet-stream']]) {
      fs.writeFileSync(path.join(dir, name), 'x');
      assert.equal(uploadSnapshot(dir, name).mimeType, mime, name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (dev === undefined) delete process.env.TREX_BROWSER_DEV; else process.env.TREX_BROWSER_DEV = dev;
    if (launcher !== undefined) process.env.TREX_BROWSER_LAUNCHER = launcher;
  }
});
