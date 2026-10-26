import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

// Exercise the installed native launch path, not a foreground/development
// daemon. Supply a built executable and its packaged runtime explicitly.
const executable = process.env.TREX_BROWSER_TEST_NATIVE;
test('native MCP opens Chrome without manual controls and survives an adapter process-tree kill', {
  skip: process.platform !== 'win32' || !executable,
  timeout: 90_000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trex-browser-native-startup-'));
  const home = path.join(root, 'private-home');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const env = { ...process.env, TREX_BROWSER_HOME: home };
  if (process.env.TREX_BROWSER_TEST_VISIBLE === '1') delete env.TREX_BROWSER_HEADLESS;
  else env.TREX_BROWSER_HEADLESS = '1';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Trex native startup test</title><button onclick="this.textContent=\'Clicked\'">Test button</button>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const children = new Set();
  function run(args, input, binary = executable) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Native test subprocess timed out: ${args[0]} ${input?.name || ''}; stdout bytes=${Buffer.byteLength(stdout)}`)); }, 35_000);
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timer); children.delete(child);
        if (code !== 0) reject(new Error(`Native command failed: ${stderr}`));
        else resolve(JSON.parse(stdout));
      });
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  const call = async (name, args = {}) => {
    t.diagnostic(`Native call: ${name}`);
    const result = await run(['call', '--stdin-json'], {
      name, arguments: args, cwd: workspace, mode: 'full', clientId: 'native-startup-test', profile: 'BROWSER1',
    });
    assert.equal(result.isError, undefined, result.structuredContent?.error?.message);
    assert.equal(result.structuredContent.ok, true);
    return result.structuredContent;
  };
  let adapter;
  try {
    adapter = spawn(executable, ['mcp', '--cwd', workspace, '--mode', 'full', '--client', 'native-startup-test'], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(adapter);
    let buffer = '';
    const pending = new Map();
    adapter.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (value.id !== undefined) pending.get(value.id)?.(value);
      }
    });
    adapter.stderr.resume();
    async function rpc(id, method, params) {
      const response = new Promise(resolve => pending.set(id, resolve));
      adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      let timer;
      try { return await Promise.race([response, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native MCP response timed out')), 15_000); })]); }
      finally { clearTimeout(timer); pending.delete(id); }
    }
    const initialized = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-native-test', version: '1' } });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const inventory = await rpc(2, 'tools/list', {});
    assert.ok(inventory.result.tools.some(tool => tool.name === 'browser_navigate'));
    await assert.rejects(fs.access(path.join(home, 'broker.json')), 'MCP discovery must not start a broker or browser');
    const navigation = await rpc(3, 'tools/call', { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${server.address().port}` } });
    assert.equal(navigation.result?.structuredContent?.ok, true, navigation.result?.structuredContent?.error?.message ?? JSON.stringify(navigation.error));
    const broker = JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8'));
    assert.ok(broker.pid > 0);
    assert.equal((await rpc(4, 'tools/call', { name: 'browser_click', arguments: { role: 'button', name: 'Test button' } })).result.structuredContent.ok, true);
    const snapshot = await rpc(5, 'tools/call', { name: 'browser_snapshot', arguments: {} });
    assert.match(JSON.stringify(snapshot.result.structuredContent.data), /Clicked/);
    const closed = once(adapter, 'close');
    await new Promise((resolve, reject) => {
      const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(adapter.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject); killer.once('close', code => code === 0 ? resolve() : reject(new Error('Could not terminate the test adapter')));
    });
    await closed; children.delete(adapter);
    assert.equal(JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8')).pid, broker.pid);
    const screenshot = await call('browser_take_screenshot', { type: 'png' });
    assert.equal(screenshot.artifacts[0].mimeType, 'image/png');
    assert.ok(screenshot.artifacts[0].bytes > 0);
    const after = await call('browser_snapshot');
    assert.match(JSON.stringify(after.data), /Clicked/);
  } finally {
    for (const child of children) { child.stdin.destroy(); child.kill(); }
    let stopped = false;
    try {
      await run(['stop']).catch(error => t.diagnostic(error.message));
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try { await fs.access(path.join(home, 'broker.json')); await delay(100); }
        catch { stopped = true; break; }
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    assert.equal(stopped, true, 'Owned native broker did not stop');
    // Retain this isolated synthetic profile for failure diagnosis; never touch
    // an installed profile, registry entry, credential or user's Chrome data.
  }
});
