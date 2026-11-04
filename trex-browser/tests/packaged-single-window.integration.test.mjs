import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const native = process.env.TREX_BROWSER_TEST_NATIVE;
let home, shell, server, base, env;
function run(binary, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged browser command timed out')); }, 45000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-2000) || `Exit ${code}`)); });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
function roots() {
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try {
      // Electron can flatten argv into its process title on Linux.
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      return command.startsWith(shell + ' ') && command.includes(`--user-data-dir=${path.join(home, 'browser-window', 'user-data')} `) && !/(?:^|\s)--type=/.test(command) ? [pid] : [];
    } catch { return []; }
  });
}

describe('packaged desktop entry and broker reuse', { skip: !native || process.platform !== 'linux' || !process.env.DISPLAY ? 'Requires an assembled native Linux runtime and an isolated display' : false, timeout: 120000 }, () => {
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-packaged-window-'));
    shell = path.join(path.dirname(native), 'trex-browser-runtime', 'shell', 'trex-browser-shell');
    env = { ...process.env, TREX_BROWSER_HOME: home, TREX_BROWSER_HEADLESS: '1', TREX_BROWSER_DEV: '0' };
    delete env.TREX_BROWSER_ENGINE;
    delete env.WAYLAND_DISPLAY;
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Packaged fixture</title><p>Fixture</p>'); }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { if (home) await run(native, ['stop']).catch(() => {}); server?.close(); });

  it('the desktop entry, personal menu and agents from two projects all reuse one native browser process', async () => {
    await run(shell, []);
    const first = roots();
    assert.equal(first.length, 1);
    const personal = JSON.parse(await run(native, ['open', '--stdin-json'], { personal: true, url: base }));
    assert.equal(personal.reused, true);
    const contexts = ['project-a', 'project-b'].map(name => {
      const cwd = path.join(home, name); fs.mkdirSync(cwd);
      return { cwd, profile: 'BROWSER2', clientId: 'same-client', mode: 'full' };
    });
    await Promise.all(contexts.map(async ctx => {
      const result = JSON.parse(await run(native, ['call', '--stdin-json'], { ...ctx, name: 'browser_navigate', arguments: { url: base }, operationId: randomUUID(), timeoutMs: 30000 }));
      assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent.error));
    }));
    await run(shell, []);
    assert.deepEqual(roots(), first);
  });
});
