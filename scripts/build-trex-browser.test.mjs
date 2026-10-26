import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NODE_VERSION, NODE_ARCHIVES, verifyNodeArchive, assertPinnedLock, buildBrowser, cleanBuildEnvironment, assertBrowserMcpHandshake } from './build-trex-browser.mjs';

test('private Node archives require both the pinned digest and official manifest', () => {
  assert.match(NODE_VERSION, /^24\.\d+\.\d+$/);
  assert.throws(() => verifyNodeArchive(Buffer.from('fake executable'),
    `${NODE_ARCHIVES.x64}  node-v${NODE_VERSION}-win-x64.zip\n`, 'x64'), /verification failed/);
  assert.throws(() => verifyNodeArchive(Buffer.alloc(0), '', 'ia32'), /Unsupported/);
});

test('packaging refuses dependency ranges, lock drift and non-registry packages', () => {
  const packageJson = { dependencies: { playwright: '1.64.1' } };
  const lock = { lockfileVersion: 3, packages: {
    '': { dependencies: { playwright: '1.64.1' } },
    'node_modules/playwright': { version: '1.64.1', resolved: 'https://registry.npmjs.org/playwright/-/playwright-1.64.1.tgz', integrity: 'sha512-dGVzdA==' },
  } };
  assert.doesNotThrow(() => assertPinnedLock(packageJson, lock));
  assert.throws(() => assertPinnedLock({ dependencies: { playwright: '^1.64.1' } }, lock));
  const changed = structuredClone(lock);
  changed.packages['node_modules/playwright'].resolved = 'http://untrusted.test/playwright.tgz';
  assert.throws(() => assertPinnedLock(packageJson, changed));
  changed.packages['node_modules/playwright'].resolved = lock.packages['node_modules/playwright'].resolved;
  changed.packages['node_modules/playwright'].integrity = '';
  assert.throws(() => assertPinnedLock(packageJson, changed));
});

test('Tauri resource mapping keeps executable sources and an inert runtime directory', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.windows.conf.json', import.meta.url)));
  assert.equal(config.bundle.resources['installer/payload/browser/trex-browser.exe'], 'trex-browser.payload');
  assert.equal(config.bundle.resources['installer/payload/browser/trex-browser-runtime/'], 'trex-browser-runtime.payload/');
});

test('unsupported desktop targets skip the optional Windows component', async () => {
  const previous = process.env.TAURI_ENV_TARGET_TRIPLE;
  try {
    process.env.TAURI_ENV_TARGET_TRIPLE = 'aarch64-apple-darwin';
    assert.equal(await buildBrowser([]), undefined);
    await assert.rejects(buildBrowser(['--standalone']), /Windows only/);
  } finally {
    if (previous === undefined) delete process.env.TAURI_ENV_TARGET_TRIPLE;
    else process.env.TAURI_ENV_TARGET_TRIPLE = previous;
  }
});

test('private runtime build cannot inherit Playwright mirror or npm/TLS overrides', () => {
  const inherited = { PATH: 'build-tools', HTTPS_PROXY: 'https://proxy.example.test',
    PLAYWRIGHT_DOWNLOAD_HOST: 'http://untrusted.test', playwright_ffmpeg_download_host: 'http://untrusted.test',
    npm_config_playwright_download_host: 'http://untrusted.test',
    NPM_PACKAGE_CONFIG_PLAYWRIGHT_DOWNLOAD_HOST: 'http://untrusted.test',
    npm_config_registry: 'http://untrusted.test', NPM_CONFIG_STRICT_SSL: 'false',
    NODE_OPTIONS: '--require untrusted.cjs', NODE_PATH: 'untrusted', NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  assert.deepEqual(cleanBuildEnvironment(inherited), { PATH: 'build-tools', HTTPS_PROXY: 'https://proxy.example.test' });
  assert.equal(inherited.PLAYWRIGHT_DOWNLOAD_HOST, 'http://untrusted.test');
});
test('packaging requires the real Codex MCP version and navigation inventory, beyond doctor readiness',()=>{
  const frames=[{id:1,result:{protocolVersion:'2025-06-18'}},{id:2,result:{tools:['browser_navigate','browser_snapshot','browser_status'].map(name=>({name}))}}];
  assert.doesNotThrow(()=>assertBrowserMcpHandshake(frames.map(JSON.stringify).join('\n')));
  for(const broken of [ [{id:1,error:{code:-32602,message:'Unsupported protocol'}}], [{id:1,result:{protocolVersion:'2025-11-25'}},frames[1]], [frames[0],{id:2,result:{tools:[]}}] ])assert.throws(()=>assertBrowserMcpHandshake(broken.map(JSON.stringify).join('\n')),/MCP protocol/);
});
