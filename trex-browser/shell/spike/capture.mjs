// Renders the shell UI in a few states and saves composed window images (the ones in docs/design).
//   node spike/capture.mjs <output folder>
// Environment (all optional):
//   TREX_ELECTRON         an Electron whose resources/app points at this folder (default: the one in node_modules)
//   TREX_BROWSER_HOME     a private Browser home; a theme.json there dresses the shell like the app (see ../theme.mjs)
//   TREX_CAPTURE_SUFFIX   appended to every file name, e.g. "-pizarra-claro"
//   TREX_CAPTURE_ONLY     comma-separated words; only files whose name contains one are saved, e.g. "agente,centro"
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || here;
const suffix = process.env.TREX_CAPTURE_SUFFIX || '';
const only = process.env.TREX_CAPTURE_ONLY?.split(',').map(word => word.trim()).filter(Boolean);
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(path.join(here, 'demo-app.html'))); }).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'trex-shell-cap-')), {
  executablePath: process.env.TREX_ELECTRON || path.join(here, '..', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), headless: false, viewport: null, timeout: 20000,
  env: { ...process.env, TREX_SHELL_DEV: '1', TREX_SPACE_LABEL: 'Ejecutor', TREX_PROJECT_LABEL: '~/projects/trex' } });
await new Promise(r => setTimeout(r, 1200));
const ui = context.pages().find(p => p.url() === 'trex://ui/index.html');
const tab = context.pages().find(p => p.url().startsWith('trex://newtab/'));
const shell = (name, args) => ui.evaluate(([n, a]) => window.trexShell.worker(n, a), [name, args]);
async function save(name) {
  if (only && !only.some(word => name.includes(word))) return;
  await new Promise(r => setTimeout(r, 700));
  const cap = await shell('debugCapture');
  const png = await ui.evaluate(async ({ width, height, layers }) => {
    const c = new OffscreenCanvas(width, height), g = c.getContext('2d');
    // A flat desktop behind the transparent window, for review only.
    g.fillStyle = '#2a2a2e'; g.fillRect(0, 0, width, height);
    for (const l of layers) { const img = new Image(); img.src = l.png; await img.decode(); g.drawImage(img, l.x, l.y, l.width, l.height); }
    const blob = await c.convertToBlob(); const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (const b of buf) s += String.fromCharCode(b); return btoa(s);
  }, cap);
  const file = name.replace(/\.png$/, `${suffix}.png`);
  fs.writeFileSync(path.join(out, file), Buffer.from(png, 'base64'));
  console.log('saved', file);
}
await save('shell-nueva-pestana.png');
await tab.goto(base + '/');
await shell('newTab', { url: base + '/?pedidos', activate: false });
await shell('newTab', { url: base + '/?docs', activate: false });
await shell('selectTab', { id: 't1' });
await shell('setAgent', { label: 'Ejecutor', model: 'Claude Opus', state: 'working', tool: 'browser_click', detail: 'Guardar cambios', step: 'paso 3/5' });
await save('shell-agente-trabajando.png');
await shell('setAgent', { state: 'idle', tool: '' });
await save('shell-barra-oculta.png');
const island = context.pages().find(p => p.url().includes('part=island'));
await island.mouse.move(400, 4); await island.mouse.move(420, 6);   // pointer reaches the top edge
await new Promise(r => setTimeout(r, 300));
await island.hover('.tabpill.on');
await save('shell-barra-revelada.png');
await island.mouse.move(600, 85); await island.mouse.move(600, 110); await new Promise(r => setTimeout(r, 900));  // pointer goes down to the page
await shell('setAgent', { label: 'Ejecutor', model: 'Claude Opus', state: 'working', tool: 'browser_click', detail: 'Guardar cambios', step: 'paso 3/5' });
// A stand-in for the page thumbnails the worker sends while the center is open.
const thumb = bars => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 168"><rect width="320" height="168" fill="#f6f4ef"/><rect width="52" height="168" fill="#ece8e0"/><rect x="66" y="16" width="120" height="10" rx="3" fill="#cfc9bd"/>${bars.map((h, i) => `<rect x="${70 + i * 28}" y="${150 - h}" width="22" height="${h}" rx="3" fill="#e0866a"/>`).join('')}</svg>`);
const spaces = state => [
  { clientId: 'a', label: 'Ejecutor', model: 'Claude Opus', state, tool: 'browser_click', detail: 'Guardar cambios', tabCount: 2, title: 'Resumen — Acme', url: base + '/', thumbnail: thumb([50, 70, 60, 90, 80]), events: [{ id: 1, at: Date.now() - 2000, tool: 'browser_click', detail: 'Guardar cambios' }] },
  { clientId: 'b', label: 'Revisor', model: 'Codex', state: 'working', tool: 'browser_snapshot', detail: 'PR #214', tabCount: 3, title: 'PR #214 · Guardar ajustes', url: 'https://github.com/acme/web/pull/214', thumbnail: thumb([30, 55, 40, 65]), events: [{ id: 2, at: Date.now() - 6000, tool: 'browser_snapshot', detail: 'PR #214' }] },
  { clientId: 'c', label: 'QA', model: 'Claude Sonnet', state: 'paused', tool: 'browser_fill_form', tabCount: 1, title: 'Iniciar sesión — Acme', url: base + '/login', thumbnail: thumb([20, 35]) },
  { clientId: 'd', label: 'Checkout', model: 'Claude Opus', state: 'review', tool: 'browser_click', tabCount: 2, title: 'Carrito — Tienda demo', url: 'http://localhost:4000/checkout', thumbnail: thumb([45]) },
  { clientId: 'e', label: 'Planificador', model: 'Claude Opus', state: 'closed', profile: 'BROWSER3' },
];
await shell('setSpaces', spaces('working'));
await ui.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
await save('shell-centro-agentes.png');
await shell('setAgent', { label: 'Ejecutor', model: 'Claude Opus', state: 'paused', tool: 'browser_click', detail: 'Guardar cambios' });
await shell('setSpaces', spaces('paused'));
await save('shell-centro-agentes-pausado.png');
await context.close(); server.close();
