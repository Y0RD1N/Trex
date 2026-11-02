// MCP over Streamable HTTP served by the broker: per-agent bearer sessions
// issued by the host, mode changes without a new token, and URLs that survive
// a broker restart. Run with: node --test tests/mcp-http.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tools } from '../worker/tools.mjs';

const run = promisify(execFile);
const runtime = fileURLToPath(new URL('../', import.meta.url));
const worker = path.join(runtime, 'worker', 'worker.mjs');
let home, workspace, env, server, base;

async function cli(args, input) {
  const child = run(process.execPath, [worker, ...args], { cwd: runtime, env, maxBuffer: 8 << 20 });
  if (input !== undefined) { child.child.stdin.end(JSON.stringify(input)); }
  const { stdout } = await child;
  return JSON.parse(stdout);
}
const issue = mode => cli(['mcp-session', '--stdin-json'], { cwd: workspace, mode, clientId: 'http-agent', profile: 'BROWSER5' });
async function rpc(session, body, headers = {}) {
  const res = await fetch(session.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${session.token}`, ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
let nextId = 1;
const call = (session, name, args = {}) => rpc(session, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });

describe('MCP over HTTP', { concurrency: false, timeout: 240_000 }, () => {
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-mcp-http-')); fs.chmodSync(home, 0o700);
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-mcp-ws-'));
    env = { ...process.env, TREX_BROWSER_HOME: home, TREX_BROWSER_DEV: '1', TREX_BROWSER_HEADLESS: '1',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(runtime, 'runtime', 'ffmpeg') };
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>HTTP MCP</title><button id="b" onclick="document.title=\'done\'">Go</button>'); }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}/`;
  });
  after(async () => { await cli(['stop']).catch(() => {}); server.close(); });

  let session;
  it('issues a loopback session and rejects anything else', async () => {
    session = await issue('full');
    assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(session.token, /^[0-9a-f]{64}$/);
    assert.equal((await rpc({ ...session, token: '0'.repeat(64) }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await rpc(session, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(session.url, { headers: { authorization: `Bearer ${session.token}` } })).status, 405);
    assert.equal((await rpc(session, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  });

  it('speaks MCP: initialize, tools/list and tools/call', async () => {
    const init = await rpc(session, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.body.result.serverInfo.name.length > 0, true);
    assert.equal((await rpc(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools.length, tools('full').length);
    const nav = await call(session, 'browser_navigate', { url: base });
    assert.equal(nav.body.result.structuredContent.ok, true, JSON.stringify(nav.body));
    const clicked = await call(session, 'browser_click', { selector: '#b' });
    assert.equal(clicked.body.result.structuredContent.effect?.title, 'done');
    assert.equal('receipt' in clicked.body.result.structuredContent, false, 'agents get the lean result');
  });

  it('changes mode for the same agent without a new token', async () => {
    const observe = await issue('observe');
    assert.equal(observe.token, session.token);
    assert.equal((await rpc(session, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).body.result.tools.length, 15);
    const denied = await call(session, 'browser_click', { selector: '#b' });
    assert.equal(denied.body.result.isError, true);
    const snap = (await call(session, 'browser_snapshot', { compact: true })).body.result;
    assert.notEqual(snap.isError, true, JSON.stringify(snap.structuredContent?.error));
    assert.equal(snap.structuredContent.ok, true);
    await issue('full');
  });

  it('keeps URL and token valid across a broker restart', async () => {
    await cli(['stop']);
    await cli(['prepare']);
    const again = await issue('full');
    assert.equal(again.url, session.url);
    assert.equal(again.token, session.token);
    assert.equal((await rpc(session, { jsonrpc: '2.0', id: 4, method: 'ping' })).status, 200);
  });
});
