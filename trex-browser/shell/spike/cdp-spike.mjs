// Spike: drive the Trex shell with the same Playwright API the worker uses
// for Chrome (launchPersistentContext over --remote-debugging-pipe).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = async (name, fn) => {
  const t = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - t, detail }); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t, detail: e.message.split('\n')[0] }); }
};

const server = http.createServer((req, res) => {
  if (req.url === '/api') { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}'); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Acme ${req.url}</title><body style="font:16px system-ui;padding:40px">
    <h1>Acme panel</h1><label>Nombre <input id="name"></label> <input type="file" id="file">
    <button id="save" onclick="fetch('/api').then(r=>r.json()).then(j=>document.getElementById('out').textContent='guardado '+document.getElementById('name').value)">Guardar cambios</button>
    <p id="out"></p><a href="/second" target="_blank">abrir en otra pestaña</a></body>`);
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-shell-spike-'));

let context, ui, tab;
const isUi = p => p.url().startsWith('trex://ui/');
await check('launchPersistentContext (pipe, sin puerto)', async () => {
  context = await chromium.launchPersistentContext(userData, {
    executablePath: path.join(here, '..', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), headless: false, chromiumSandbox: true, viewport: null, timeout: 20000,
    env: { ...process.env, TREX_SPACE_LABEL: 'Ejecutor', TREX_PROJECT_LABEL: '~/projects/trex' },
  });
  return `${context.pages().length} documentos`;
});
await check('distinguir interfaz y pestañas', async () => {
  await new Promise(r => setTimeout(r, 1200));
  const pages = context.pages();
  ui = pages.find(p => p.url() === 'trex://ui/index.html');
  tab = pages.find(p => p.url().startsWith('trex://newtab/'));
  if (!ui || !tab) throw new Error(pages.map(p => p.url()).join(', '));
  return pages.map(p => p.url()).join(' | ');
});
await check('canal worker→shell por CDP (hello)', async () => JSON.stringify(await ui.evaluate(() => window.trexShell.worker('hello'))));
await check('navegar', async () => { await tab.goto(base + '/dashboard'); return await tab.title(); });
await check('ariaSnapshot modo ai (refs)', async () => (await tab.ariaSnapshot({ mode: 'ai' })).split('\n').slice(0, 4).join(' / '));
await check('escribir + clic + red', async () => {
  const resp = tab.waitForResponse(r => r.url().endsWith('/api'));
  await tab.fill('#name', 'Trex');
  await tab.click('#save');
  await resp;
  await tab.waitForSelector('#out:text("guardado Trex")');
  return await tab.textContent('#out');
});
await check('setInputFiles', async () => {
  const f = path.join(userData, 'nota.txt'); fs.writeFileSync(f, 'hola');
  await tab.setInputFiles('#file', f);
  return await tab.$eval('#file', el => el.files[0]?.name);
});
await check('route (mock de red)', async () => {
  await tab.route('**/api', r => r.fulfill({ json: { mocked: true } }));
  const j = await tab.evaluate(() => fetch('/api').then(r => r.json()));
  await tab.unroute('**/api'); return JSON.stringify(j);
});
await check('captura de pestaña', async () => { const b = await tab.screenshot(); fs.writeFileSync(path.join(here, 'tab.png'), b); return `${b.length} bytes`; });
await check('context.newPage() (se espera que falle)', async () => { const p = await context.newPage(); return p.url(); });
await check('pestaña nueva vía shell + evento page', async () => {
  const ev = context.waitForEvent('page', { timeout: 8000 });
  const r = await ui.evaluate(u => window.trexShell.worker('newTab', { url: u }), base + '/second');
  const p = await ev; await p.waitForLoadState();
  return `${r.id} → ${p.url()}`;
});
await check('window.open de la página abre pestaña propia', async () => {
  const ev = context.waitForEvent('page', { timeout: 8000 });
  await tab.click('a[target=_blank]');
  const p = await ev; await p.waitForLoadState(); return p.url();
});
await check('estado del agente en el shell', async () => {
  await ui.evaluate(() => window.trexShell.worker('selectTab', { id: 't1' }));
  await ui.evaluate(() => window.trexShell.worker('setAgent', { label: 'Ejecutor', model: 'Claude Opus', state: 'working', tool: 'browser_click', detail: 'Guardar cambios', step: 'paso 3/5' }));
  return JSON.stringify(await ui.evaluate(() => window.trexShell.worker('tabs')).then(t => t.map(x => x.id)));
});
await check('evento de control humano → worker (binding)', async () => {
  await ui.exposeBinding('__trexWorkerEvent', (_src, m) => { globalThis.lastControl = m; });
  await ui.evaluate(() => window.trexShell.onWorkerEvent(m => window.__trexWorkerEvent(m)));
  const overlay = context.pages().find(p => p.url().includes('overlay.html?part=dock'));
  await overlay.click('[data-k=pause]');
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify(globalThis.lastControl);
});
await check('screencast (vídeo)', async () => {
  if (!tab.screencast?.start) throw new Error('page.screencast no disponible');
  const file = path.join(userData, 'v.webm');
  await tab.screencast.start({ path: file }); await tab.mouse.move(100, 100); await new Promise(r => setTimeout(r, 800));
  await tab.screencast.stop(); return `${fs.statSync(file).size} bytes`;
});

console.log(JSON.stringify(results, null, 1));
if (process.argv.includes('--keep')) { console.log('KEEP-OPEN'); await new Promise(r => setTimeout(r, Number(process.env.KEEP_MS || 15000))); }
await context?.close().catch(() => {});
server.close();
