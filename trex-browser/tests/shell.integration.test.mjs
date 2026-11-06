// Trex Browser shell (Electron) specific guarantees, exercised through the real
// BrowserService: our UI documents stay invisible to agents, tabs created by
// agents and pages are mapped by CDP target id, the shell shows live agent
// state, and human controls from the shell bind the agent exactly like
// browser_pause. Run with: TREX_BROWSER_DEV=1 node --test tests/shell.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TREX_BROWSER_DEV ??= '1';
process.env.TREX_BROWSER_HEADLESS ??= '1';
const { BrowserService, detectBrowser } = await import('../worker/browser.mjs');
const { context } = await import('../worker/security.mjs');

const available = detectBrowser().channel === 'trex-shell' && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform !== 'linux');
// Snapshot elements are "ref kind name = \"value\" [states]" lines; parse them for assertions.
const parseElement = line => { const m = /^(\S+) (\S+)(?: (.*?))?(?: = ("(?:[^"\\]|\\.)*"))?(?: \[([^\]]*)\])?$/.exec(line); return { ref: m[1], kind: m[2], name: m[3] ?? '', value: m[4] ? JSON.parse(m[4]) : null, states: m[5] ? m[5].split(',') : [] }; };
const elementsOf = data => data.elements.map(parseElement);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server, base, service, home, workspace, A, B;

const page = `<!doctype html><title>Fixture</title><body>
  <button id="go" aria-label="Guardar cambios" onclick="document.title='clicked'">Guardar</button>
  <a id="pop" href="/second" target="_blank">nueva</a>
  <div role="tooltip">Solo texto</div><button style="display:none">Oculto</button><button disabled>Deshabilitado</button>
  <span role="group" aria-label="Grupo"></span><a href="/second">Ver más</a><button>Ver más</button><input placeholder="">
  <script>window.tryUi = () => { try { location.href = 'trex://ui/index.html'; } catch (e) { return String(e); } return 'attempted'; };</script></body>`;

function space(clientId, profile, label) {
  const ctx = context({ cwd: workspace, mode: 'full', clientId, profile });
  service.createProfile(ctx);
  const file = path.join(service.profileDir(ctx), 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), space: { clientId, label } }), { mode: 0o600 });
  return ctx;
}
const call = (ctx, name, args = {}, timeoutMs = 30000) => service.call(ctx, name, args, randomUUID(), timeoutMs);
const shellState = ctx => service.state(ctx).shell.uiPage.evaluate(() => window.trexShell.state());
async function until(fn, message, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) assert.fail(message); await sleep(60); }
}

