// Phase 3: actions report what changed, refs live until a new document, richer
// compact lines, read-back of inputs, helpful locator failures and smaller logs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../worker/browser.mjs';
import { context } from '../worker/security.mjs';
import { flatten, compact, diff, candidates } from '../worker/observe.mjs';
import { fakePage } from './fixtures/fake-page.mjs';

function fixture(t, page = fakePage({ tree: form() })) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-browser-reports-'));
  for (const name of ['artifacts', 'receipts']) fs.mkdirSync(path.join(home, name));
  t.after(() => { const resolved = fs.realpathSync(home); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.match(path.basename(resolved), /^trex-browser-reports-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  const service = new BrowserService(home), ctx = context({ cwd: home, mode: 'full', clientId: 'owner' }), state = service.state(ctx);
  state.owner = ctx.clientId; state.browser = {}; state.tabs.set('tab-1', page); state.selected = 'tab-1';
  let n = 0; const call = (name, args = {}) => service.call(ctx, name, args, `op-${++n}`, 5000);
  return { service, ctx, state, page, call };
}
function form() {
  return [{ role: 'generic', ref: 'e1', children: [
    { role: 'heading', name: 'Checkout', level: 1, ref: 'e2' },
    'Name', { role: 'textbox', name: 'Name', ref: 'e3', text: '' },
    { role: 'checkbox', name: 'Agree', ref: 'e4' },
    { role: 'combobox', name: 'Color', ref: 'e5', children: [{ role: 'option', name: 'Red', selected: true }, { role: 'option', name: 'Blue' }] },
    { role: 'button', name: 'Pay', ref: 'e6', disabled: true },
    { role: 'button', name: 'Save', ref: 'e7' },
    { role: 'status', ref: 'e8', text: '0' },
    { role: 'link', ref: 'e9', url: '/next', children: [{ role: 'img', name: 'Next page', ref: 'e10' }] },
    { role: 'iframe', ref: 'e11', children: [{ role: 'button', name: 'Ad', ref: 'f1e1' }] },
    'Fill the form',
  ] }];
}
const drop = (page, ref) => { const walk = nodes => { for (const [i, n] of (nodes || []).entries()) if (n && typeof n === 'object') { if (n.ref === ref) { nodes.splice(i, 1); return true; } if (walk(n.children)) return true; } }; walk(page.tree); };
const node = (page, ref) => { let found; const walk = nodes => { for (const n of nodes || []) if (n && typeof n === 'object') { if (n.ref === ref) found = n; walk(n.children); } }; walk(page.tree); return found; };

test('compact lines carry values, states, headings and live text; disabled stay, iframes and select options do not', () => {
  const { entries, texts } = flatten(form());
  const { lines, omitted } = compact(entries, 'tab-1', { extra: new Map([['e3', ['required']]]) });
  assert.deepEqual(lines, ['tab-1-e2 h1 Checkout', 'tab-1-e3 textbox Name [required]', 'tab-1-e4 checkbox Agree', 'tab-1-e5 combobox Color = "Red"', 'tab-1-e6 button Pay [disabled]', 'tab-1-e7 button Save', 'tab-1-e8 status 0', 'tab-1-e9 link Next page']);
  assert.equal(omitted, 1, 'the ad button inside an iframe is not listed');
  assert.deepEqual(texts, ['Name', 'Fill the form']);
  const many = Array.from({ length: 5 }, (_, i) => ({ ref: `e${i}`, role: 'button', name: `B${i}`, states: [] }));
  assert.deepEqual(compact(many, 't', { cap: 3 }).more, 2);
  assert.deepEqual(candidates(entries, { role: 'button', name: 'save' }).map(e => e.ref), ['e7', 'e6']);
});

test('diff reports added elements, removed count, changed values or states, new text, URL and title', () => {
  const before = { doc: 1, url: 'u', title: 'a', ...flatten(form()) };
  const tree = form(), root = tree[0].children;
  root[2].text = 'Ada'; root[3].checked = true; root.splice(6, 1); root.push({ role: 'alert', ref: 'e12', text: 'Saved' }, 'Thanks');
  const after = { doc: 1, url: 'u#done', title: 'b', ...flatten(tree) };
  assert.deepEqual(diff(before, after, 'tab-1'), { url: 'u#done', title: 'b', added: ['tab-1-e12 alert Saved'], removed: 1, changed: ['tab-1-e3 textbox Name = "Ada" (was empty)', 'tab-1-e4 checkbox Agree [checked] (was no state)'], text: ['Thanks'] });
  assert.deepEqual(diff(before, { ...after, doc: 2, entries: [{ ref: 'e1', role: 'link', name: 'Home', states: [] }] }, 'tab-1'), { url: 'u#done', title: 'b', navigated: true, added: ['tab-1-e1 link Home'] });
  assert.deepEqual(diff(before, before, 'tab-1'), {});
});

test('a page without a required field skips the per-field reads; one with required fields still marks them', async t => {
  const { call, page } = fixture(t);
  const none = (await call('browser_snapshot')).data;
  assert.equal(page.requiredReads || 0, 0, 'no per-field read when the page has nothing required');
  assert.ok(none.elements.includes('tab-1-e3 textbox Name'), 'the field is still listed, without [required]');
  page.required = new Set(['e3']);
  const some = (await call('browser_snapshot')).data;
  assert.ok(some.elements.includes('tab-1-e3 textbox Name [required]'));
  assert.ok(page.requiredReads > 0 && page.requiredReads <= 3, 'only the listed fields are read');
});

test('when the required count cannot be read, every field is asked as before', async t => {
  const { call, page } = fixture(t);
  page.required = new Set(['e3']);
  const frame = page.mainFrame(), locator = frame.locator;
  frame.locator = selector => selector.includes('required') ? { count: async () => { throw new Error('context was destroyed'); } } : locator(selector);
  const snap = (await call('browser_snapshot')).data;
  assert.ok(snap.elements.includes('tab-1-e3 textbox Name [required]'));
});

test('a click reports what changed and leaves every ref and the revision valid', async t => {
  const { call, page, service, state } = fixture(t);
  page.required = new Set(['e3']);
  const snap = (await call('browser_snapshot')).data;
  assert.ok(snap.elements.includes('tab-1-e3 textbox Name [required]'));
  page.onAction = (kind, ref) => { if (ref === 'e7' && !page.saved) { page.saved = true; node(page, 'e8').text = '1'; page.tree[0].children.push({ role: 'alert', ref: 'e12', text: 'Saved' }, 'Thanks'); } };
  const clicked = await call('browser_click', { tabId: 'tab-1', ref: 'tab-1-e7', revision: snap.revision });
  assert.deepEqual(clicked.data, { clicked: true, effect: { added: ['tab-1-e12 alert Saved'], changed: ['tab-1-e8 status 1 (was "0")'], text: ['Thanks'] } });
  assert.equal(clicked.revision, snap.revision);
  const again = await call('browser_click', { tabId: 'tab-1', ref: 'tab-1-e7', revision: snap.revision });
  assert.equal(again.data.effect, undefined, 'nothing changed the second time');
  assert.equal(service.pageState(state, page).revision, snap.revision);
});

test('a new document makes earlier refs stale; the click that loaded it lists the new page', async t => {
  const { call, page } = fixture(t);
  const snap = (await call('browser_snapshot')).data;
  page.onAction = (kind, ref) => { if (ref === 'e9') { page.doc = 2; page.url = 'http://localhost/next'; page.title = 'Next'; page.tree = [{ role: 'generic', ref: 'e1', children: [{ role: 'heading', name: 'Next', level: 1, ref: 'e2' }, { role: 'link', name: 'Home', ref: 'e3' }] }]; } };
  const clicked = await call('browser_click', { tabId: 'tab-1', ref: 'tab-1-e9', revision: snap.revision });
  assert.deepEqual(clicked.data.effect, { url: 'http://localhost/next', title: 'Next', navigated: true, added: ['tab-1-e2 h1 Next', 'tab-1-e3 link Home'] });
  assert.ok(clicked.revision > snap.revision);
  await assert.rejects(call('browser_click', { tabId: 'tab-1', ref: 'tab-1-e3', revision: snap.revision }), { code: 'STALE_SNAPSHOT', message: /new page/ });
  assert.equal((await call('browser_click', { tabId: 'tab-1', ref: 'tab-1-e3', revision: clicked.revision })).data.clicked, true);
});

test('a re-rendered element is re-resolved by role, name and position; a deleted one never redirects', async t => {
  const { call, page } = fixture(t);
  page.tree[0].children.push({ role: 'button', name: 'Delete', ref: 'e20' }, { role: 'button', name: 'Delete', ref: 'e21' });
  const snap = (await call('browser_snapshot')).data;
  drop(page, 'e7'); page.tree[0].children.push({ role: 'button', name: 'Save', ref: 'e30' });
  const clicked = await call('browser_click', { tabId: 'tab-1', ref: 'tab-1-e7', revision: snap.revision });
  assert.equal(clicked.data.note, 'tab-1-e7 was re-rendered; now tab-1-e30');
  assert.deepEqual(page.actions.at(-1), ['click', 'e30']);
  drop(page, 'e20'); // the first row is deleted: the second "Delete" is not the same element
  await assert.rejects(call('browser_click', { tabId: 'tab-1', ref: 'tab-1-e20', revision: snap.revision }), { code: 'STALE_SNAPSHOT', message: /is gone; 1 element like it now\. Candidates:\ntab-1-e21 button Delete/ });
  assert.deepEqual(page.actions.at(-1), ['click', 'e30']);
  await assert.rejects(call('browser_click', { tabId: 'tab-2', ref: 'tab-1-e7', revision: snap.revision }), /Tab not found/);
});

test('locator failures give the count and candidates with fresh refs, after a case-insensitive try', async t => {
  const { call, page } = fixture(t);
  const loose = await call('browser_click', { role: 'button', name: 'save' });
  assert.equal(loose.data.note, 'matched name "save" ignoring case');
  await assert.rejects(call('browser_click', { role: 'button', name: 'Pai' }), { message: /^Role button "Pai" matched 0 elements; exactly one is required\. Candidates \(revision 0\):\ntab-1-e6 button Pay \[disabled\]\ntab-1-e7 button Save$/ });
  page.selectors = { '.btn': ['e6', 'e7'] };
  await assert.rejects(call('browser_click', { selector: '.btn' }), { message: /^Selector \.btn matched 2 elements; exactly one is required\. Candidates \(revision 0\):\ntab-1-e6 button Pay \[disabled\]\ntab-1-e7 button Save$/ });
});

test('typed, filled and selected values are read back and mismatches reported', async t => {
  const { call, page } = fixture(t);
  const snap = (await call('browser_snapshot')).data, at = ref => ({ tabId: 'tab-1', ref, revision: snap.revision });
  page.transform = value => value.slice(0, 5); // a maxlength=5 field
  const typed = await call('browser_type', { ...at('tab-1-e3'), text: 'Ada Lovelace' });
  assert.deepEqual(typed.data.mismatch, { expected: 'Ada Lovelace', actual: 'Ada L' });
  assert.equal((await call('browser_type', { ...at('tab-1-e3'), text: 'Ada' })).data.mismatch, undefined);
  page.password = new Set(['e3']);
  assert.deepEqual((await call('browser_type', { ...at('tab-1-e3'), text: 'secret-pass' })).data.mismatch, { expected: '(hidden)', actual: '(hidden, 5 chars)' });
  page.password = new Set();
  const filled = await call('browser_fill_form', { fields: [{ ...at('tab-1-e3'), value: 'Grace Hopper' }, { ...at('tab-1-e4'), value: true }] });
  assert.deepEqual(filled.data.mismatches, [{ field: 0, expected: 'Grace Hopper', actual: 'Grace' }]);
  page.labels = { blue: 'Blue' };
  assert.deepEqual((await call('browser_select_option', { ...at('tab-1-e5'), values: ['blue'] })).data.selected, ['Blue']);
});

test('console reads are short by default: limit 20, level, since cursor, merged repeats, cut text', async t => {
  const { call, service, state } = fixture(t);
  for (let i = 0; i < 25; i++) service.pushEvent(state, { kind: 'console', type: 'log', text: `line ${i}`, tabId: 'tab-1' });
  for (let i = 0; i < 3; i++) service.pushEvent(state, { kind: 'console', type: 'error', text: 'Boom', tabId: 'tab-1' });
  service.pushEvent(state, { kind: 'pageerror', type: 'pageerror', text: 'x'.repeat(500), tabId: 'tab-1' });
  const first = (await call('browser_console_messages')).data;
  assert.equal(first.events.length, 20); assert.equal(first.earlier, 7); assert.equal(first.cursor, 29);
  const errors = (await call('browser_console_messages', { level: 'error' })).data.events;
  assert.deepEqual(errors.map(e => [e.type, e.count ?? 1, e.text.length]), [['error', 3, 4], ['pageerror', 1, 301]]);
  service.pushEvent(state, { kind: 'console', type: 'warning', text: 'Later', tabId: 'tab-1' });
  assert.deepEqual((await call('browser_console_messages', { since: first.cursor })).data.events.map(e => e.text), ['Later']);
  const raw = (await call('browser_console_messages', { full: true, limit: 300 })).data.events;
  assert.equal(raw.length, 30); assert.equal(raw[28].text.length, 500); assert.ok(raw[0].at);
});

test('network lists documents, xhr, fetch and failures by default; filters and bodies by window', async t => {
  const { call, service, state } = fixture(t), page = fakePage();
  service.attachPage(state, page);
  const request = (url, resourceType, post) => ({ url: () => url, method: () => post ? 'POST' : 'GET', resourceType: () => resourceType, postDataBuffer: () => post ? Buffer.from(post) : null });
  const send = (r, status, body) => { page.emit('request', r); if (status !== undefined) page.emit('response', { request: () => r, status: () => status, headers: () => ({ 'content-type': 'text/plain' }), finished: async () => {}, body: async () => Buffer.from(body ?? '') }); };
  send(request('http://localhost/', 'document'), 200, '<html>');
  send(request('http://localhost/app.css', 'stylesheet'), 200);
  send(request('http://localhost/logo.png', 'image'), 404);
  const api = request('http://localhost/api/items', 'fetch', 'q=1'); send(api, 200, 'y'.repeat(40000));
  const lost = request('http://localhost/api/lost', 'xhr'); page.emit('request', lost); page.emit('requestfailed', Object.assign(lost, { failure: () => ({ errorText: 'net::ERR_FAILED' }) }));
  const list = (await call('browser_network_requests')).data;
  assert.deepEqual(list.requests.map(r => [r.url.replace('http://localhost', ''), r.status ?? null, r.failed ?? null]), [['/', 200, null], ['/logo.png', 404, null], ['/api/items', 200, null], ['/api/lost', null, 'net::ERR_FAILED']]);
  assert.equal(list.skipped, 1);
  assert.deepEqual((await call('browser_network_requests', { failed: true })).data.requests.map(r => r.url.slice(-4)), ['.png', 'lost']);
  assert.deepEqual((await call('browser_network_requests', { url: 'API/', status: 200 })).data.requests.map(r => r.type), ['fetch']);
  assert.equal((await call('browser_network_requests', { all: true })).data.requests.length, 5);
  assert.deepEqual((await call('browser_network_requests', { types: ['stylesheet'] })).data.requests.map(r => r.type), ['stylesheet']);
  const id = list.requests[2].requestId;
  const body = (await call('browser_network_body', { requestId: id })).data;
  assert.deepEqual([body.body.length, body.bytes, body.remaining, body.next], [16384, 40000, 23616, 16384]);
  const tail = (await call('browser_network_body', { requestId: id, offset: 39990, maxBytes: 100 })).data;
  assert.deepEqual([tail.body, tail.offset, tail.remaining], ['y'.repeat(10), 39990, undefined]);
  assert.equal((await call('browser_network_body', { requestId: id, kind: 'request' })).data.body, 'q=1');
});
