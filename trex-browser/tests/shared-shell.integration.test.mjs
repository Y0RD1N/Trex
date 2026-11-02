import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright';
import { BrowserService, detectBrowser } from '../worker/browser.mjs';
import { context } from '../worker/security.mjs';
import { ensureSpaces } from '../worker/spaces.mjs';

process.env.TREX_BROWSER_DEV ??= '1';
process.env.TREX_BROWSER_HEADLESS ??= '1';
const available = detectBrowser().channel === 'trex-shell' && (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
let home, service, server, base, A, B;
const call = (ctx, tool, args = {}) => service.call(ctx, tool, args, randomUUID(), 30000);
const state = () => service.state(A).shell.uiPage.evaluate(() => window.trexShell.state());

describe('one project window with concurrent agent tabs', { skip: !available && 'Trex shell or display unavailable', concurrency: false, timeout: 180000 }, () => {
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-shared-window-'));
    fs.mkdirSync(path.join(home, 'artifacts'));
    server = http.createServer((req, res) => {
      if (req.url === '/download') { res.setHeader('content-disposition', 'attachment; filename="fixture.txt"'); res.end('fixture download'); return; }
      if (req.url === '/value') { res.end('server'); return; }
      res.setHeader('content-type', 'text/html');
      res.end('<title>Shared fixture</title><button id="click" onclick="document.body.dataset.clicked=\'yes\'">Click</button><a id="popup" href="/popup" target="_blank">Popup</a><a id="download" href="/download">Download</a>');
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
    service = new BrowserService(home);
    A = context({ cwd: home, profile: 'BROWSER2', clientId: 'agent-a', mode: 'full' });
    B = context({ cwd: home, profile: 'BROWSER3', clientId: 'agent-b', mode: 'full' });
  });
  after(async () => { await service?.shutdown(); server?.close(); });

  it('keeps reserved agents and startup queries dormant, then displays only the agent that navigates', async () => {
    const members=Array.from({length:6},(_,i)=>({clientId:i===0?A.clientId:i===1?B.clientId:`reserved-${i}`,label:`Agent ${i+1}`}));
    const bindings=ensureSpaces(service,A,members).spaces;
    for(const binding of bindings){
      const ctx={...A,...binding};
      assert.equal((await call(ctx,'browser_status')).data.running,false);
      assert.deepEqual((await call(ctx,'browser_tabs',{action:'list'})).data.tabs,[]);
    }
    assert.equal(service.shellHosts.size,0);
    await call(A,'browser_navigate',{url:`${base}/a`});
    const deadline=Date.now()+5000;
    let ui;
    do {ui=await state();if(ui.spaces.length===1)break;await new Promise(resolve=>setTimeout(resolve,30));}while(Date.now()<deadline);
    assert.equal(ui.tabs.length,1);assert.deepEqual(ui.spaces.map(space=>space.profile),[A.profile]);
    assert.equal(service.state(A).sharedHost.scopes.size,1);
    assert.deepEqual((await call(B,'browser_tabs',{action:'list'})).data.tabs,[]);
    assert.equal((await state()).tabs.length,1);
    await call(A,'browser_close');assert.equal(service.shellHosts.size,0);
  });

  it('coalesces concurrent cold opens into one native window and scoped clients', async () => {
    await Promise.all([call(A, 'browser_navigate', { url: `${base}/a` }), call(B, 'browser_navigate', { url: `${base}/b` })]);
    const a = service.state(A), b = service.state(B);
    assert.equal(a.sharedHost, b.sharedHost); assert.equal(a.shell.uiPage, b.shell.uiPage);
    assert.equal(service.shellHosts.size, 1); assert.equal(a.sharedHost.scopes.size, 2);
    assert.equal(a.browser.pages().length, 1); assert.equal(b.browser.pages().length, 1);
    assert.notEqual(a.browser, b.browser);
    const ui = await state(); assert.equal(ui.tabs.length, 2);
    assert.deepEqual(ui.tabs.map(tab => tab.profile).sort(), [A.profile, B.profile]);
  });

  it('isolates same-origin cookies, local storage and explicit permission grants', async () => {
    const a = service.state(A), b = service.state(B);
    await call(A, 'browser_evaluate', { function: '() => localStorage.setItem("fixture", "agent-a")' });
    assert.equal((await call(B, 'browser_evaluate', { function: '() => localStorage.getItem("fixture")' })).data.value, null);
    await a.browser.addCookies([{ url: base, name: 'fixture', value: 'agent-a', expires: Math.floor(Date.now()/1000)+3600 }]);
    assert.equal((await b.browser.cookies()).some(cookie => cookie.name === 'fixture'), false);
    await a.browser.grantPermissions(['geolocation'], { origin: base });
    const permission = { function: 'async () => (await navigator.permissions.query({name:"geolocation"})).state' };
    assert.equal((await call(A, 'browser_evaluate', permission)).data.value, 'granted');
    assert.notEqual((await call(B, 'browser_evaluate', permission)).data.value, 'granted');
    await a.browser.clearPermissions();
    assert.notEqual((await call(A, 'browser_evaluate', permission)).data.value, 'granted');
  });

  it('keeps background clicks, new tabs and popups from stealing the human-selected tab', async () => {
    await service.focusSpace(B);
    const active = (await state()).activeTab;
    await service.state(A).shell.uiPage.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
    await call(A, 'browser_click', { selector: '#click' });
    assert.equal((await call(A, 'browser_evaluate', { function: '() => document.body.dataset.clicked' })).data.value, 'yes');
    await call(A, 'browser_click', { selector: '#popup' });
    const deadline = Date.now()+5000;
    while (service.state(A).browser.pages().length < 2 && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(service.state(A).browser.pages().length, 2); assert.equal(service.state(B).browser.pages().length, 1);
    await call(A, 'browser_tabs', { action: 'new', url: `${base}/new` });
    assert.equal((await state()).activeTab, active);
    assert.equal((await state()).centerOpen, true);
    await service.state(A).shell.uiPage.evaluate(() => window.trexShell.command('toggleCenter', { open: false }));
  });

  it('cannot discover or attach a peer target through any scoped CDP channel', async () => {
    const a = service.state(A), b = service.state(B), own = await a.browser.browser().newBrowserCDPSession(), peer = await b.browser.newCDPSession(b.browser.pages()[0]);
    const targetId = (await peer.send('Target.getTargetInfo')).targetInfo.targetId;
    assert.equal((await own.send('Target.getTargets')).targetInfos.some(target => target.targetId === targetId), false);
    await assert.rejects(own.send('Target.attachToTarget', { targetId, flatten: true }), /outside/);
    const page = await a.browser.newCDPSession(a.browser.pages()[0]);
    await assert.rejects(page.send('Target.closeTarget', { targetId }), /outside/);
    await assert.rejects(page.send('Browser.close'), /Browser-wide/);
    await Promise.all([own.detach(), peer.detach(), page.detach()]);
  });

  it('View returns to the agent-selected tab even when a person selected a different tab of that agent', async () => {
    const ui = service.state(A).shell.uiPage, current = await state();
    const first = current.tabs.find(tab => tab.profile === A.profile && tab.url === `${base}/a`);
    await ui.evaluate(id => window.trexShell.command('selectTab', { id }), first.id);
    await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
    await ui.locator('[data-client="agent-a"] [data-a="focus"]').click();
    const deadline = Date.now()+5000;
    let result;
    do { result = await state(); if (!result.centerOpen) break; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now()<deadline);
    assert.equal(result.centerOpen, false);
    assert.equal(result.tabs.find(tab => tab.id === result.activeTab).url, `${base}/new`);
  });

  it('lets the owning agent handle a page dialog without the supervisor dismissing it', async () => {
    const pending = call(A, 'browser_evaluate', { function: '() => { alert("shared dialog fixture"); return "accepted"; }' });
    pending.catch(() => {});
    const deadline = Date.now()+5000;
    while (!service.state(A).dialog && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(service.state(A).dialog?.message, 'shared dialog fixture');
    assert.equal(service.state(B).dialog, undefined);
    await call(A, 'browser_handle_dialog', { accept: true });
    assert.equal((await pending).data.value, 'accepted');
    assert.equal(service.state(A).paused, false);
  });

  it('keeps mocks and offline mode scoped to their agent', async () => {
    const evaluate = { function: 'async () => ({ online: navigator.onLine, value: await fetch("/value").then(r => r.text()).catch(() => "offline") })' };
    await call(A, 'browser_route', { action: 'add', url: '**/value', body: 'agent-a' });
    assert.equal((await call(A, 'browser_evaluate', evaluate)).data.value.value, 'agent-a');
    assert.equal((await call(B, 'browser_evaluate', evaluate)).data.value.value, 'server');
    await call(A, 'browser_route', { action: 'clear' });
    await call(A, 'browser_emulate', { offline: true });
    assert.deepEqual((await call(A, 'browser_evaluate', evaluate)).data.value, { online: false, value: 'offline' });
    assert.deepEqual((await call(B, 'browser_evaluate', evaluate)).data.value, { online: true, value: 'server' });
    await call(A, 'browser_emulate', { offline: false });
  });

  it('supports concurrent Playwright traces and native downloads without enabling global performance tracing', async () => {
    await Promise.all([call(A, 'browser_start_trace'), call(B, 'browser_start_trace')]);
    await Promise.all([call(A, 'browser_click', { selector: '#click' }), call(B, 'browser_click', { selector: '#click' })]);
    for (const trace of await Promise.all([call(A, 'browser_stop_trace'), call(B, 'browser_stop_trace')])) assert.ok(trace.artifacts.length);
    await assert.rejects(call(A, 'browser_perf_start'), /exclusive/);
    await call(A, 'browser_click', { selector: '#download' });
    const saved = await call(A, 'browser_save_download', { destination: './download.txt' });
    assert.equal(saved.data.saved, true); assert.equal(fs.readFileSync(path.join(home, 'download.txt'), 'utf8'), 'fixture download');
    assert.equal(service.state(B).downloads?.length || 0, 0);
  });

  it('closes and reopens a profile without closing its peer, then persists storage across a process restart', async () => {
    const host = service.state(B).sharedHost;
    await call(A, 'browser_close');
    assert.equal(service.state(B).sharedHost, host); assert.equal(host.closed, undefined);
    await call(B, 'browser_click', { selector: '#click' });
    await call(A, 'browser_navigate', { url: `${base}/a` });
    assert.equal(service.state(A).sharedHost, host);
    assert.equal((await service.state(A).browser.cookies()).find(cookie => cookie.name === 'fixture').value, 'agent-a');
    await call(B, 'browser_close');
    await call(A, 'browser_perf_start'); await call(A, 'browser_click', { selector: '#click' });
    assert.ok((await call(A, 'browser_perf_stop')).artifacts.length);
    await call(A, 'browser_close'); assert.equal(host.closed, true);
    await call(A, 'browser_navigate', { url: `${base}/a` });
    assert.notEqual(service.state(A).sharedHost, host);
    assert.equal((await service.state(A).browser.cookies()).find(cookie => cookie.name === 'fixture').value, 'agent-a');
    assert.equal((await call(A, 'browser_evaluate', { function: '() => localStorage.getItem("fixture")' })).data.value, 'agent-a');
  });

  it('flushes both profiles before concurrent closes stop their shared process', async () => {
    await call(B, 'browser_navigate', { url: `${base}/b` });
    await service.state(B).browser.addCookies([{ url: base, name: 'fixture', value: 'agent-b', expires: Math.floor(Date.now()/1000)+3600 }]);
    const host = service.state(A).sharedHost;
    await Promise.all([call(A, 'browser_close'), call(B, 'browser_close')]);
    assert.equal(host.closed, true);
    await Promise.all([call(A, 'browser_navigate', { url: `${base}/a` }), call(B, 'browser_navigate', { url: `${base}/b` })]);
    assert.equal((await service.state(A).browser.cookies()).find(cookie => cookie.name === 'fixture').value, 'agent-a');
    assert.equal((await service.state(B).browser.cookies()).find(cookie => cookie.name === 'fixture').value, 'agent-b');
  });

  it('refuses a profile held by a real manual sign-in window, including on Windows', async () => {
    const C = context({ cwd: home, profile: 'BROWSER4', clientId: 'agent-c', mode: 'full' });
    service.createProfile(C);
    const userData = path.join(service.profileDir(C), 'user-data');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const manual = await _electron.launch({ executablePath: detectBrowser().executablePath, args: ['--headless', `--user-data-dir=${userData}`], env, timeout: 15000 });
    try {
      await assert.rejects(call(C, 'browser_navigate', { url: `${base}/c` }), error => error.code === 'PROFILE_IN_USE');
      assert.equal(!!service.state(C).browser, false);
    } finally { await manual.close(); }
    await call(C, 'browser_navigate', { url: `${base}/c` });
    assert.equal(service.state(C).sharedHost, service.state(A).sharedHost);
    await call(C, 'browser_close');
  });
});
