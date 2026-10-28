import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { downloadBytes, startBrowserFixture } from './fixtures/browser-fixture.mjs';

// Run with: node --test --test-concurrency=1 tests/browser.integration.test.mjs
// These are subprocess + installed Chrome integration tests, with no worker mocks.
// TREX_BROWSER_TEST_NODE can select the packaged Node runtime for worker/MCP subprocesses.
const runtime = fileURLToPath(new URL('../', import.meta.url));
const worker = path.join(runtime, 'worker', 'worker.mjs');
const nodeExecutable = process.env.TREX_BROWSER_TEST_NODE || process.execPath;
// Exercise the installed native trust boundary as well as the development worker.
const nativeExecutable = process.env.TREX_BROWSER_TEST_NATIVE;
const commandExecutable = nativeExecutable || nodeExecutable;
const workerArgs = nativeExecutable ? [] : [worker];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ebmlSignature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const runFile = promisify(execFile);
let root, home, workspace, otherWorkspace, env, fixture;
const outputs = [];
const children = new Set();

function launch(args, input, options = {}) {
  const child = spawn(commandExecutable, [...workerArgs, ...args], {
    cwd: runtime, env: options.env || env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Worker ${args[0]} exceeded subprocess deadline`)); }, 110_000);
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      children.delete(child);
      outputs.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
  // Prevent an unhandled rejection while another concurrent command is in flight.
  result.catch(() => {});
  if (input !== undefined) child.stdin.end(JSON.stringify(input));
  else child.stdin.end();
  return { child, result };
}

async function cli(args, input, options = {}) {
  const result = await launch(args, input, options).result;
  assert.equal(result.code, 0, `Worker ${args[0]} exit code; stderr: ${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, `Worker ${args[0]} must emit one JSON result`);
  return JSON.parse(lines[0]);
}

function callInput(name, args = {}, overrides = {}) {
  return { name, arguments: args, cwd: workspace, mode: 'full', clientId: 'test', profile: 'BROWSER1', ...overrides };
}
async function call(name, args = {}, overrides = {}) {
  return cli(['call', '--stdin-json'], callInput(name, args, overrides));
}
function success(result) {
  assert.equal(result.isError, undefined, result.structuredContent?.error?.message);
  assert.equal(result.structuredContent?.ok, true);
  assert.ok(Array.isArray(result.content));
  assert.ok(Array.isArray(result.structuredContent.artifacts));
  assert.deepEqual(result.structuredContent.receipt, { status: 'completed', manualReview: false, replaySafe: false });
  assert.match(result.structuredContent.profile, /^BROWSER[1-9][0-9]?$/);
  assert.match(result.structuredContent.projectId, /^[a-f0-9]{24}$/);
  assert.deepEqual(JSON.parse(result.content.find(item => item.type === 'text').text), result.structuredContent);
  return result.structuredContent;
}
function failure(result, code, message) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.ok, false);
  assert.deepEqual(result.structuredContent.artifacts, []);
  if (code) assert.equal(result.structuredContent.error.code, code);
  if (message) assert.match(result.structuredContent.error.message, message);
  return result.structuredContent;
}
async function ok(name, args = {}, overrides = {}) { return success(await call(name, args, overrides)); }
async function evaluate(fn, arg, overrides = {}) {
  return (await ok('browser_evaluate', { function: typeof fn === 'string' ? fn : fn.toString(), ...(arg === undefined ? {} : { arg }) }, overrides)).data.value;
}
async function navigate() {
  await ok('browser_navigate', { url: `${fixture.url}/` });
  await ok('browser_wait_for', { selector: '#increment', time: 5 });
}
async function eventually(fn, predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await fn();
    if (predicate(value)) return value;
    await delay(75);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function checkArtifact(meta, kind, mimeType, { artifactHome = home, profile = 'BROWSER1' } = {}) {
  assert.ok(meta, 'Expected finalized private artifact metadata');
  assert.match(meta.artifactId, /^[a-f0-9-]{36}$/);
  assert.equal(meta.kind, kind);
  assert.equal(meta.mimeType, mimeType);
  assert.equal(meta.profile, profile);
  assert.match(meta.projectId, /^[a-f0-9]{24}$/);
  assert.ok(Number.isInteger(meta.bytes) && meta.bytes > 0 && meta.bytes <= 64 * 1024 * 1024);
  assert.match(meta.sha256, /^[a-f0-9]{64}$/);
  const bytes = await fs.readFile(path.join(artifactHome, 'artifacts', meta.artifactId));
  assert.equal(bytes.length, meta.bytes);
  assert.equal(sha256(bytes), meta.sha256);
  assert.equal(JSON.stringify(meta).includes(artifactHome), false, 'Artifact metadata must not expose private paths');
  return bytes;
}

async function decodeFirstVideoFrame(meta) {
  const executable = path.join(env.PLAYWRIGHT_BROWSERS_PATH, 'ffmpeg-1013', process.platform === 'win32' ? 'ffmpeg-win64.exe' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux');
  const frame = path.join(root, `decoded-frame-${randomUUID()}.png`);
  try {
    const result = await runFile(executable, ['-hide_banner', '-nostdin', '-i', path.join(home, 'artifacts', meta.artifactId), '-map', '0:v:0', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', frame], { windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    outputs.push(result.stdout, result.stderr);
    const bytes = await fs.readFile(frame);
    assert.deepEqual(bytes.subarray(0, 8), pngSignature, 'ffmpeg must decode a real WebM frame to PNG');
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } finally { await fs.rm(frame, { force: true }); }
}

async function brokerRequest(route, body = {}, options = {}) {
  const broker = JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8'));
  const credential = await fs.readFile(path.join(home, 'broker.token'), 'utf8');
  assert.equal(/^[a-f0-9]{64}$/.test(credential), true, 'Broker credential must be 256 bits');
  const headers = {
    host: `127.0.0.1:${broker.port}`,
    'content-type': 'application/json',
    ...(options.auth === false ? {} : { authorization: `Bearer ${credential}` }),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: broker.port, path: route, method: options.method || 'POST', headers }, response => {
      let raw = '';
      response.setEncoding('utf8').on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        outputs.push(raw);
        try { resolve({ status: response.statusCode, body: JSON.parse(raw), headers: response.headers }); }
        catch { reject(new Error('Broker must return JSON')); }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('Broker HTTP probe timed out')));
    request.once('error', reject);
    request.end(JSON.stringify(body));
  });
}

function mcpSession(mode = 'full', binding = {}) {
  const child = spawn(commandExecutable, [...workerArgs, 'mcp', '--cwd', workspace, '--mode', mode, '--client', binding.clientId || 'test', '--profile', binding.profile || 'BROWSER1'], { cwd: runtime, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close').then(([code, signal]) => {
    children.delete(child);
    outputs.push(stdout, stderr);
    return { code, signal };
  });
  closed.catch(() => {});
  return {
    child, closed,
    send(value) { child.stdin.write(JSON.stringify(value) + '\n'); },
    messages() { return stdout.split(/\r?\n/).slice(0, -1).filter(Boolean).map(line => JSON.parse(line)); },
  };
}

async function initializeMcp(session) {
  session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration', version: '1' } } });
  const messages = await eventually(async () => session.messages(), values => values.some(value => value.id === 1), 'MCP adapter failed to initialize');
  assert.equal(messages.find(value => value.id === 1).result.protocolVersion, '2025-11-25');
}

async function mcpTool(session, id, name, args = {}) {
  session.send({ jsonrpc:'2.0', id, method:'tools/call', params:{name,arguments:args} });
  const messages = await eventually(async () => session.messages(), values => values.some(value => value.id === id), `MCP ${name} did not finish`, 35_000);
  const reply = messages.find(value => value.id === id);
  assert.equal(reply.error, undefined, `MCP ${name} failed at the transport boundary`);
  return reply.result;
}

async function gatedAction() {
  const gate = randomUUID(), operationId = randomUUID();
  const pending = call('browser_evaluate', { function:'async route => { await fetch(route); return "gate released"; }', arg:`/gate/${gate}` }, {operationId,timeoutMs:60_000});
  try { await eventually(async () => fixture.isGateHeld(gate), Boolean, 'Owner action never reached the loopback gate'); }
  catch (error) { fixture.releaseGate(gate); throw error; }
  return {gate,operationId,pending};
}

async function waitForReservation(operationId) {
  const file = path.join(home,'receipts',`${sha256(operationId)}.json`);
  return eventually(async () => {
    try { return JSON.parse(await fs.readFile(file,'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, value => value?.operationId === operationId, 'Queued operation never reached the real broker');
}

function concurrencyResult(scenario, result) {
  console.info(`TREX_CONCURRENCY_RESULT ${JSON.stringify({scenario,...result})}`);
}

async function receiptNames() { return new Set(await fs.readdir(path.join(home, 'receipts'))); }
async function waitForNewWaitReceipt(previous) {
  return eventually(async () => {
    for (const name of await fs.readdir(path.join(home, 'receipts'))) {
      if (previous.has(name)) continue;
      const receipt = JSON.parse(await fs.readFile(path.join(home, 'receipts', name), 'utf8'));
      if (receipt.name === 'browser_wait_for' && receipt.profile === 'BROWSER1') return receipt;
    }
  }, Boolean, 'MCP wait operation was not dispatched');
}

async function windowsProcesses(mode, ids) {
  if (!ids.length) return [];
  assert.ok(ids.every(pid => Number.isSafeInteger(pid) && pid > 0), 'Process queries require exact positive PIDs');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('./fixtures/owned-processes.ps1', import.meta.url));
  const result = await runFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode, '-ProcessIds', [...new Set(ids)].join(',')], { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  const records = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
  assert.ok(Array.isArray(records), 'Scoped process query must return an array');
  return records;
}

const windowsPath = value => String(value || '').replaceAll('/', '\\').toLowerCase();
const sameProcess = (left, right) => !!left && !!right && left.pid === right.pid && left.createdAt === right.createdAt && windowsPath(left.executablePath) === windowsPath(right.executablePath);
const originalProcessMayBeAlive = (original, current) => !!current && original.pid === current.pid && (!current.createdAt || original.createdAt === current.createdAt) && (!current.executablePath || windowsPath(original.executablePath) === windowsPath(current.executablePath));

async function assertProcessesAlive(records, message) {
  const current = new Map((await windowsProcesses('identities', records.map(item => item.pid))).map(item => [item.pid, item]));
  assert.ok(records.every(item => sameProcess(item, current.get(item.pid))), message);
}

async function waitForProcessesExit(records, message, timeoutMs = 20_000) {
  await eventually(async () => {
    const current = new Map((await windowsProcesses('identities', records.map(item => item.pid))).map(item => [item.pid, item]));
    return records.filter(item => originalProcessMayBeAlive(item, current.get(item.pid)));
  }, alive => alive.length === 0, message, timeoutMs);
}

async function ownedBrowserProcesses(brokerHome, projectId, profiles) {
  const broker = JSON.parse(await fs.readFile(path.join(brokerHome, 'broker.json'), 'utf8'));
  const [identity] = await windowsProcesses('identities', [broker.pid]);
  assert.ok(identity?.createdAt && identity.executablePath, 'Must identify the exact private broker before inspecting children');
  assert.ok(identity.commandLine?.includes('worker.mjs') && /\bdaemon\b/.test(identity.commandLine), 'Recorded broker PID must belong to this worker daemon');
  const direct = await windowsProcesses('children', [broker.pid]);
  const browsers = new Map();
  const guards = new Map();
  for (const profile of profiles) {
    const dataDir = windowsPath(path.join(brokerHome, 'projects', projectId, profile, 'user-data'));
    const roots = direct.filter(item => item.parentPid === broker.pid && item.name?.toLowerCase() === 'chrome.exe' && windowsPath(item.commandLine).includes(dataDir) && !/(?:^|\s)--type(?:=|\s)/.test(item.commandLine));
    assert.equal(roots.length, 1, `Expected one Chrome root owned by this broker for ${profile}`);
    assert.ok(roots[0].executablePath && roots[0].createdAt, 'Chrome identity must include executable and creation time');
    browsers.set(profile, roots[0]);
    const helpers = direct.filter(item => item.parentPid === broker.pid && /(?:^|\s)__guard-browser(?:\s|$)/.test(item.commandLine || '') && new RegExp(`--pid\\s+"?${roots[0].pid}"?(?:\\s|$)`).test(item.commandLine));
    assert.equal(helpers.length, 1, `Expected one native guard for owned ${profile}`);
    assert.ok(helpers[0].executablePath && helpers[0].createdAt, 'Guard identity must include executable and creation time');
    assert.equal(helpers[0].name.toLowerCase(), 'trex-browser.exe');
    assert.ok(windowsPath(helpers[0].commandLine).includes(windowsPath(roots[0].executablePath)), 'Guard must name the exact owned Chrome executable');
    guards.set(profile, helpers[0]);
  }
  return { broker: identity, browsers, guards };
}

async function ownedChromeTree(roots) {
  const records = [...roots];
  let frontier = [...roots];
  for (let depth = 0; frontier.length && depth < 8; depth++) {
    const children = await windowsProcesses('children', frontier.map(item => item.pid));
    assert.ok(children.every(item => item.name?.toLowerCase() !== 'chrome.exe' || item.executablePath && item.createdAt), 'Owned Chrome descendants require complete identity before crash');
    frontier = children.filter(item => roots.some(root => windowsPath(item.executablePath) === windowsPath(root.executablePath)) && !records.some(known => sameProcess(known, item)));
    records.push(...frontier);
    assert.ok(records.length <= 128, 'Owned test Chrome process tree must stay bounded');
  }
  assert.equal(frontier.length, 0, 'Owned Chrome tree exceeded bounded traversal depth');
  return records;
}

describe('real Trex browser worker on isolated loopback fixtures', { concurrency: false, timeout: 900_000 }, () => {
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'trex-browser-integration-'));
    home = path.join(root, 'private-home');
    workspace = path.join(root, 'workspace');
    otherWorkspace = path.join(root, 'other-workspace');
    await Promise.all([workspace, otherWorkspace].map(dir => fs.mkdir(dir)));
    env = { ...process.env, TREX_BROWSER_HOME: home, TREX_BROWSER_DEV: '1', TREX_BROWSER_HEADLESS: '1',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(runtime, 'runtime', 'ffmpeg') };
    delete env.TREX_BROWSER_LAUNCHER;
    delete env.TREX_BROWSER_NATIVE_VERIFIED;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    if (nativeExecutable) delete env.TREX_BROWSER_DEV;
    fixture = await startBrowserFixture();
    await fs.writeFile(path.join(workspace, 'upload.txt'), 'workspace upload fixture\n');
    await fs.writeFile(path.join(root, 'outside.txt'), 'outside workspace\n');
  });

  after(async () => {
    try {
      // The secret is inspected only in the test process and never printed.
      let credential;
      try { credential = await fs.readFile(path.join(home, 'broker.token'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (credential) {
        for (const output of outputs) assert.equal(output.includes(credential), false, 'Worker output/log exposed the broker credential');
        const receipts = await fs.readdir(path.join(home, 'receipts'));
        for (const name of receipts) {
          const raw = await fs.readFile(path.join(home, 'receipts', name), 'utf8');
          assert.equal(raw.includes(credential), false, 'Operation receipt exposed the broker credential');
          const receipt = JSON.parse(raw);
          assert.equal('arguments' in receipt, false, 'Receipts must not persist tool inputs');
          assert.equal('data' in receipt, false, 'Receipts must not persist page output');
        }
      }
    } finally {
      // No --cwd: stop the detached broker, not merely the current profile.
      try {
        let broker;
        if (home) {
          try { broker = JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (env) await cli(['stop', '--json']);
        if (broker) await eventually(async () => {
          try { process.kill(broker.pid, 0); return false; }
          catch (error) { if (error.code === 'ESRCH') return true; throw error; }
        }, Boolean, 'Detached broker failed to stop', 25_000);
      } finally {
        for (const child of children) child.kill();
        if (fixture) await fixture.close();
        if (root) {
          const resolved = await fs.realpath(root), temporary = await fs.realpath(os.tmpdir());
          assert.equal(path.dirname(resolved), temporary, 'Cleanup must stay in the isolated temporary parent');
          assert.match(path.basename(resolved), /^trex-browser-integration-/);
          await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      }
    }
  });

  it('doctor and tools describe installed capabilities without starting a broker or browser', async () => {
    const doctor = await cli(['doctor', '--json']);
    assert.equal(doctor.browser.available, true, 'Integration tests require installed Chrome/Edge');
    assert.equal(doctor.runtime.playwrightVersion, '1.64.1');
    assert.equal(doctor.capabilities.authenticatedBroker, true);
    assert.equal(doctor.capabilities.video, true);
    const full = (await cli(['tools', '--json', '--mode', 'full'])).tools;
    const qa = (await cli(['tools', '--json', '--mode', 'qa'])).tools;
    const observe = (await cli(['tools', '--json', '--mode', 'observe'])).tools;
    assert.deepEqual(qa.map(tool => tool.name), full.map(tool => tool.name));
    for (const name of ['browser_start_video', 'browser_stop_video', 'browser_perf_start', 'browser_perf_stop', 'browser_cpu_profile_start', 'browser_heap_snapshot']) assert.ok(full.some(tool => tool.name === name), name);
    for (const name of ['browser_click', 'browser_evaluate', 'browser_file_upload', 'browser_mouse', 'browser_emulate']) assert.equal(observe.some(tool => tool.name === name), false, name);
    assert.ok(observe.every(tool => tool.annotations.readOnlyHint));
    await assert.rejects(fs.access(path.join(home, 'broker.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(home, 'projects')), { code: 'ENOENT' });
  });

  it('status and profile management start no browser', async () => {
    const status = success(await cli(['status', '--cwd', workspace, '--mode', 'full', '--client', 'test', '--profile', 'BROWSER1']));
    assert.equal(status.data.running, false);
    assert.equal(status.data.tabs, 0);
    const args = ['--cwd', workspace, '--mode', 'full', '--client', 'test', '--profile', 'BROWSER1', '--json'];
    assert.deepEqual((await cli(['profiles', 'list', ...args])).profiles, []);
    const profiles = (await cli(['profiles', 'create', ...args])).profiles;
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, 'BROWSER1');
    await assert.rejects(fs.access(path.join(home, 'projects', status.projectId, 'BROWSER1', 'user-data')), { code: 'ENOENT' });
    assert.equal((await ok('browser_status')).data.running, false);
  });

  it('broker enforces exact Host, absent Origin, POST, JSON and bearer authorization', async () => {
    const valid = await brokerRequest('/health');
    assert.equal(valid.status, 200);
    assert.equal(valid.body.ok, true);
    assert.equal(valid.headers['cache-control'], 'no-store');
    const probes = [
      { auth: false },
      { headers: { authorization: 'Bearer ' + '0'.repeat(64) } },
      { headers: { authorization: 'Bearer short' } },
      { headers: { authorization: 'Bearer ' + '\u00e9' + 'a'.repeat(63) } },
      { headers: { host: 'localhost' } },
      { headers: { host: 'attacker.invalid' } },
      { headers: { origin: fixture.url } },
      { headers: { origin: 'null' } },
      { headers: { 'content-type': 'text/plain' } },
      { headers: { 'content-type': 'application/json; charset=utf-8' } },
      { method: 'GET' },
    ];
    for (const probe of probes) {
      const result = await brokerRequest('/health', {}, probe);
      assert.equal(result.status, 403, 'Malformed broker request must be forbidden');
      assert.deepEqual(result.body, { error: 'Forbidden' });
      assert.equal((await brokerRequest('/health')).status, 200, 'Rejected auth must leave broker alive');
    }
    assert.equal((await brokerRequest('/not-a-route')).status, 404);
    const grant = await brokerRequest('/grant', callInput('browser_status'));
    assert.equal(grant.status, 200);
    const payload = { grantId: grant.body.grantId, name: 'browser_status', arguments: {}, operationId: randomUUID(), timeoutMs: 1000 };
    success((await brokerRequest('/call', payload)).body);
    const replay = await brokerRequest('/call', payload);
    assert.equal(replay.status, 400, 'Broker grants must be consumed exactly once');
    assert.match(replay.body.error, /Grant expired/);
  });

  it('navigates, snapshots refs and rejects stale revisions before page mutation', async () => {
    await navigate();
    const snapshot = await ok('browser_snapshot');
    assert.equal(snapshot.data.url, `${fixture.url}/`);
    assert.equal(snapshot.data.untrustedContent, true);
    assert.equal(snapshot.data.revision, snapshot.revision);
    assert.match(snapshot.data.accessibility, /Trex local integration fixture/);
    const button = snapshot.data.elements.find(element => element.name === 'Increment counter');
    assert.ok(button?.ref, 'Snapshot must expose a real button reference');
    const clicked = await ok('browser_click', { ref: button.ref, revision: snapshot.revision });
    assert.ok(clicked.revision > snapshot.revision);
    failure(await call('browser_click', { ref: button.ref, revision: snapshot.revision }), 'STALE_SNAPSHOT');
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '1');
    const fresh = await ok('browser_snapshot');
    assert.equal(Number.isInteger(fresh.revision), true);
  });

  it('fills forms, presses keys, selects options and uploads only workspace files', async () => {
    await navigate();
    await ok('browser_type', { selector: '#name', text: 'Ada local' });
    await ok('browser_fill_form', { fields: [{ selector: '#notes', value: 'Fixture notes' }, { selector: '#agree', value: true }] });
    await ok('browser_select_option', { selector: '#color', values: ['blue'] });
    await ok('browser_file_upload', { selector: '#upload', paths: ['upload.txt'] });
    assert.deepEqual(await evaluate(async () => ({ name: document.querySelector('#name').value, notes: document.querySelector('#notes').value, agree: document.querySelector('#agree').checked, color: document.querySelector('#color').value, filename: document.querySelector('#upload').files[0].name, contents: await document.querySelector('#upload').files[0].text() })), {
      name: 'Ada local', notes: 'Fixture notes', agree: true, color: 'blue', filename: 'upload.txt', contents: 'workspace upload fixture\n',
    });
    await ok('browser_click', { selector: '#name' });
    await ok('browser_press_key', { key: 'End' });
    await ok('browser_press_key', { key: 'Enter' });
    await ok('browser_wait_for', { text: 'Submitted Ada local', time: 3 });
    failure(await call('browser_file_upload', { selector: '#upload', paths: [path.join(root, 'outside.txt')] }), 'BROWSER_ERROR', /outside workspace/);
    failure(await call('browser_file_upload', { selector: '#upload', paths: ['..' + path.sep + 'outside.txt'] }), 'BROWSER_ERROR', /outside workspace/);
    assert.equal(await evaluate(() => document.querySelector('#upload').files[0].name), 'upload.txt');
  });

  it('controls hover, drag, low-level pointer input and wheel', async () => {
    await ok('browser_navigate',{url:`${fixture.url}/controls`});
    await ok('browser_hover',{selector:'#hover-target'});
    assert.equal(await evaluate(()=>document.querySelector('#hover-state').textContent),'Hovered');
    await ok('browser_drag',{source:{selector:'#drag-source'},destination:{selector:'#drag-target'}});
    assert.equal(await evaluate(()=>document.querySelector('#drag-target').textContent),'Dropped fixture payload');
    const point=await evaluate(()=>{const r=document.querySelector('#low-click').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
    await ok('browser_mouse',{action:'move',...point,steps:5});
    await ok('browser_mouse',{action:'down',button:'left'});
    await ok('browser_mouse',{action:'up',button:'left'});
    assert.equal(await evaluate(()=>document.querySelector('#low-count').textContent),'1');
    await ok('browser_mouse',{action:'click',...point,button:'left'});
    assert.equal(await evaluate(()=>document.querySelector('#low-count').textContent),'2');
    const scroll=await evaluate(()=>{const r=document.querySelector('#scroll-panel').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
    await ok('browser_mouse',{action:'move',...scroll});
    await ok('browser_mouse',{action:'wheel',deltaY:280,deltaX:0});
    await ok('browser_wait_for',{text:'Scrolled',time:3});
    assert.ok(await evaluate(()=>document.querySelector('#scroll-panel').scrollTop>0));
  });

  it('emulates color scheme, CPU, network throttling and offline mode together', async () => {
    await ok('browser_navigate',{url:`${fixture.url}/controls`});
    const before=await ok('browser_tabs',{action:'list'}),first=before.data.tabs.find(tab=>tab.selected).tabId;
    let second;
    const probe=tabId=>ok('browser_evaluate',{tabId,function:'async()=>{const online=navigator.onLine;try{await fetch("/api/echo");return {online,fetchSucceeded:true};}catch{return {online,fetchSucceeded:false};}}'});
    try {
      await ok('browser_emulate',{colorScheme:'dark',cpuRate:2,latency:15,downloadThroughput:1_000_000,uploadThroughput:1_000_000});
      assert.equal(await evaluate(()=>matchMedia('(prefers-color-scheme: dark)').matches),true);
      const added=await ok('browser_tabs',{action:'new',url:`${fixture.url}/controls`});
      second=added.data.tabs.find(tab=>!before.data.tabs.some(old=>old.tabId===tab.tabId)).tabId;
      await ok('browser_emulate',{tabId:second,latency:25});
      await ok('browser_emulate',{tabId:first,offline:true});
      for(const tabId of [first,second])assert.deepEqual((await probe(tabId)).data.value,{online:false,fetchSucceeded:false},'Offline mode must override earlier throttling on every affected tab');
      await ok('browser_emulate',{tabId:second,uploadThroughput:9000});
      assert.deepEqual((await probe(second)).data.value,{online:false,fetchSucceeded:false},'A partial throttle update must preserve offline mode');
    } finally {
      await ok('browser_emulate',{tabId:first,colorScheme:'light',offline:false,cpuRate:1,latency:0,downloadThroughput:-1,uploadThroughput:-1});
      if(second){assert.deepEqual((await probe(second)).data.value,{online:true,fetchSucceeded:true});await ok('browser_tabs',{action:'close',tabId:second});}
    }
    assert.deepEqual((await probe(first)).data.value,{online:true,fetchSucceeded:true});
  });

  it('addresses iframe elements with frameId and manages tabs and history', async () => {
    await navigate();
    const frames = (await ok('browser_frames')).data.frames;
    assert.ok(frames.some(frame => frame.main));
    const frame = frames.find(item => item.name === 'fixture-frame');
    assert.ok(frame?.frameId);
    const frameSnapshot = await ok('browser_snapshot', { frameId: frame.frameId });
    const button = frameSnapshot.data.elements.find(item => item.name === 'Frame action');
    await ok('browser_click', { frameId: frame.frameId, ref: button.ref, revision: frameSnapshot.revision });
    assert.equal((await ok('browser_evaluate', { frameId: frame.frameId, function: '() => document.querySelector("#frame-button").textContent' })).data.value, 'Frame clicked');
    const initial = (await ok('browser_tabs', { action: 'list' })).data.tabs;
    const original = initial.find(tab => tab.selected).tabId;
    const created = (await ok('browser_tabs', { action: 'new', url: `${fixture.url}/next` })).data.tabs;
    const extra = created.find(tab => tab.selected);
    assert.equal(created.length, initial.length + 1);
    assert.equal(extra.url, `${fixture.url}/next`);
    await ok('browser_tabs', { action: 'select', tabId: original });
    await ok('browser_tabs', { action: 'close', tabId: extra.tabId });
    await ok('browser_click', { selector: '#next' });
    await ok('browser_wait_for', { text: 'next fixture', time: 3 });
    assert.equal((await ok('browser_navigate_back')).data.url, `${fixture.url}/`);
    assert.equal((await ok('browser_reload')).data.url, `${fixture.url}/`);
  });

  it('reads console events and bounded network bodies, installs and clears URL mocks', async () => {
    await navigate();
    const response = await evaluate(async () => {
      console.warn('fixture console sentinel');
      const response = await fetch('/api/echo', { method: 'POST', body: 'fixture request payload' });
      return response.json();
    });
    assert.deepEqual(response, { source: 'loopback', method: 'POST', body: 'fixture request payload' });
    const events = (await ok('browser_console_messages', { limit: 300 })).data.events;
    assert.ok(events.some(event => event.text === 'fixture console sentinel'));
    const requests = (await ok('browser_network_requests')).data.requests;
    const request = requests.findLast(item => item.url === `${fixture.url}/api/echo`);
    assert.ok(request?.requestId);
    assert.equal(request.status, 200);
    const requestBody = await ok('browser_network_body', { requestId: request.requestId, kind: 'request' });
    assert.equal(requestBody.data.body, 'fixture request payload');
    const body = await ok('browser_network_body', { requestId: request.requestId, kind: 'response' });
    assert.equal(body.data.untrustedContent, true);
    assert.deepEqual(JSON.parse(body.data.body), response);
    assert.equal(body.data.bytes, Buffer.byteLength(body.data.body));
    const countBeforeMock = fixture.requests.filter(item => item.pathname === '/api/echo').length;
    await ok('browser_route', { action: 'add', url: `${fixture.url}/api/echo`, status: 201, contentType: 'application/json', body: '{"mocked":true}' });
    try {
      assert.deepEqual(await evaluate(async () => { const r = await fetch('/api/echo'); return { status: r.status, body: await r.json() }; }), { status: 201, body: { mocked: true } });
      assert.equal(fixture.requests.filter(item => item.pathname === '/api/echo').length, countBeforeMock);
    } finally { await ok('browser_route', { action: 'clear' }); }
    assert.equal((await evaluate(async () => (await fetch('/api/echo')).json())).source, 'loopback');
  });

  it('accepts page dialogs and finalizes a real download as a private artifact', async () => {
    await navigate();
    await evaluate(() => { setTimeout(() => alert('Loopback fixture alert'), 50); return true; });
    await delay(150);
    await ok('browser_handle_dialog', { accept: true });
    await ok('browser_click', { selector: '#download' });
    const events = await eventually(async () => (await ok('browser_console_messages', { limit: 300 })).data.events, values => values.some(value => value.kind === 'download'), 'Download artifact was not finalized');
    const meta = events.findLast(event => event.kind === 'download').artifact;
    assert.equal(meta.suggestedFilename, 'fixture.txt');
    assert.deepEqual(await checkArtifact(meta, 'download', 'application/octet-stream'), downloadBytes);
    assert.equal((await ok('browser_status')).data.running, true);
  });

  it('handles a synchronous alert while browser_evaluate is still pending', { timeout: 60_000 }, async () => {
    await navigate();
    const operationId = randomUUID();
    const pending = launch(['call', '--stdin-json'], callInput('browser_evaluate', { function: '() => { alert("Synchronous loopback alert"); return "alert accepted"; }' }, { operationId, timeoutMs: 40_000 }));
    let handled = false;
    try {
      const dialog = await eventually(async () => (await ok('browser_status')).data.dialog, Boolean, 'Synchronous alert was not observable while evaluation was pending');
      assert.equal(dialog.type, 'alert');
      assert.equal(dialog.message, 'Synchronous loopback alert');
      assert.equal(dialog.untrustedContent, true);
      failure(await call('browser_handle_dialog', { accept: true }, { clientId: 'foreign-dialog-client' }), 'OWNERSHIP');
      assert.equal((await ok('browser_handle_dialog', { accept: true })).data.handled, true);
      handled = true;
      const result = await pending.result;
      assert.equal(result.code, 0);
      assert.equal(success(JSON.parse(result.stdout)).data.value, 'alert accepted');
      assert.equal((await ok('browser_status')).data.paused, false);
    } finally {
      if (!handled) {
        await call('browser_handle_dialog', { accept: true }, { timeoutMs: 3_000 });
        await pending.result;
      }
    }
  });

  it('waits for the requested role and never matches an absent role against the body', async () => {
    await navigate();
    failure(await call('browser_wait_for', { role: 'button', name: 'Absent loopback action', time: 0.3 }, { timeoutMs: 5_000 }), 'BROWSER_ERROR', /Wait timed out/);
    assert.equal((await ok('browser_wait_for', { role: 'button', name: 'Increment counter', time: 2 })).data.matched, true);
    const snapshot = await ok('browser_snapshot');
    const button = snapshot.data.elements.find(element => element.name === 'Increment counter');
    assert.equal((await ok('browser_wait_for', { ref: button.ref, revision: snapshot.revision, time: 1 })).data.matched, true);
    failure(await call('browser_wait_for', { time: 1000 }), 'BROWSER_ERROR', /outside permitted range/);
    assert.equal((await ok('browser_status')).data.paused, false);
  });

  it('rejects a malformed second form field before mutating the first field', async () => {
    await navigate();
    failure(await call('browser_fill_form', { fields: [{ selector: '#name', value: 'must not be applied' }, { selector: '#notes' }] }), 'BROWSER_ERROR', /Missing .*value/);
    assert.deepEqual(await evaluate(() => [document.querySelector('#name').value, document.querySelector('#notes').value]), ['', '']);
    failure(await call('browser_fill_form', { fields: [{ selector: '#name', value: 'must not be applied' }, { selector: '#notes', value: 'notes', unsupported: true }] }), 'POLICY_DENIED');
    assert.deepEqual(await evaluate(() => [document.querySelector('#name').value, document.querySelector('#notes').value]), ['', '']);
  });

  it('returns PNG/JPEG image bytes and checksum-verified private screenshot artifacts', async () => {
    await navigate();
    await ok('browser_resize', { width: 640, height: 480 });
    try {
      const result = await call('browser_take_screenshot', { type: 'png' });
      const content = success(result);
      const meta = content.artifacts[0];
      assert.equal(meta.width, 640);
      assert.equal(meta.height, 480);
      const bytes = await checkArtifact(meta, 'screenshot', 'image/png');
      assert.deepEqual(bytes.subarray(0, 8), pngSignature);
      assert.equal(bytes.readUInt32BE(16), meta.width);
      assert.equal(bytes.readUInt32BE(20), meta.height);
      const image = result.content.find(item => item.type === 'image');
      assert.equal(image.mimeType, 'image/png');
      assert.deepEqual(Buffer.from(image.data, 'base64'), bytes);
      const read = await call('browser_artifact', { artifactId: meta.artifactId, read: true });
      success(read);
      assert.deepEqual(Buffer.from(read.content.find(item => item.type === 'image').data, 'base64'), bytes);
      const cropped = await ok('browser_take_screenshot', { clip: { x: 0, y: 0, width: 160, height: 120 } });
      assert.equal(cropped.artifacts[0].width, 160);
      assert.equal(cropped.artifacts[0].height, 120);
      const jpegResult = await call('browser_take_screenshot', { type: 'jpeg', quality: 60 });
      const jpegMeta = success(jpegResult).artifacts[0];
      const jpeg = await checkArtifact(jpegMeta, 'screenshot', 'image/jpeg');
      assert.deepEqual(jpeg.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
      assert.deepEqual(Buffer.from(jpegResult.content.find(item => item.type === 'image').data, 'base64'), jpeg);
      failure(await call('browser_artifact', { artifactId: meta.artifactId }, { cwd: otherWorkspace }), 'BROWSER_ERROR', /not found/);
      failure(await call('browser_artifact', { artifactId: meta.artifactId }, { profile: 'BROWSER2' }), 'BROWSER_ERROR', /not found/);
      failure(await call('browser_artifact', { artifactId: '../broker.token', read: true }), 'BROWSER_ERROR', /Invalid artifact ID/);
    } finally { await ok('browser_resize', { width: 1280, height: 800 }); }
  });

  it('detects private artifact tampering instead of returning modified bytes', async () => {
    const meta = (await ok('browser_take_screenshot')).artifacts[0];
    const file = path.join(home, 'artifacts', meta.artifactId);
    const original = await fs.readFile(file);
    const altered = Buffer.from(original);
    altered[altered.length - 1] ^= 1;
    await fs.writeFile(file, altered);
    try { failure(await call('browser_artifact', { artifactId: meta.artifactId, read: true }), 'BROWSER_ERROR', /integrity mismatch/); }
    finally { await fs.writeFile(file, original); }
  });

  it('finalizes on-demand WebM while keeping the persistent browser and page alive', async () => {
    await navigate();
    const started = await ok('browser_start_video', { maxDurationMs: 120_000 });
    assert.equal(started.data.kind, 'video');
    assert.equal(started.data.recording, true);
    try {
      assert.equal((await ok('browser_status')).data.capture.kind, 'video');
      failure(await call('browser_start_trace'), 'BROWSER_ERROR', /Capture video is active/);
      await ok('browser_click', { selector: '#increment' });
      await ok('browser_wait_for', { time: 1.2 });
    } finally {
      const stopped = await ok('browser_stop_video', {}, { timeoutMs: 60_000 });
      assert.equal(stopped.data.finalized, true);
      const meta = stopped.artifacts[0];
      const bytes = await checkArtifact(meta, 'video', 'video/webm');
      assert.deepEqual(bytes.subarray(0, 4), ebmlSignature, 'Video must contain a real EBML WebM header');
      assert.ok(bytes.length > 1024, 'Video must contain encoded frames');
      assert.ok(bytes.subarray(0, 256).includes(Buffer.from('webm')), 'EBML document type must be WebM');
      assert.ok(meta.durationMs > 0);
      assert.equal(meta.width, 1280);
      assert.equal(meta.height, 800);
    }
    const status = await ok('browser_status');
    assert.equal(status.data.running, true);
    assert.equal(status.data.capture, null);
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '1');
    await ok('browser_click', { selector: '#increment' });
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '2');
  });

  it('preserves video dimensions from capture start after resizing the live viewport', { timeout: 90_000 }, async () => {
    await navigate();
    await ok('browser_resize', { width: 640, height: 480 });
    let recording = false;
    let meta;
    try {
      await ok('browser_start_video', { maxDurationMs: 120_000 });
      recording = true;
      await ok('browser_wait_for', { time: 0.5 });
      await ok('browser_resize', { width: 1280, height: 800 });
      await ok('browser_click', { selector: '#increment' });
      await ok('browser_wait_for', { time: 0.5 });
    } finally {
      try {
        if (recording) meta = (await ok('browser_stop_video', {}, { timeoutMs: 60_000 })).artifacts[0];
      } finally { await ok('browser_resize', { width: 1280, height: 800 }); }
    }
    const bytes = await checkArtifact(meta, 'video', 'video/webm');
    assert.deepEqual(bytes.subarray(0, 4), ebmlSignature);
    assert.equal(meta.width, 640);
    assert.equal(meta.height, 480);
    assert.deepEqual(await decodeFirstVideoFrame(meta), { width: 640, height: 480 });
    assert.deepEqual(await evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 1280, height: 800 });
    assert.equal((await ok('browser_status')).data.running, true);
  });

  it('finalizes a Playwright trace ZIP without closing Chrome', async () => {
    await navigate();
    await ok('browser_start_trace');
    try {
      await ok('browser_click', { selector: '#increment' });
      await ok('browser_snapshot');
    } finally {
      const stopped = await ok('browser_stop_trace', {}, { timeoutMs: 60_000 });
      const bytes = await checkArtifact(stopped.artifacts[0], 'trace', 'application/zip');
      assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      assert.ok(bytes.includes(Buffer.from('trace.trace')), 'ZIP must contain a Playwright trace entry');
    }
    assert.equal((await ok('browser_status')).data.running, true);
  });

  it('exports actual Chromium raw performance and CPU profiles', async () => {
    await navigate();
    await ok('browser_perf_start');
    try { await evaluate(() => { performance.mark('trex-fixture-mark'); document.querySelector('#increment').click(); return true; }); }
    finally {
      const stopped = await ok('browser_perf_stop', {}, { timeoutMs: 60_000 });
      const bytes = await checkArtifact(stopped.artifacts[0], 'perf', 'application/json');
      const trace = JSON.parse(bytes.toString('utf8'));
      assert.ok(Array.isArray(trace.traceEvents) && trace.traceEvents.length > 0);
      assert.ok(trace.traceEvents.some(event => event.name === 'trex-fixture-mark'));
    }
    await ok('browser_cpu_profile_start');
    try { await evaluate(() => { const until = performance.now() + 180; let total = 0; while (performance.now() < until) total += Math.sqrt(total + 1); return total; }); }
    finally {
      const stopped = await ok('browser_cpu_profile_stop', {}, { timeoutMs: 60_000 });
      const profile = JSON.parse((await checkArtifact(stopped.artifacts[0], 'cpu', 'application/json')).toString('utf8'));
      assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0);
      assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0);
      assert.ok(profile.endTime > profile.startTime);
    }
    assert.equal((await ok('browser_status')).data.capture, null);
  });

  it('captures a bounded real heap snapshot', { timeout: 90_000 }, async () => {
    await navigate();
    const sentinel = `trex-heap-fixture-${randomUUID()}`;
    await evaluate(value => { globalThis.__trexHeapSentinel = value; return true; }, sentinel);
    const result = await ok('browser_heap_snapshot', {}, { timeoutMs: 60_000 });
    const heap = JSON.parse((await checkArtifact(result.artifacts[0], 'heap', 'application/json')).toString('utf8'));
    assert.ok(heap.snapshot.meta.node_fields.includes('type'));
    assert.ok(heap.nodes.length > 0);
    assert.ok(heap.strings.includes(sentinel), 'Heap must include the retained page JavaScript sentinel');
    assert.equal((await ok('browser_status')).data.capture, null);
  });

  it('observe mode denies mutations even when the full-mode owner already has Chrome open', async () => {
    await navigate();
    const denied = [
      ['browser_click', { selector: '#increment' }],
      ['browser_evaluate', { function: '() => { document.body.textContent = "denied"; }' }],
      ['browser_file_upload', { selector: '#upload', paths: ['upload.txt'] }],
      ['browser_mouse', { action: 'click', x: 20, y: 20 }],
      ['browser_emulate', { offline: true, cpuRate: 10 }],
      ['browser_type', { selector: '#name', text: 'denied' }],
      ['browser_tabs', { action: 'new', url: `${fixture.url}/next` }],
      ['browser_start_video', {}],
    ];
    for (const [name, args] of denied) failure(await call(name, args, { mode: 'observe' }), 'POLICY_DENIED');
    assert.equal((await ok('browser_snapshot', {}, { mode: 'observe' })).data.untrustedContent, true);
    assert.equal((await ok('browser_take_screenshot', {}, { mode: 'observe' })).artifacts[0].kind, 'screenshot');
    assert.equal((await ok('browser_tabs', { action: 'list' }, { mode: 'observe' })).data.tabs.length, 1);
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '0');
    failure(await call('browser_click', { selector: '#increment', mode: 'full' }, { mode: 'observe' }), 'POLICY_DENIED');
    assert.equal(await evaluate(() => typeof process), 'undefined', 'Evaluation must run in the page, not Node');
    assert.equal(await evaluate(() => document.title, undefined, { mode: 'qa' }), 'Trex loopback fixture');
  });

  it('rejects unsupported arguments, unsafe URLs and replays of a completed operation', async () => {
    failure(await call('browser_type', { selector: '#name', text: 'x', cwd: root }), 'POLICY_DENIED');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', `http://user:password@127.0.0.1:${new URL(fixture.url).port}/`]) failure(await call('browser_navigate', { url }), 'BROWSER_ERROR', /http\(s\)/);
    const operationId = randomUUID();
    await ok('browser_click', { selector: '#increment' }, { operationId });
    failure(await call('browser_click', { selector: '#increment' }, { operationId }), 'DUPLICATE_OPERATION');
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '1');
  });

  it('cancels exactly the matching client/project/profile read without pausing controls', { timeout: 45_000 }, async () => {
    await navigate();
    const operationId = randomUUID();
    const pending = launch(['call', '--stdin-json'], callInput('browser_wait_for', { time: 30 }, { operationId, timeoutMs: 40_000 }));
    await delay(500);
    // A status probe queues behind the wait; cancellation has its own unqueued path.
    for (const override of [{ clientId: 'another-client' }, { profile: 'BROWSER2' }, { cwd: otherWorkspace }]) failure(await call('browser_cancel', { operationId }, override), 'BROWSER_ERROR', /not found/);
    const started = Date.now();
    const cancelled = await eventually(() => call('browser_cancel', { operationId }), result => result.structuredContent?.ok === true, 'Matching cancellation was not accepted', 4_000);
    assert.equal(success(cancelled).data.cancelRequested, true);
    const raw = await pending.result;
    assert.equal(raw.code, 0);
    const interrupted = failure(JSON.parse(raw.stdout), 'CANCELLED');
    assert.deepEqual(interrupted.receipt, { status: 'cancelled', manualReview: false, replaySafe: false });
    assert.ok(Date.now() - started < 5_000, 'Cancellation must interrupt rather than wait 30 seconds');
    assert.equal((await ok('browser_status')).data.paused, false);
    await ok('browser_click', { selector: '#increment' });
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '1');
  });

  it('observation timeout leaves browser controls available without manual review', async () => {
    const result = await call('browser_wait_for', { time: 30 }, { timeoutMs: 300 });
    const interrupted = failure(result, 'READ_TIMEOUT');
    assert.equal(interrupted.receipt.manualReview, false);
    assert.equal((await ok('browser_status')).data.paused, false);
    assert.equal((await ok('browser_snapshot')).data.untrustedContent, true);
  });

  it('uncertain pending page action keeps screenshots available and recovers without replay', async () => {
    await navigate();
    const result = await call('browser_evaluate', { function: '() => { document.querySelector("#count").textContent = "1"; return new Promise(() => {}); }' }, { timeoutMs: 500 });
    const interrupted = failure(result, 'UNCERTAIN');
    assert.equal(interrupted.receipt.manualReview, true);
    const status = (await ok('browser_status')).data;
    assert.equal(status.paused, true);
    assert.equal(status.pauseReason, 'uncertain');
    assert.equal(status.pauseOperation.tool, 'browser_evaluate');
    assert.equal((await ok('browser_take_screenshot', {}, { mode: 'observe' })).artifacts[0].kind, 'screenshot');
    assert.equal((await ok('browser_snapshot', {}, { mode: 'observe' })).data.untrustedContent, true);
    failure(await call('browser_resume'), 'RECOVERY_PENDING');
    const replacement = { clientId: 'replacement-owner' };
    failure(await call('browser_take_screenshot', {}, replacement), 'OWNERSHIP');
    const taken = await ok('browser_takeover', {}, replacement);
    assert.equal(taken.data.paused, true);
    assert.equal(taken.data.pendingAction.cancelRequested, true);
    failure(await call('browser_resume', {}, replacement), 'RECOVERY_PENDING');
    await ok('browser_close', {}, replacement);
    assert.equal((await ok('browser_status')).data.running, false);
    await ok('browser_takeover');
    await navigate();
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '0');
    await ok('browser_click', { selector: '#increment' });
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '1');
  });

  it('independent clients cannot create a tab or steal control while the profile owner is working', {timeout:90_000}, async () => {
    await navigate();
    const before=await ok('browser_tabs',{action:'list'}), action=await gatedAction();
    try {
      const started=performance.now();
      failure(await call('browser_tabs',{action:'new',url:`${fixture.url}/next`},{clientId:'parallel-foreign'}),'OWNERSHIP');
      const rejectedMs=performance.now()-started;
      const status=await ok('browser_status');
      assert.equal(status.data.pendingAction.operationId,action.operationId);
      assert.equal(status.data.paused,false);
      assert.equal((await ok('browser_status',{}, {clientId:'parallel-foreign'})).data.owner,'other');
      assert.equal(fixture.isGateHeld(action.gate),true);
      assert.deepEqual((await ok('browser_tabs',{action:'list'})).data.tabs.map(tab=>tab.tabId),before.data.tabs.map(tab=>tab.tabId));
      assert.equal((await ok('browser_take_screenshot')).artifacts[0].kind,'screenshot');
      concurrencyResult('independent-clients-same-profile',{result:'OWNERSHIP',rejectedMs:Math.round(rejectedMs),ownerStillRunning:true,ownerPaused:false,observationStillAvailable:true});
    } finally { fixture.releaseGate(action.gate); success(await action.pending); }
  });

  it('a shared workflow identity can queue a new tab but page actions remain serialized', {timeout:90_000}, async () => {
    await navigate();
    const before=await ok('browser_tabs',{action:'list'}), action=await gatedAction(), operationId=randomUUID();
    let settled=false;
    const queued=call('browser_tabs',{action:'new',url:`${fixture.url}/next`},{operationId,timeoutMs:60_000}).then(value=>{settled=true;return value;});
    try {
      await waitForReservation(operationId);
      await delay(200);
      assert.equal(settled,false,'A new-tab mutation must not jump the existing action queue');
      const status=await ok('browser_status');
      assert.equal(status.data.pendingAction.operationId,action.operationId);
      assert.equal(status.data.tabs,before.data.tabs.length);
      assert.equal(fixture.isGateHeld(action.gate),true);
    } finally { fixture.releaseGate(action.gate); success(await action.pending); }
    const result=success(await queued);
    const created=result.data.tabs.find(tab=>!before.data.tabs.some(old=>old.tabId===tab.tabId));
    assert.ok(created);assert.equal(created.url,`${fixture.url}/next`);
    await ok('browser_tabs',{action:'close',tabId:created.tabId});
    concurrencyResult('shared-workflow-same-profile',{result:'queued-then-completed',newTabWaitedForOwner:true,independentActionQueues:false});
  });

  it('a separate MCP client creates and controls tabs in another profile while the first agent remains busy', {timeout:120_000}, async () => {
    await navigate();
    await evaluate(()=>{localStorage.setItem('parallel-isolation','owner-a');return true;});
    const allocation=await cli(['spaces','--stdin-json'],{cwd:workspace,members:[{clientId:'parallel-agent-b',label:'Parallel agent'}]}),peerProfile=allocation.spaces[0].profile;
    const before=await ok('browser_tabs',{action:'list'}), session=mcpSession('full',{clientId:'parallel-agent-b',profile:peerProfile});
    let action,closed=false;
    try {
      await initializeMcp(session);
      action=await gatedAction();
      const started=performance.now();
      success(await mcpTool(session,2,'browser_navigate',{url:`${fixture.url}/`}));
      const tabResult=success(await mcpTool(session,3,'browser_tabs',{action:'new',url:`${fixture.url}/`}));
      assert.equal(tabResult.data.tabs.length,2);
      success(await mcpTool(session,4,'browser_click',{selector:'#increment'}));
      const page=success(await mcpTool(session,5,'browser_evaluate',{function:'() => ({count:document.querySelector("#count").textContent,storage:localStorage.getItem("parallel-isolation")})'}));
      assert.equal(page.data.value.count,'1');assert.equal(page.data.value.storage,null);
      const screenshot=success(await mcpTool(session,6,'browser_take_screenshot'));
      await checkArtifact(screenshot.artifacts[0],'screenshot','image/png',{profile:peerProfile});
      const workMs=performance.now()-started;
      const owner=await ok('browser_status');
      assert.equal(owner.data.pendingAction.operationId,action.operationId);
      assert.equal(owner.data.paused,false);
      assert.equal(fixture.isGateHeld(action.gate),true);
      assert.deepEqual((await ok('browser_tabs',{action:'list'})).data.tabs.map(tab=>tab.tabId),before.data.tabs.map(tab=>tab.tabId));
      success(await mcpTool(session,7,'browser_close'));closed=true;
      assert.equal((await ok('browser_status')).data.pendingAction.operationId,action.operationId,'Closing the peer must leave the first agent active');
      concurrencyResult('independent-clients-separate-profiles',{result:'parallel-completed',newTabs:1,clickVerified:true,screenshotVerified:true,isolatedStorage:true,ownerStillRunning:true,peerColdLaunchAndWorkMs:Math.round(workMs)});
    } finally {
      if(action){fixture.releaseGate(action.gate);success(await action.pending);}
      if(!closed)await mcpTool(session,8,'browser_close').catch(()=>{});
      session.child.stdin.end();assert.equal((await session.closed).code,0);
    }
    assert.equal(await evaluate(()=>localStorage.getItem('parallel-isolation')),'owner-a');
    assert.equal(await evaluate(()=>document.querySelector('#count').textContent),'0');
  });

  it('snapshot references stay valid when another tab is inspected', async () => {
    await navigate();
    const before=await ok('browser_tabs',{action:'list'}), first=before.data.tabs.find(tab=>tab.selected).tabId;
    const added=await ok('browser_tabs',{action:'new',url:`${fixture.url}/`});
    const second=added.data.tabs.find(tab=>!before.data.tabs.some(old=>old.tabId===tab.tabId)).tabId;
    try {
      const snapshot=await ok('browser_snapshot',{tabId:first});
      const button=snapshot.data.elements.find(element=>element.tag==='button'&&element.name==='Increment counter');assert.ok(button);
      const peerSnapshot=await ok('browser_snapshot',{tabId:second});
      failure(await call('browser_click',{tabId:second,ref:button.ref,revision:peerSnapshot.data.revision}),'BROWSER_ERROR');
      await ok('browser_click',{tabId:second,selector:'#increment'});
      await ok('browser_click',{tabId:first,ref:button.ref,revision:snapshot.data.revision});
      assert.equal((await ok('browser_evaluate',{tabId:first,function:'() => document.querySelector("#count").textContent'})).data.value,'1');
      assert.equal((await ok('browser_evaluate',{tabId:second,function:'() => document.querySelector("#count").textContent'})).data.value,'1');
      concurrencyResult('tabs-within-one-profile',{result:'explicit-tab-targeting-works',snapshotReferences:'page-scoped',laterSnapshotInvalidatesEarlierRefs:false});
    } finally { await ok('browser_tabs',{action:'close',tabId:second}); }
  });


  it('host allocates stable distinct spaces without opening a browser or reusing manual profiles',async()=>{
    await cli(['profiles','create','--cwd',workspace,'--profile','BROWSER2']);
    const members=[{clientId:'space-alpha',label:'Research'},{clientId:'space-beta',label:'Review'}];
    const result=await cli(['spaces','--stdin-json'],{cwd:workspace,members});
    assert.equal(result.spaces.length,2);assert.equal(new Set(result.spaces.map(space=>space.profile)).size,2);
    assert.ok(result.spaces.every(space=>space.profile!=='BROWSER1'&&space.profile!=='BROWSER2'));
    assert.deepEqual(await cli(['spaces','--stdin-json'],{cwd:workspace,members}),result);
    for(const space of result.spaces)assert.equal((await ok('browser_status',{},space)).data.running,false);
    const foreign=await cli(['spaces','--stdin-json'],{cwd:workspace,members:[{clientId:'space-gamma',label:'Third'}]});
    assert.ok(!result.spaces.some(space=>space.profile===foreign.spaces[0].profile));
  });
  it('typed batches return ordered durable receipts and reject invalid later steps before any input',async()=>{
    await navigate();
    failure(await call('browser_batch',{steps:[{tool:'browser_click',arguments:{selector:'#increment'}},{tool:'browser_fill_form',arguments:{fields:[null]}}]}),'BROWSER_ERROR');
    assert.equal(await evaluate(()=>document.querySelector('#count').textContent),'0');
    failure(await call('browser_batch',{steps:[{tool:'browser_click',arguments:{selector:'#increment'}}]},{mode:'observe'}),'POLICY_DENIED');
    const operationId=randomUUID();
    const batch=await ok('browser_batch',{steps:[{tool:'browser_click',arguments:{selector:'#increment'}},{tool:'browser_snapshot',arguments:{}},{tool:'browser_take_screenshot',arguments:{}}]},{operationId});
    assert.equal(batch.data.completed,3);assert.equal(batch.data.steps.length,3);assert.equal(batch.artifacts.length,1);
    for(const [index,step] of batch.data.steps.entries()){
      assert.equal(step.index,index);assert.equal(step.receipt.status,'completed');
      const receipt=JSON.parse(await fs.readFile(path.join(home,'receipts',sha256(step.operationId)+'.json'),'utf8'));
      assert.equal(receipt.parentOperationId,operationId);assert.equal(receipt.receipt.status,'completed');assert.ok(!('arguments' in receipt));assert.ok(!('data' in receipt));
    }
    failure(await call('browser_batch',{steps:[{tool:'browser_click',arguments:{selector:'#increment'}}]},{operationId}),'DUPLICATE_OPERATION');
    assert.equal(await evaluate(()=>document.querySelector('#count').textContent),'1');
  });
  it('cancelling a partial batch preserves completed receipts and never dispatches later steps',{timeout:90000},async()=>{
    await navigate();const gate=randomUUID(),operationId=randomUUID();
    const pending=call('browser_batch',{steps:[{tool:'browser_click',arguments:{selector:'#increment'}},{tool:'browser_evaluate',arguments:{function:'async route=>{await fetch(route);return true;}',arg:`/gate/${gate}`}},{tool:'browser_click',arguments:{selector:'#increment'}}]},{operationId,timeoutMs:60000});
    await eventually(async()=>fixture.isGateHeld(gate),Boolean,'Batch never reached its gate');
    try{
      await ok('browser_cancel',{operationId});const result=await pending;failure(result,'UNCERTAIN');
      assert.equal(result.structuredContent.data.steps[0].receipt.status,'completed');assert.equal(result.structuredContent.data.steps.length,2);
    }finally{fixture.releaseGate(gate);}
    await eventually(async()=>(await ok('browser_status')).data.pendingAction,value=>!value,'Cancelled batch did not settle');
    await ok('browser_resume');assert.equal(await evaluate(()=>document.querySelector('#count').textContent),'1');
  });
  it('requires explicit ownership takeover and increments generation for pause/resume/takeover', async () => {
    await navigate();
    const original = await ok('browser_status');
    assert.equal((await ok('browser_status', {}, { clientId: 'test-foreign' })).data.owner, 'other');
    failure(await call('browser_click', { selector: '#increment' }, { clientId: 'test-foreign' }), 'OWNERSHIP');
    failure(await call('browser_resume', {}, { clientId: 'test-foreign' }), 'OWNERSHIP');
    const paused = await ok('browser_pause');
    assert.ok(paused.generation > original.generation);
    assert.equal(paused.data.pauseReason, 'manual');
    assert.equal((await ok('browser_take_screenshot', {}, { mode: 'observe' })).artifacts[0].kind, 'screenshot');
    assert.equal((await ok('browser_snapshot', {}, { mode: 'observe' })).data.untrustedContent, true);
    assert.ok(Array.isArray((await ok('browser_console_messages', {}, { mode: 'observe' })).data.events));
    failure(await call('browser_click', { selector: '#increment' }), 'PAUSED');
    const resumed = await ok('browser_resume');
    assert.ok(resumed.generation > paused.generation);
    const taken = await ok('browser_takeover', {}, { clientId: 'test-foreign' });
    try {
      assert.ok(taken.generation > resumed.generation);
      failure(await call('browser_click', { selector: '#increment' }), 'OWNERSHIP');
      await ok('browser_click', { selector: '#increment' }, { clientId: 'test-foreign' });
    } finally { await ok('browser_takeover'); }
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '1');
  });

  it('MCP adapter disconnect leaves the detached broker and dedicated browser alive', async () => {
    await navigate();
    const brokerBefore = JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8'));
    const session = mcpSession();
    try {
      await initializeMcp(session);
      session.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } });
      const messages = await eventually(async () => session.messages(), values => values.some(value => value.id === 2), 'MCP adapter never returned its browser result');
      success(messages.find(message => message.id === 2).result);
    } finally {
      session.child.kill();
      await session.closed;
    }
    const brokerAfter = JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8'));
    assert.equal(brokerAfter.pid, brokerBefore.pid);
    assert.equal((await brokerRequest('/health')).body.pid, brokerBefore.pid);
    assert.equal((await ok('browser_status')).data.running, true);
    await ok('browser_click', { selector: '#increment' });
    assert.equal(await evaluate(() => document.querySelector('#count').textContent), '1');
  });

  for (const disconnect of ['EOF', 'kill']) {
    it(`MCP ${disconnect} cancels its read without pausing its profile or unrelated operations`, { timeout: 60_000 }, async () => {
      await navigate();
      await ok('browser_navigate', { url: `${fixture.url}/` }, { profile: 'BROWSER2' });
      const unrelatedId = randomUUID();
      const unrelated = launch(['call', '--stdin-json'], callInput('browser_wait_for', { time: 15 }, { profile: 'BROWSER2', operationId: unrelatedId, timeoutMs: 30_000 }));
      const brokerBefore = JSON.parse(await fs.readFile(path.join(home, 'broker.json'), 'utf8'));
      const session = mcpSession();
      try {
        await initializeMcp(session);
        const previous = await receiptNames();
        session.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_wait_for', arguments: { time: 30 } } });
        const receipt = await waitForNewWaitReceipt(previous);
        if (disconnect === 'EOF') session.child.stdin.end();
        else session.child.kill();
        await session.closed;
        const status = (await ok('browser_status')).data;
        assert.equal(status.running, true);
        assert.equal(status.paused, false);
        const persisted = await eventually(async()=>JSON.parse(await fs.readFile(path.join(home, 'receipts', `${sha256(receipt.operationId)}.json`), 'utf8')),value=>value.receipt.status==='cancelled','Disconnected read did not settle its receipt');
        assert.deepEqual(persisted.receipt, { status: 'cancelled', manualReview: false, replaySafe: false });
        if (disconnect === 'EOF') failure(session.messages().find(message => message.id === 2).result, 'CANCELLED');
        assert.equal((await brokerRequest('/health')).body.pid, brokerBefore.pid);
        assert.equal((await ok('browser_snapshot')).data.untrustedContent, true);
        const other = await unrelated.result;
        assert.equal(other.code, 0);
        assert.equal(success(JSON.parse(other.stdout)).data.waited, true);
        assert.equal((await ok('browser_status', {}, { profile: 'BROWSER2' })).data.paused, false);
      } finally {
        session.child.kill();
        await session.closed;
        await ok('browser_resume');
      }
      await ok('browser_click', { selector: '#increment' });
      assert.equal(await evaluate(() => document.querySelector('#count').textContent), '1');
    });
  }

  it('isolates project/profile state and persists the dedicated profile after browser close', async () => {
    await navigate();
    await ok('browser_navigate', { url: `${fixture.url}/` }, { profile: 'BROWSER2' });
    const secondaryRunning = (await ok('browser_status', {}, { profile: 'BROWSER2' })).data.running;
    assert.equal(secondaryRunning, true, 'Lifecycle regression must keep a second real Chrome profile running');
    await evaluate(() => { localStorage.setItem('trex-fixture-persist', 'dedicated-profile'); return true; });
    assert.equal((await ok('browser_status', {}, { cwd: otherWorkspace })).data.running, false);
    assert.equal((await ok('browser_status', {}, { profile: 'BROWSER3' })).data.running, false);
    const projectId = (await ok('browser_status')).projectId;
    const owned = process.platform === 'win32' ? await ownedBrowserProcesses(home, projectId, ['BROWSER1', 'BROWSER2']) : null;
    await ok('browser_close');
    assert.equal((await ok('browser_status')).data.running, false);
    if (owned) {
      await waitForProcessesExit([owned.browsers.get('BROWSER1'), owned.guards.get('BROWSER1')], 'Closing BROWSER1 must stop its exact Chrome root and guard');
      await assertProcessesAlive([owned.browsers.get('BROWSER2'), owned.guards.get('BROWSER2')], 'Closing BROWSER1 must leave BROWSER2 and its guard alive');
    }
    await ok('browser_click', { selector: '#increment' }, { profile: 'BROWSER2' });
    assert.equal(await evaluate(() => document.querySelector('#count').textContent, undefined, { profile: 'BROWSER2' }), '1');
    const secondaryImage = await ok('browser_take_screenshot', {}, { profile: 'BROWSER2' });
    assert.deepEqual((await checkArtifact(secondaryImage.artifacts[0], 'screenshot', 'image/png', { profile: 'BROWSER2' })).subarray(0, 8), pngSignature);
    if (owned) await assertProcessesAlive([owned.browsers.get('BROWSER2'), owned.guards.get('BROWSER2')], 'BROWSER2 capture must use the same surviving Chrome and guard');
    await navigate();
    assert.equal(await evaluate(() => localStorage.getItem('trex-fixture-persist')), 'dedicated-profile');
    assert.equal((await ok('browser_status', {}, { profile: 'BROWSER2' })).data.running, secondaryRunning);
    assert.equal((await ok('browser_status', {}, { cwd: otherWorkspace })).data.running, false);
  });

  // Keep popup coverage independent: an unresponsive popup must not invalidate
  // diagnostics and capture checks on the primary fixture page.
  it('opens a real popup using browser_click and closes only that tab', async () => {
    await navigate();
    const initial = (await ok('browser_tabs', { action: 'list' })).data.tabs;
    try {
      await ok('browser_click', { selector: '#popup' });
      const tabs = await eventually(async () => (await ok('browser_tabs', { action: 'list' })).data.tabs, values => values.some(tab => tab.url === `${fixture.url}/popup`), 'Fixture popup never appeared');
      assert.equal(tabs.length, initial.length + 1);
      const popup = tabs.find(tab => tab.url === `${fixture.url}/popup`);
      assert.equal(popup.title, 'Popup fixture');
      await ok('browser_tabs', { action: 'close', tabId: popup.tabId });
      const remaining = (await ok('browser_tabs', { action: 'list' })).data.tabs;
      assert.deepEqual(remaining.map(tab => tab.tabId), initial.map(tab => tab.tabId));
    } finally {
      await call('browser_close', {}, { timeoutMs: 20_000 });
    }
  });

  // Last and separately homed: deliberately crashing this broker must not affect
  // the other test broker/profile that serves as an ownership sentinel.
  it('broker crash stops only its owned Chrome trees and guards, then profiles reopen', { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
    const crashRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trex-browser-crash-'));
    const crashHome = path.join(crashRoot, 'private-home');
    const crashWorkspace = path.join(crashRoot, 'workspace');
    await fs.mkdir(crashWorkspace);
    const crashEnv = { ...env, TREX_BROWSER_HOME: crashHome };
    const crashCall = async (name, args = {}, overrides = {}) => success(await cli(['call', '--stdin-json'], callInput(name, args, { cwd: crashWorkspace, ...overrides }), { env: crashEnv }));
    const credentials = [];
    try {
      await ok('browser_navigate', { url: `${fixture.url}/` }, { profile: 'BROWSER2' });
      await evaluate(() => { document.querySelector('#count').textContent = 'other broker survives'; return true; }, undefined, { profile: 'BROWSER2' });
      const outside = await ownedBrowserProcesses(home, (await ok('browser_status', {}, { profile: 'BROWSER2' })).projectId, ['BROWSER2']);
      const first = await crashCall('browser_navigate', { url: `${fixture.url}/` });
      await crashCall('browser_navigate', { url: `${fixture.url}/` }, { profile: 'BROWSER2' });
      for (const profile of ['BROWSER1', 'BROWSER2']) await crashCall('browser_evaluate', { function: 'value => { localStorage.setItem("crash-persist", value); return true; }', arg: profile }, { profile });
      // Establish committed profile state before the deliberate hard crash.
      // Chrome may legitimately lose recent asynchronous localStorage writes
      // when its process is terminated; this test checks saved-profile recovery.
      for (const profile of ['BROWSER1', 'BROWSER2']) {
        await crashCall('browser_close', {}, { profile });
        await crashCall('browser_navigate', { url: `${fixture.url}/` }, { profile });
        assert.equal((await crashCall('browser_evaluate', { function: '() => localStorage.getItem("crash-persist")' }, { profile })).data.value, profile);
      }
      const owned = await ownedBrowserProcesses(crashHome, first.projectId, ['BROWSER1', 'BROWSER2']);
      const chromeTree = await ownedChromeTree([...owned.browsers.values()]);
      assert.ok(chromeTree.length > owned.browsers.size, 'Crash regression must include real owned Chrome descendants');
      const guards = [...owned.guards.values()];
      credentials.push(await fs.readFile(path.join(crashHome, 'broker.token'), 'utf8'));
      await assertProcessesAlive([owned.broker, ...owned.browsers.values(), ...guards], 'Crash setup must identify live owned processes');

      // Kill exactly the checked private broker; its native guards handle Chrome.
      process.kill(owned.broker.pid, 'SIGKILL');
      await waitForProcessesExit([owned.broker, ...chromeTree, ...guards], 'Broker EOF must stop all recorded owned Chrome processes and native guards', 25_000);
      await assertProcessesAlive([outside.broker, outside.browsers.get('BROWSER2'), outside.guards.get('BROWSER2')], 'Crashing one broker must preserve the other broker/profile');
      assert.equal(await evaluate(() => document.querySelector('#count').textContent, undefined, { profile: 'BROWSER2' }), 'other broker survives');
      const sentinelImage = await ok('browser_take_screenshot', {}, { profile: 'BROWSER2' });
      await checkArtifact(sentinelImage.artifacts[0], 'screenshot', 'image/png', { profile: 'BROWSER2' });
      await assertProcessesAlive([outside.broker, outside.browsers.get('BROWSER2'), outside.guards.get('BROWSER2')], 'Sentinel capture must not replace the untouched browser');

      await crashCall('browser_navigate', { url: `${fixture.url}/` });
      const reopened = await ownedBrowserProcesses(crashHome, first.projectId, ['BROWSER1']);
      assert.equal(sameProcess(owned.broker, reopened.broker), false, 'Reopen must start a fresh broker instance');
      assert.equal((await crashCall('browser_evaluate', { function: '() => localStorage.getItem("crash-persist")' })).data.value, 'BROWSER1');
      await crashCall('browser_navigate', { url: `${fixture.url}/` }, { profile: 'BROWSER2' });
      assert.equal((await crashCall('browser_evaluate', { function: '() => localStorage.getItem("crash-persist")' }, { profile: 'BROWSER2' })).data.value, 'BROWSER2');
      const image = await crashCall('browser_take_screenshot');
      await checkArtifact(image.artifacts[0], 'screenshot', 'image/png', { artifactHome: crashHome });
      const secondaryImage = await crashCall('browser_take_screenshot', {}, { profile: 'BROWSER2' });
      await checkArtifact(secondaryImage.artifacts[0], 'screenshot', 'image/png', { artifactHome: crashHome, profile: 'BROWSER2' });
      const profiles = await cli(['profiles', 'list', '--cwd', crashWorkspace, '--mode', 'full', '--client', 'test', '--json'], undefined, { env: crashEnv });
      assert.deepEqual(profiles.profiles.map(item => item.id).sort(), ['BROWSER1', 'BROWSER2']);
      credentials.push(await fs.readFile(path.join(crashHome, 'broker.token'), 'utf8'));
    } finally {
      try {
        try { credentials.push(await fs.readFile(path.join(crashHome, 'broker.token'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const credential of credentials) for (const output of outputs) assert.equal(output.includes(credential), false, 'Crash/restart output must never expose broker credentials');
        const receipts = await fs.readdir(path.join(crashHome, 'receipts')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const name of receipts) {
          const raw = await fs.readFile(path.join(crashHome, 'receipts', name), 'utf8');
          for (const credential of credentials) assert.equal(raw.includes(credential), false, 'Crash/restart receipts must never expose broker credentials');
          const receipt = JSON.parse(raw);
          assert.equal('arguments' in receipt, false);
          assert.equal('data' in receipt, false);
        }
      } finally {
        try { await cli(['stop', '--json'], undefined, { env: crashEnv }); }
        finally { await fs.rm(crashRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      }
    }
  });
});
