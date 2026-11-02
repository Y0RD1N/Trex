// Checks that our UI documents live in their own session: agents still find
// them by CDP target id, and a page navigating to trex://ui neither reaches them
// nor leaves automation waiting on a navigation that never finishes.
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const electron = path.join(here, '..', 'node_modules', 'electron', 'dist', 'electron');
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<title>t</title><button id=b onclick="document.title=\'ok\'">b</button>'); }).listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}/`;
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-')), { executablePath: electron, headless: true, viewport: null, args: ['--ozone-platform=x11'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ui; for (let i = 0; i < 80 && !(ui = ctx.pages().find(p => p.url() === 'trex://ui/index.html')); i++) await sleep(50);
const tid = async p => { const c = await ctx.newCDPSession(p); try { return (await c.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await c.detach().catch(() => {}); } };
const uiTargets = await ui.evaluate(() => window.trexShell.worker('uiTargets'));
await sleep(500);
const matched = []; for (const p of ctx.pages()) if (uiTargets.includes(await tid(p))) matched.push(p.url());
console.log('UI documents found by target id:', matched.length, '/', uiTargets.length);
const tab = ctx.pages().find(p => p.url().startsWith('trex://newtab'));
await tab.goto(base);
await tab.evaluate(() => { location.href = 'trex://ui/index.html'; });
await sleep(600);
console.log('tab url after attempt:', tab.url());
await tab.goto(base);
const t = Date.now();
try { await tab.click('#b', { timeout: 5000 }); console.log('agent recovers after blocked navigation: OK', Date.now() - t, 'ms', await tab.title()); }
catch (e) { console.log('agent recovers after blocked navigation: FAIL', e.message.split('\n').slice(0, 3).join(' | ')); }
await ctx.close(); srv.close();
