import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startBrowserFixture } from './fixtures/browser-fixture.mjs';

const execute = promisify(execFile), native = process.env.TREX_BROWSER_TEST_NATIVE;
async function identity(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return { pid, parent: +fields[1], group: +fields[2], start: fields[19],
      args: (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'),
      executable: await fs.readlink(`/proc/${pid}/exe`) };
  } catch (error) { if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return null; throw error; }
}
async function until(check, message) {
  const end = Date.now() + 12000;
  do { if (await check()) return; await delay(100); } while (Date.now() < end);
  assert.fail(message);
}
const same = (a, b) => a && b && a.pid === b.pid && a.start === b.start && a.executable === b.executable;

test('Linux native broker survives adapter process-group death and reaps only its owned profiles',
  { skip: process.platform !== 'linux' || !native, timeout: 180000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trex-linux-native-'));
    const home = path.join(root, 'private-home'), cwd = path.join(root, 'workspace');
    await fs.mkdir(cwd);
    const env = { ...process.env, TREX_BROWSER_HOME: home, TREX_BROWSER_HEADLESS: '1' };
    delete env.TREX_BROWSER_DEV; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const fixture = await startBrowserFixture(); let adapter;
    async function call(name, args = {}, profile = 'BROWSER1') {
      const child = spawn(native, ['call', '--stdin-json'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
      const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code ? reject(new Error(error)) : resolve()); });
      child.stdin.end(JSON.stringify({ name, arguments: args, cwd, mode: 'full', clientId: 'linux-lifecycle', profile }));
      await completed;
      const result = JSON.parse(output); assert.equal(result.structuredContent.ok, true, result.structuredContent.error?.message);
      return result.structuredContent;
    }
    async function processes(broker, projectId, profile) {
      const all = (await Promise.all((await fs.readdir('/proc')).filter(p => /^\d+$/.test(p)).map(p => identity(+p)))).filter(Boolean);
      const directory = path.join(home, 'projects', projectId, profile, 'user-data');
      const browsers = all.filter(p => p.parent === broker.pid && p.args.includes(`--user-data-dir=${directory}`));
      assert.equal(browsers.length, 1, 'One exact native Chromium root must belong to this broker/profile');
      const guards = all.filter(p => p.parent === broker.pid && p.args.includes('__guard-browser') && p.args.includes(String(browsers[0].pid)));
      assert.equal(guards.length, 1, 'One native pidfd guard must supervise the exact browser');
      const tree = [...browsers];
      for (let i = 0; i < tree.length; i++) {
        tree.push(...all.filter(p => p.parent === tree[i].pid && p.executable === browsers[0].executable));
      }
      assert.ok(tree.length > 1, 'Lifecycle test must include real Chromium descendants');
      return [...tree, ...guards];
    }
    try {
      adapter = spawn(native, ['mcp', '--cwd', cwd, '--mode', 'full', '--client', 'linux-lifecycle'], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; adapter.stdout.on('data', b => output += b); adapter.stderr.resume();
      adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
      await until(async () => output.includes('"id":1'), 'Native MCP initialization did not finish');
      const first = await call('browser_navigate', { url: fixture.url });
      let broker = await identity(JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8')).pid);
      assert.ok(broker?.args.includes('daemon'));
      assert.notEqual(broker.group, adapter.pid, 'Broker must leave the MCP process group');
      process.kill(-adapter.pid, 'SIGKILL');
      await until(async () => !await identity(adapter.pid), 'Killed MCP adapter still lives');
      assert.ok(same(broker, await identity(broker.pid)), 'Agent process-group death must preserve the broker');
      await call('browser_navigate', { url: fixture.url }, 'BROWSER2');
      const firstOwned = await processes(broker, first.projectId, 'BROWSER1');
      const secondOwned = await processes(broker, first.projectId, 'BROWSER2');
      await call('browser_close');
      await until(async () => (await Promise.all(firstOwned.map(p => identity(p.pid)))).every((p, i) => !same(firstOwned[i], p)), 'Profile close did not reap its root and guard');
      for (const p of secondOwned) assert.ok(same(p, await identity(p.pid)), 'Other profile was affected by close');
      await call('browser_click', { selector: '#increment' }, 'BROWSER2');
      await call('browser_navigate', { url: fixture.url });
      const reopened = await processes(broker, first.projectId, 'BROWSER1');
      assert.equal(await fs.readlink(`/proc/${broker.pid}/exe`), broker.executable);
      process.kill(broker.pid, 'SIGKILL');
      const owned = [...reopened, ...secondOwned];
      await until(async () => (await Promise.all(owned.map(p => identity(p.pid)))).every((p, i) => !same(owned[i], p)), 'Broker death left an owned browser or native guard alive');
      await call('browser_navigate', { url: fixture.url });
      const fresh = await identity(JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8')).pid);
      assert.equal(same(broker, fresh), false);
      const screenshot = await call('browser_take_screenshot');
      assert.equal(screenshot.artifacts[0].mimeType, 'image/png');
      assert.ok(screenshot.artifacts[0].bytes > 100);
    } finally {
      if (adapter && adapter.exitCode === null) { try { process.kill(-adapter.pid, 'SIGKILL'); } catch {} }
      try { await execute(native, ['stop', '--json'], { env, timeout: 20000 }); }
      finally { await fixture.close(); await fs.rm(root, { recursive: true, force: true }); }
    }
  });
