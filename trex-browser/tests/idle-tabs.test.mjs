// Shared window: the tabs of idle agent spaces are hidden and shown only while their agent acts, and an
// agents-center thumbnail does not outlive the center.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../worker/browser.mjs';
import { context } from '../worker/security.mjs';
import { tabShown } from '../shell/view-layout.mjs';
import { fakePage } from './fixtures/fake-page.mjs';

const sets = (...profiles) => new Set(profiles);
const shown = (tab, over = {}) => tabShown({ shared: true, hideIdle: true, activeTab: 't1', centerOpen: false, live: sets(), eligible: sets('A', 'B'), tab, ...over });

test('a window of its own shows its active tab only; the shared window shows every tab unless idle hiding is on', () => {
  const own = { shared: false, hideIdle: false, live: sets(), eligible: sets(), activeTab: 't1', centerOpen: false };
  assert.equal(tabShown({ ...own, tab: { id: 't1' } }), true);
  assert.equal(tabShown({ ...own, tab: { id: 't2' } }), false);
  assert.equal(tabShown({ ...own, tab: { id: 't1' }, centerOpen: true }), false);
  assert.equal(shown({ id: 't2', profile: 'B' }, { hideIdle: false }), true, 'the old behaviour: every tab visible');
});

test('with idle hiding, a space shows its tabs only while it acts, the foreground tab always, and everything while the center is open', () => {
  assert.equal(shown({ id: 't1', profile: 'A' }), true, 'the page the person looks at');
  assert.equal(shown({ id: 't2', profile: 'B' }), false, 'an idle agent behind it');
  assert.equal(shown({ id: 't2', profile: 'B' }, { live: sets('B') }), true, 'the same agent while it acts');
  assert.equal(shown({ id: 't3', profile: 'A' }), false, 'a second tab of the foreground space is still a background tab');
  assert.equal(shown({ id: 't2', profile: 'B' }, { centerOpen: true }), true, 'the center draws thumbnails of every space');
  assert.equal(shown({ id: 't9', profile: 'personal' }), true, 'a space that never announced support (the person, an older worker) is never hidden');
});

function fixture(t, { idleTabs = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-browser-idle-'));
  for (const name of ['artifacts', 'receipts']) fs.mkdirSync(path.join(home, name));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = new BrowserService(home), ctx = context({ cwd: home, mode: 'full', clientId: 'owner' }), state = service.state(ctx);
  const page = fakePage({ tree: [{ role: 'button', name: 'Go', ref: 'e1' }] }), sent = [];
  state.owner = ctx.clientId; state.browser = {}; state.tabs.set('tab-1', page); state.selected = 'tab-1';
  state.shell = { isUi: () => false, push() {}, call: async (name, args) => { sent.push([name, args]); await new Promise(resolve => setTimeout(resolve, 5)); return true; } };
  state.sharedHost = { idleTabs };
  service.pushSpaces = () => {};   // the agents-center inventory reads real pages; not what is tested here
  let n = 0; const call = (name, args = {}) => service.call(ctx, name, args, `op-${++n}`, 5000);
  return { service, ctx, state, call, sent };
}
const live = sent => sent.filter(([name]) => name === 'setLive').map(([, args]) => args);

test('an action tells the shell its space starts and stops acting, once per burst, in order', async t => {
  const { call, sent } = fixture(t);
  await call('browser_snapshot');
  assert.deepEqual(live(sent).map(m => m.live), [true, false]);
  await Promise.all([call('browser_snapshot'), call('browser_snapshot'), call('browser_snapshot')]);
  const all = live(sent);
  assert.equal(all.length % 2, 0);
  assert.ok(all.every((m, i) => m.live === (i % 2 === 0)), 'start and stop alternate: overlapping actions send one start and one stop');
  assert.ok(all.every((m, i) => i === 0 || m.seq > all[i - 1].seq), 'sequence numbers only rise, so the shell can drop a stop that arrives late');
});

test('a failing action still lets the shell hide the space again', async t => {
  const { call, sent } = fixture(t);
  await assert.rejects(call('browser_click', { ref: 'tab-1-e99', revision: 0 }));
  assert.deepEqual(live(sent).map(m => m.live), [true, false]);
});

test('a shell that does not announce idle hiding is never sent anything', async t => {
  const { call, sent } = fixture(t, { idleTabs: false });
  await call('browser_snapshot');
  assert.deepEqual(live(sent), []);
});

test('a shell that fails to answer does not stop the action or leave the space marked as acting', async t => {
  const { call, state, sent } = fixture(t);
  state.shell.call = async name => { sent.push([name]); throw new Error('ui page is gone'); };
  assert.ok((await call('browser_snapshot')).data.elements);
  assert.equal(state.liveSent, undefined, 'the next action tries again');
});

test('the agents-center thumbnail goes when the center closes, so it stops riding along in every broadcast', async t => {
  const { service, state } = fixture(t);
  state.thumbnail = 'data:image/jpeg;base64,AAAA'; state.centerOpen = true;
  await service.shellEvent(state, { type: 'center', open: false });
  assert.equal(state.centerOpen, false);
  assert.equal(state.thumbnail, null);
});