describe('Trex Browser shell', { skip: !available && 'Trex shell or display unavailable', concurrency: false, timeout: 240_000 }, () => {
  before(async () => {
    server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(req.url === '/second' ? '<title>Second</title>second' : page); }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-shell-test-')); fs.chmodSync(home, 0o700);
    fs.mkdirSync(path.join(home, 'artifacts'), { mode: 0o700 });
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-shell-ws-'));
    service = new BrowserService(home);
    A = space('agent-a', 'BROWSER2', 'Claude Code · Claude Code');
    B = space('agent-b', 'BROWSER3', 'Codex · Revisor');
  });
  after(async () => { await service?.shutdown().catch(() => {}); server?.close(); });

  it('opens the shell and never exposes its UI documents as tabs', async () => {
    await call(A, 'browser_navigate', { url: `${base}/` });
    const tabs = (await call(A, 'browser_tabs', { action: 'list' })).data.tabs;
    assert.equal(tabs.length, 1);
    assert.ok(tabs.every(t => !t.url.startsWith('trex://ui')), JSON.stringify(tabs));
    assert.equal(service.state(A).shell.ui instanceof WeakSet, true);
  });

  it('labels the space without duplicated parts and names the element an agent clicks', async () => {
    const snap = await call(A, 'browser_snapshot');
    const ref = elementsOf(snap.data).find(e => e.name === 'Guardar cambios')?.ref;
    assert.ok(ref, 'button ref');
    // Hold the click open long enough to observe the working state.
    const click = call(A, 'browser_click', { ref, revision: snap.data.revision, tabId: snap.data.tabId });
    const working = await until(async () => { const s = await shellState(A); return s.agent.state === 'working' && s.agent.tool === 'browser_click' && s; }, 'agent working state never reached the shell');
    assert.equal(working.agent.label, 'Claude Code');
    assert.equal(working.agent.detail, 'Guardar cambios');
    await click;
    await until(async () => (await shellState(A)).agent.state === 'idle', 'agent state never returned to idle', 4000);
  });

  it('returns compact snapshots and a summary of what an action changed', async () => {
    await call(A, 'browser_navigate', { url: `${base}/` });
    const full = (await call(A, 'browser_snapshot', { full: true })).data, compact = (await call(A, 'browser_snapshot')).data;
    assert.ok(full.accessibility, 'full:true adds the accessibility tree');
    assert.equal('accessibility' in compact, false, 'the default snapshot is compact');
    assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length, 'compact snapshot must be smaller');
    const parsed = elementsOf(compact), names = parsed.map(e => e.name);
    for (const hidden of ['Solo texto', 'Oculto', 'Grupo']) assert.equal(names.includes(hidden), false, `${hidden} must not be listed`);
    assert.deepEqual(parsed.find(e => e.name === 'Deshabilitado')?.states, ['disabled'], 'disabled controls stay listed');
    assert.equal(names.filter(n => n === 'Ver más').length, 1, 'adjacent duplicates collapse');
    assert.ok(parsed.some(e => e.kind === 'textbox' && !e.name), 'unnamed fields stay actionable');
    assert.ok(compact.omitted > 0);
    const button = parsed.find(e => e.name === 'Guardar cambios');
    assert.ok(button?.ref, JSON.stringify(compact.elements));
    const clicked = await call(A, 'browser_click', { ref: button.ref, revision: compact.revision, tabId: compact.tabId });
    assert.equal(clicked.data.effect?.title, 'clicked', JSON.stringify(clicked.data));
  });

  it('keeps tabs from loading the privileged UI origin', async () => {
    await call(A, 'browser_evaluate', { function: '() => window.tryUi()' });
    await sleep(400);
    const tabs = (await call(A, 'browser_tabs', { action: 'list' })).data.tabs;
    assert.ok(tabs.every(t => !t.url.startsWith('trex://ui')), JSON.stringify(tabs));
    await assert.rejects(call(A, 'browser_navigate', { url: 'trex://ui/index.html' }));
    // The failed attempt must not leave the agent waiting on a navigation.
    await call(A, 'browser_navigate', { url: `${base}/` });
    await call(A, 'browser_click', { selector: '#go' });
  });

  it('creates agent tabs through the shell and maps them by target id', async () => {
    const created = (await call(A, 'browser_tabs', { action: 'new', url: `${base}/second` })).data.tabs;
    assert.equal(created.length, 2);
    const selected = created.find(t => t.selected);
    assert.equal(selected.url, `${base}/second`);
    const s = await shellState(A);
    assert.equal(s.tabs.length, 2);
    assert.equal(s.tabs.find(t => t.id === s.activeTab).url, `${base}/second`);
    // Selecting the first tab from the agent switches the visible shell tab.
    const first = created.find(t => !t.selected);
    await call(A, 'browser_tabs', { action: 'select', tabId: first.tabId });
    await until(async () => { const st = await shellState(A); return st.tabs.find(t => t.id === st.activeTab).url === `${base}/`; }, 'shell did not switch tabs');
  });

  it('turns window.open from a page into an agent-visible shell tab', async () => {
    await call(A, 'browser_click', { selector: '#pop' });
    const tabs = await until(async () => { const t = (await call(A, 'browser_tabs', { action: 'list' })).data.tabs; return t.length === 3 && t; }, 'popup tab not attached');
    assert.equal(tabs.filter(t => t.url === `${base}/second`).length, 2);
  });

  it('applies human pause and resume from the shell to the agent', async () => {
    const s = service.state(A);
    await service.shellEvent(s, { type: 'control', action: 'pause', clientId: 'self' });
    await assert.rejects(call(A, 'browser_click', { selector: '#go' }), e => e.code === 'PAUSED');
    assert.equal((await shellState(A)).agent.state, 'paused');
    // Observation stays available while paused.
    assert.equal((await call(A, 'browser_snapshot')).data.tabId.startsWith('tab-'), true);
    await service.shellEvent(s, { type: 'control', action: 'resume', clientId: 'self' });
    await call(A, 'browser_click', { selector: '#go' });
  });

  it('lets one space pause another from the agents center', async () => {
    await call(B, 'browser_navigate', { url: `${base}/` });
    const spaces = await until(async () => { const l = (await shellState(B)).spaces; return l.length >= 2 && l; }, 'spaces inventory not pushed');
    assert.deepEqual(spaces.map(sp => sp.label).sort(), ['Claude Code', 'Codex · Revisor']);
    await service.shellEvent(service.state(B), { type: 'control', action: 'pause', clientId: 'agent-a' });
    await assert.rejects(call(A, 'browser_click', { selector: '#go' }), e => e.code === 'PAUSED');
    await service.shellEvent(service.state(B), { type: 'control', action: 'resume', clientId: 'agent-a' });
    await call(A, 'browser_click', { selector: '#go' });
  });

  it('lets the host (never an agent tool) raise a space on a given tab', async () => {
    const tabs = (await call(A, 'browser_tabs', { action: 'list' })).data.tabs;
    const target = tabs.find(t => !t.selected);
    assert.deepEqual(await service.focusSpace(A, target.tabId), { focused: true });
    await until(async () => { const st = await shellState(A); return st.tabs.find(t => t.id === st.activeTab).url === target.url; }, 'focus did not select the tab');
    assert.deepEqual(await service.focusSpace(context({ cwd: workspace, mode: 'observe', clientId: 'x', profile: 'BROWSER9' })), { focused: false, reason: 'closed' });
  });
  it('applies the actual center buttons through IPC and closes the target center on focus', async () => {
    const ui = service.state(A).shell.uiPage, other = service.state(B).shell.uiPage;
    assert.equal(ui, other, 'agent spaces share the project window');
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
    await ui.locator('[data-client="agent-a"] [data-a="focus"]').click();
    await until(async () => !(await shellState(A)).centerOpen, 'Ver did not leave the local grid');
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
    const card = ui.locator('[data-client="agent-b"]');
    await card.locator('[data-a="pause"]').click();
    await until(async () => service.state(B).paused, 'Pausar did not reach the other space');
    await card.locator('[data-a="resume"]').click();
    await until(async () => !(await call(B, 'browser_status')).data.paused, 'Reanudar did not reach the other space');
    await other.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
    await card.locator('[data-a="focus"]').click();
    await until(async () => !(await shellState(B)).centerOpen, 'Ver did not close the target grid');
    const focused = await shellState(B);
    assert.equal(focused.tabs.find(tab => tab.id === focused.activeTab).profile, service.key(B));
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
    await card.locator('[data-a="takeover"]').click();
    await until(async () => (await call(B, 'browser_status')).data.paused, 'Tomar control did not pause automation');
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
    await card.locator('[data-a="resume"]').click();
    await until(async () => !(await call(B, 'browser_status')).data.paused, 'manual takeover could not resume');
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: false }));
  });
  it('displays a real screenshot from a space that requires review without clearing that review', async () => {
    service.pause(service.state(B), 'uncertain');
    const ui = service.state(A).shell.uiPage;
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
    await ui.locator('[data-client="agent-b"] [data-a="screenshot"]').click();
    await ui.locator('dialog[open] img').waitFor();
    assert.match(await ui.locator('dialog img').getAttribute('src'), /^data:image\/jpeg;base64,/);
    assert.equal(service.state(B).pauseReason, 'uncertain');
    await ui.locator('[data-capture-close]').click();
    await call(B, 'browser_resume');
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: false }));
  });
  it('scrolls the full activity list with wheel and keyboard while keeping its heading visible', async () => {
    if (!service.state(A).shell) await call(A, 'browser_navigate', { url: `${base}/` });
    await until(async () => (await shellState(A)).spaces.length > 0, 'Space inventory did not arrive');
    const ui = service.state(A).shell.uiPage;
    await ui.evaluate(async () => {
      const state = await window.trexShell.state();
      const at = Date.now() + 100000;
      state.spaces[0].events = Array.from({ length: 80 }, (_, index) => ({ id: `scroll-test-${index}`, at: at - index * 1000, tool: 'browser_click', detail: `Actividad del proyecto ${index}` }));
      await window.trexShell.worker('setSpaces', state.spaces);
      await window.trexShell.command('toggleCenter', { open: true });
    });
    await until(async () => await ui.locator('#feed .ev').count() === 80, 'Activity list was cut short');
    await ui.locator('.center').waitFor();
    const layout = await ui.evaluate(() => ({ width: innerWidth, height: innerHeight, display: getComputedStyle(document.querySelector('.feed')).display }));
    assert.notEqual(layout.display, 'none', JSON.stringify(layout));
    const list = ui.locator('#feed'), heading = await ui.locator('.feed h3').boundingBox();
    await list.hover(); await ui.mouse.wheel(0, 500);
    await until(async () => await list.evaluate(el => el.scrollTop) > 0, 'Wheel did not scroll the activity panel');
    await list.focus(); await ui.keyboard.press('End');
    await until(async () => await list.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), 'Last activity was unreachable');
    assert.equal(Math.round((await ui.locator('.feed h3').boundingBox()).y), Math.round(heading.y));
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: false }));
  });

  it('refuses to open a profile that a person has open for sign-in', { skip: process.platform === 'win32' && 'SingletonLock is a POSIX symlink; Windows uses native single-instance locks' }, async () => {
    const ctx = space('agent-c', 'BROWSER4', 'Sign-in test');
    const userData = path.join(service.profileDir(ctx), 'user-data');
    fs.mkdirSync(userData, { recursive: true });
    fs.symlinkSync(`testhost-${process.pid}`, path.join(userData, 'SingletonLock')); // held by a live process
    try { await assert.rejects(call(ctx, 'browser_navigate', { url: `${base}/` }), e => e.code === 'PROFILE_IN_USE'); }
    finally { fs.rmSync(path.join(userData, 'SingletonLock'), { force: true }); }
  });

  it('closes cleanly and reopens on the next navigation', async () => {
    await call(A, 'browser_close');
    assert.equal(service.state(A).shell, null);
    await call(A, 'browser_navigate', { url: `${base}/` });
    assert.equal((await call(A, 'browser_tabs', { action: 'list' })).data.tabs.length, 1);
  });
});
