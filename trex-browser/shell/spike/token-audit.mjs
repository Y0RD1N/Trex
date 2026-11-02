// Token audit: what an agent receives per tool on real pages. Text tokens are
// estimated as chars/3.6 (JSON-heavy, mixed ES/EN); images as width*height/750
// (Anthropic's image token formula).
import { BrowserService } from '../../worker/browser.mjs';
import { context } from '../../worker/security.mjs';
import { tools, BROWSER_INSTRUCTIONS, modelView } from '../../worker/tools.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
// Same model-facing text the worker sends (tools.modelView).
const resultFor = r => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, ...modelView(r) }) }, ...(r.image ? [r.image] : [])] });
const tok = s => Math.round(s.length / 3.6);
function cost(result) {
  let text = 0, image = 0;
  for (const c of result.content) {
    if (c.type === 'text') text += tok(c.text);
    if (c.type === 'image') { const b = Buffer.from(c.data, 'base64'); const w = b.readUInt32BE(16), h = b.readUInt32BE(20); image += Math.round(w * h / 750); }
  }
  return { text, image, total: text + image };
}
console.log(`fijo · tools/list full: ${tok(JSON.stringify(tools('full')))} tok (${tools('full').length} herramientas) · observe: ${tok(JSON.stringify(tools('observe')))} tok · instrucciones: ${tok(BROWSER_INSTRUCTIONS)} tok`);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-tok-')); fs.mkdirSync(path.join(home, 'artifacts'), { mode: 0o700 });
const svc = new BrowserService(home), ctx = context({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), mode: 'full', clientId: 'audit', profile: 'BROWSER2' });
let n = 0;
async function run(name, args = {}) { const op = `op-${++n}`; const r = await svc.call(ctx, name, args, op, 60000); return { r, c: cost(resultFor(r)) }; }
const pages = (process.argv[2] || 'https://example.com,https://github.com/microsoft/playwright,https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API,https://www.youtube.com/results?search_query=rock').split(',');
const rows = [];
try {
  for (const url of pages) {
    const row = { page: new URL(url).host };
    row.navigate = (await run('browser_navigate', { url })).c.total;
    await run('browser_wait_for', { time: 2 });
    row.snapshot = (await run('browser_snapshot')).c.total;
    const compact = await run('browser_snapshot', { compact: true }); row.compact = compact.c.total;
    const line = compact.r.data.elements.find(e => / button /.test(e));
    if (line) row.hover = (await run('browser_hover', { ref: line.split(' ')[0], revision: compact.r.data.revision, tabId: compact.r.data.tabId })).c.total;
    row.screenshot = (await run('browser_take_screenshot')).c.total;
    row.console = (await run('browser_console_messages')).c.total;
    row.network = (await run('browser_network_requests')).c.total;
    row.tabs = (await run('browser_tabs', { action: 'list' })).c.total;
    rows.push(row);
  }
} finally { await svc.shutdown().catch(() => {}); }
console.table(rows);
