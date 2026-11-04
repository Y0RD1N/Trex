import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserService, detectBrowser } from '../worker/browser.mjs';
import { context } from '../worker/security.mjs';

process.env.TREX_BROWSER_DEV ??= '1';
process.env.TREX_BROWSER_HEADLESS ??= '1';
const available = detectBrowser().channel === 'trex-shell' && (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
let home, service, server, base, A, B, host;
const call = (ctx, tool, args = {}) => service.call(ctx, tool, args, randomUUID(), 30000);
async function until(fn) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  assert.fail('The expected browser state did not arrive');
}

describe('one application window for personal tabs and different projects', { skip: !available && 'Trex shell or display unavailable', concurrency: false, timeout: 180000 }, () => {
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-global-window-'));
    fs.mkdirSync(path.join(home, 'artifacts'));
    for (const project of ['first-project', 'second-project']) fs.mkdirSync(path.join(home, project));
    server = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/oauth') { res.end('<script>window.opener.postMessage("signed-in",location.origin);window.close()</script>'); return; }
      if (req.url === '/oauth-post') {
        let body = ''; for await (const chunk of req) body += chunk;
        res.end(`<script>window.opener.postMessage(${JSON.stringify(body)},location.origin);window.close()</script>`); return;
      }
      res.end('<title>Fixture</title><button id="login" onclick="window.open(\'/oauth\',\'login\')">Log in</button><form method="post" target="login" action="/oauth-post"><input name="code" value="fixture-code"><button id="post">Submit</button></form><script>addEventListener("message",e=>{if(e.origin!==location.origin)return;if(e.data==="signed-in")document.title="Signed in";else document.body.dataset.post=e.data})</script>');
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    service = new BrowserService(home);
    A = context({ cwd: path.join(home, 'first-project'), profile: 'BROWSER2', clientId: 'same-client-id', mode: 'full' });
    B = context({ cwd: path.join(home, 'second-project'), profile: 'BROWSER2', clientId: 'same-client-id', mode: 'full' });
  });
  after(async () => { await service?.shutdown(); server?.close(); });

  it('reuses the personal window for concurrent opens from two projects with the same profile number', async () => {
    assert.equal((await service.openWindow({ personal: true, url: `${base}/personal` })).opened, true);
    host = service.shellHosts.get('global').host;
    const personalTargets = [...host.targets.get('personal') || []];
    await Promise.all([call(A, 'browser_navigate', { url: `${base}/first` }), call(B, 'browser_navigate', { url: `${base}/second` })]);
    assert.equal(service.state(A).sharedHost, host);
    assert.equal(service.state(B).sharedHost, host);
    assert.equal(service.shellHosts.size, 1);
    assert.equal(host.scopes.size, 2);
    assert.equal(service.state(A).browser.pages().length, 1);
    assert.equal(service.state(B).browser.pages().length, 1);
    assert.notEqual(service.key(A), service.key(B));
    const tabs = await host.link.call('tabs');
    assert.equal(tabs.filter(tab => tab.profile === 'personal').length, 2);
    assert.deepEqual(new Set(tabs.map(tab => tab.profile)), new Set(['personal', service.key(A), service.key(B)]));
    for (const target of personalTargets) assert.equal(host.scopes.get(service.key(A)).transport.targets.has(target), false);
    const again = await service.openWindow({ personal: true });
    assert.equal(again.reused, true);
    assert.equal(service.shellHosts.get('global').host, host);
  });

  it('keeps cookies, local storage and human pause controls isolated across projects', async () => {
    const a = service.state(A), b = service.state(B);
    const cdp = await a.browser.newCDPSession(a.browser.pages()[0]);
    await assert.rejects(cdp.send('Tracing.start'), /without personal tabs/);
    await cdp.detach();
    await a.browser.addCookies([{ name: 'project', value: 'first', url: base }]);
    assert.equal((await b.browser.cookies()).some(cookie => cookie.name === 'project'), false);
    await a.browser.pages()[0].evaluate(() => localStorage.setItem('project', 'first'));
    assert.equal(await b.browser.pages()[0].evaluate(() => localStorage.getItem('project')), null);
    await host.link.uiPage.evaluate(profile => window.trexShell.command('control', { clientId: 'same-client-id', profile, action: 'pause' }), service.key(B));
    assert.equal(b.paused, true);
    assert.equal(a.paused, false);
    await host.link.uiPage.evaluate(profile => window.trexShell.command('control', { clientId: 'same-client-id', profile, action: 'resume' }), service.key(B));
  });

  it('preserves window.opener so a login popup can notify and close back to its originating page', async () => {
    await call(A, 'browser_click', { selector: '#login' });
    await until(async () => await service.state(A).browser.pages()[0].title() === 'Signed in');
    assert.equal(await service.state(B).browser.pages()[0].title(), 'Fixture');
    await until(async () => service.state(A).browser.pages().length === 1);
  });

  it('keeps the POST body when a sign-in form targets a new popup', async () => {
    await call(A, 'browser_click', { selector: '#post' });
    await until(async () => await service.state(A).browser.pages()[0].evaluate(() => document.body.dataset.post) === 'code=fixture-code');
  });

  it('closing agents preserves the personal window and existing profile storage', async () => {
    await call(A, 'browser_close');
    assert.equal(service.state(B).browser.pages()[0].isClosed(), false);
    await call(B, 'browser_close');
    assert.equal(host.closed, undefined);
    assert.equal(service.shellHosts.size, 1);
    assert.ok((await host.link.call('tabs')).every(tab => tab.profile === 'personal'));
    await until(async () => (await host.link.uiPage.evaluate(() => window.trexShell.state())).spaces.length === 0);
    await call(A, 'browser_navigate', { url: `${base}/restored` });
    assert.equal((await service.state(A).browser.cookies()).find(cookie => cookie.name === 'project')?.value, 'first');
    assert.equal(await service.state(A).browser.pages()[0].evaluate(() => localStorage.getItem('project')), 'first');
    await service.shutdown();
    assert.equal(service.shellHosts.size, 0);
  });
});
