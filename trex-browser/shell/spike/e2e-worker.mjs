// End to end: the real BrowserService drives two agent spaces in the shell;
// the second one opens the agents center. Saves composed window images.
import { BrowserService } from '../../worker/browser.mjs';
import { context } from '../../worker/security.mjs';
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), out = process.argv[2] || here;
const html = fs.readFileSync(path.join(here, 'demo-app.html'), 'utf8');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/docs')) return res.end('<!doctype html><title>Guía de despliegue — Acme Docs</title><body style="font:15px system-ui;padding:60px 90px;background:#fff"><h1>Guía de despliegue</h1>' + '<p style="color:#555;line-height:1.7">Configura las variables de entorno, ejecuta las migraciones y publica la build.</p>'.repeat(6) + '<pre style="background:#1d1f24;color:#e6e6e6;padding:18px;border-radius:8px">npm run build && npm run deploy</pre></body>');
  res.end(html);
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-e2e-')); fs.mkdirSync(path.join(home, 'artifacts'), { mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-'));
const svc = new BrowserService(home);
const space = (clientId, profile, label, model) => {
  const ctx = context({ cwd, mode: 'full', clientId, profile });
  svc.createProfile(ctx);
  const file = path.join(svc.profileDir(ctx), 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), space: { clientId, label, ...(model ? { model } : {}) } }), { mode: 0o600 });
  return ctx;
};
const A = space('exec', 'BROWSER2', 'Ejecutor', 'Claude Opus 5.5'), B = space('review', 'BROWSER3', 'Revisor', 'Codex');
let n = 0; const call = (ctx, name, args = {}, timeoutMs = 30000) => svc.call(ctx, name, args, `op-${++n}`, timeoutMs);
async function save(ctx, name) {
  const s = svc.state(ctx), cap = await s.shell.call('debugCapture');
  const png = await s.shell.uiPage.evaluate(async ({ width, height, layers }) => {
    const c = new OffscreenCanvas(width, height), g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, width, height); bg.addColorStop(0, '#3a2418'); bg.addColorStop(.5, '#16141a'); bg.addColorStop(1, '#251c3d'); g.fillStyle = bg; g.fillRect(0, 0, width, height);
    for (const l of layers) { const img = new Image(); img.src = l.png; await img.decode(); g.drawImage(img, l.x, l.y, l.width, l.height); }
    const buf = new Uint8Array(await (await c.convertToBlob()).arrayBuffer()); let str = ''; for (const b of buf) str += String.fromCharCode(b); return btoa(str);
  }, cap);
  fs.writeFileSync(path.join(out, name), Buffer.from(png, 'base64')); console.log('saved', name);
}
try {
  await call(A, 'browser_navigate', { url: base + '/' });
  await call(A, 'browser_hover', { selector: 'button' });
  await save(A, 'e2e-cursor.png');
  await call(B, 'browser_navigate', { url: base + '/docs' });
  await call(B, 'browser_tabs', { action: 'new', url: base + '/?pedidos' });
  await call(B, 'browser_snapshot');
  // A slow page action keeps the Ejecutor "working" while we look.
  const slow = call(A, 'browser_evaluate', { function: '() => new Promise(r => setTimeout(() => r("ok"), 6000))' }, 20000);
  await new Promise(r => setTimeout(r, 500));
  await save(A, 'e2e-agent-working.png');
  const sb = svc.state(B);
  await sb.shell.uiPage.evaluate(() => window.trexShell.command('toggleCenter', { open: true }));
  await new Promise(r => setTimeout(r, 3500));
  await save(B, 'e2e-agents-center.png');
  // Human control from the center: pause the Ejecutor; its next action is refused.
  await sb.shell.uiPage.evaluate(() => window.__trexWorkerEvent({ type: 'control', action: 'pause', clientId: 'exec' }));
  console.log('slow action:', JSON.stringify((await slow).data));
  const next = await call(A, 'browser_click', { selector: 'button' }).then(() => 'ejecutada', e => `rechazada (${e.code})`);
  console.log('acción del agente tras pausar desde el centro:', next);
  await new Promise(r => setTimeout(r, 800));
  await save(B, 'e2e-agents-center-paused.png');
} finally { await svc.shutdown().catch(() => {}); server.close(); }
