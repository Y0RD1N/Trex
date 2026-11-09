import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { detectBrowser } from '../worker/browser.mjs';
const detected = detectBrowser('chrome');
const available = detected.available && !detected.shell;
const ui = new URL('../shell/ui/', import.meta.url);
const html = fs.readFileSync(new URL('index.html', ui), 'utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const theme = fs.readFileSync(new URL('theme.css', ui), 'utf8').replace(/^@import[^;]+;/m, '');
const fonts = [['IBM Plex Sans Variable', 'ibm-plex-sans-latin-wght-normal', '100 700'], ...[400, 500, 600].map(weight => ['IBM Plex Mono', `ibm-plex-mono-latin-${weight}-normal`, String(weight)])].map(([name, file, weight]) => `@font-face{font-family:"${name}";font-weight:${weight};src:url(data:font/woff2;base64,${fs.readFileSync(new URL(`fonts/${file}.woff2`, ui)).toString('base64')})}`).join('\n');
const icons = fs.readFileSync(new URL('icons.js', ui), 'utf8').replace(/^export /gm, '');
const script = fs.readFileSync(new URL('index.js', ui), 'utf8').replace(/^import[^;]+;/m, '');
let browser;
async function page(width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route('**/*', route => route.abort());
  await page.setContent(html.replace('</head>', `<style>${theme}\n${fonts}</style></head>`));
  await page.evaluate(() => {
    window.calls = []; window.rejectControl = false; window.deferControl = false;
    window.fixture = { centerOpen: true, project: 'trex', platform: 'win32', agent: { state: 'idle', label: 'Principal' }, tabs: [], spaces: [
      { clientId: 'agent-a', profile: 'BROWSER2', label: 'Codex · podrías iniciar mi app en local por favor y revisar el proyecto completo', model: 'GPT-6.1-Sol · modelo con un nombre largo', state: 'idle', title: 'Vender · FlashVent', url: 'http://127.0.0.1:5174/vender?filtro=' + 'largo'.repeat(80), tabCount: 1 },
      { clientId: 'agent-b', profile: 'BROWSER3', label: 'A'.repeat(250), model: 'Claude Code', state: 'closed', title: 'BROWSER3', tabCount: 0 },
    ] };
    window.trexShell = {
      onState(fn) { window.pushState = fn; }, onBackdrop() {}, state: async () => window.fixture,
      command: async (name, args) => {
        window.calls.push({ name, args });
        if (window.rejectControl) throw new Error('No se pudo mostrar este espacio.');
        if (window.deferControl) await new Promise(resolve => { window.finishControl = resolve; });
        return { ok: true, image: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5okAAAAASUVORK5CYII=' } };
      },
    };
  });
  await page.addScriptTag({ type: 'module', content: icons + '\n' + script });
  await page.locator('.card').first().waitFor(); return page;
}
describe('agents center layout and controls', { skip: !available && 'System Chromium unavailable', concurrency: false }, () => {
  before(async () => { browser = await chromium.launch({ executablePath: detected.executablePath, headless: true }); });
  after(async () => { await browser?.close(); });
  it('shows agent spaces as they open and removes closed profiles from the live inventory',async()=>{
    const p=await page();
    try{
      assert.equal(await p.locator('.card').count(),1);
      assert.equal(await p.locator('.card[data-profile="BROWSER3"]').count(),0);
      await p.evaluate(()=>{window.fixture.spaces[1].state='idle';window.fixture.spaces[1].tabCount=1;window.pushState(window.fixture);});
      assert.equal(await p.locator('.card').count(),2);
      await p.evaluate(()=>{window.fixture.spaces[1].state='closed';window.fixture.spaces[1].tabCount=0;window.pushState(window.fixture);});
      assert.equal(await p.locator('.card').count(),1);
    }finally{await p.close();}
  });
  for (const width of [1440, 1120, 960, 720, 390]) it(`contains long labels and URLs inside grid cards at ${width}px`, async () => {
    const p = await page(width);
    try {
      const measurements = await p.evaluate(() => ({ horizontal: document.documentElement.scrollWidth > innerWidth + 1,
        grid: document.querySelector('.grid').scrollWidth - document.querySelector('.grid').clientWidth,
        cards: [...document.querySelectorAll('.card')].map(card => { const r = card.getBoundingClientRect(); return [...card.querySelectorAll('.name,.model,.pill,.cur,.acts,.tool')].every(el => { const b = el.getBoundingClientRect(); return b.x >= r.x && b.right <= r.right + 1; }); }) }));
      assert.equal(measurements.horizontal, false); assert.ok(measurements.grid <= 1); assert.ok(measurements.cards.every(Boolean));
      if (process.env.TREX_BROWSER_VISUAL_DIR) { fs.mkdirSync(process.env.TREX_BROWSER_VISUAL_DIR, { recursive: true }); await p.screenshot({ path: path.join(process.env.TREX_BROWSER_VISUAL_DIR, `center-${width}.png`) }); }
    } finally { await p.close(); }
  });
  for (const [width,height] of [[1280,900],[1280,480],[800,600],[720,480],[390,900]]) it(`scrolls through every retained activity below a fixed heading at ${width}x${height}`, async () => {
    const p = await page(width);
    try {
      await p.setViewportSize({ width, height });
      await p.evaluate(() => {
        const now = Date.now();
        window.fixture.spaces[0].events = Array.from({ length: 80 }, (_, index) => ({ id: `activity-${index}`, at: now - index * 1000, tool: 'browser_click', detail: `Actividad ${index} con una descripción extensa para revisar el proyecto` }));
        window.pushState(window.fixture);
      });
      assert.equal(await p.locator('#feed .ev').count(), 80);
      const heading = await p.locator('.feed h3').boundingBox();
      assert.ok(await p.locator('.thumb').first().evaluate(el => { const r=el.getBoundingClientRect(); return Math.abs(r.height / r.width - 8.4 / 16) < .02; }), 'Activity must not flatten page previews');
      assert.ok(await p.locator('.card').first().evaluate(el => el.querySelector('.acts').getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom), 'Page controls must remain inside their card');
      const geometry = await p.locator('#feed').evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight, bottom: el.getBoundingClientRect().bottom, viewport: innerHeight }));
      assert.ok(geometry.height > 50 && geometry.content > geometry.height); assert.ok(geometry.bottom < geometry.viewport);
      await p.locator('#feed').hover(); await p.mouse.wheel(0, 500);
      await p.waitForFunction(() => document.getElementById('feed').scrollTop > 50);
      await p.locator('#feed').focus(); await p.keyboard.press('End');
      await p.waitForFunction(() => { const el = document.getElementById('feed'); return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; });
      assert.equal(Math.round((await p.locator('.feed h3').boundingBox()).y), Math.round(heading.y));
      if (process.env.TREX_BROWSER_VISUAL_DIR) await p.screenshot({ path: path.join(process.env.TREX_BROWSER_VISUAL_DIR, `activity-${width}-${height}.png`) });
    } finally { await p.close(); }
  });
  it('preserves the activity being read across updates and follows new events only from the top', async () => {
    const p = await page();
    try {
      await p.evaluate(() => {
        const now = Date.now(); window.fixture.spaces[0].events = Array.from({ length: 60 }, (_, index) => ({ id: `event-${index}`, at: now - index * 1000, tool: 'browser_click', detail: `Acción ${index}` })); window.pushState(window.fixture);
        document.getElementById('feed').scrollTop = 700;
        const feed = document.getElementById('feed'), top = feed.getBoundingClientRect().top;
        const anchor = [...feed.children].find(el => el.getBoundingClientRect().bottom > top);
        window.activityAnchor = { id: anchor.dataset.event, offset: anchor.getBoundingClientRect().top - top };
        window.fixture.spaces[0].events.unshift({ id: 'new-event', at: now + 1000, tool: 'browser_navigate', detail: 'Nueva página' }); window.pushState(window.fixture);
      });
      const anchor = await p.evaluate(() => {
        const feed = document.getElementById('feed'), item = [...feed.children].find(el => el.dataset.event === window.activityAnchor.id);
        return { original: window.activityAnchor.offset, updated: item?.getBoundingClientRect().top - feed.getBoundingClientRect().top };
      });
      assert.ok(Number.isFinite(anchor.updated)); assert.ok(Math.abs(anchor.updated - anchor.original) < 2);
      await p.evaluate(() => { document.getElementById('feed').scrollTop = 0; window.fixture.spaces[0].events.unshift({ id: 'newest', at: Date.now() + 2000, tool: 'browser_click', detail: 'Actividad más reciente' }); window.pushState(window.fixture); });
      assert.equal(await p.locator('#feed').evaluate(el => el.scrollTop), 0);
      assert.equal(await p.locator('#feed .ev').first().getAttribute('data-event'), 'newest');
    } finally { await p.close(); }
  });
  it('keeps a pressed button attached while activity, thumbnails and labels refresh', async () => {
    const p = await page();
    try {
      const button = p.locator('[data-client="agent-a"] [data-a="pause"]'), box = await button.boundingBox();
      await p.evaluate(() => { window.pressedButton = document.querySelector('[data-a="pause"]'); });
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down();
      await p.evaluate(() => { window.fixture.spaces[0].title = 'Nueva actividad'; window.fixture.spaces[0].state = 'working'; window.pushState(window.fixture); });
      assert.equal(await p.evaluate(() => window.pressedButton === document.querySelector('[data-a="pause"]')), true);
      await p.mouse.up(); await p.waitForFunction(() => window.calls.length === 1);
      assert.deepEqual(await p.evaluate(() => window.calls[0]), { name: 'control', args: { action: 'pause', clientId: 'agent-a', profile: 'BROWSER2' } });
    } finally { await p.close(); }
  });
  it('shows rejected actions and permits a retry, preventing duplicate pending actions', async () => {
    const p = await page();
    try {
      const button = p.locator('[data-client="agent-a"] [data-a="focus"]');
      await p.evaluate(() => { window.rejectControl = true; }); await button.click();
      await p.getByRole('alert').filter({ hasText: 'No se pudo mostrar' }).waitFor();
      await p.evaluate(() => { window.rejectControl = false; window.deferControl = true; }); await button.click();
      assert.equal(await button.isDisabled(), true);
      await p.evaluate(() => { window.fixture.spaces[0].title = 'Actualización pendiente'; window.pushState(window.fixture); document.querySelector('[data-a="focus"]').click(); });
      assert.equal(await p.evaluate(() => window.calls.length), 2);
      await p.evaluate(() => window.finishControl()); await p.waitForFunction(() => !document.querySelector('[data-a="focus"]').disabled);
    } finally { await p.close(); }
  });
  it('opens captures and leaves the center open when the capture closes with Escape', async () => {
    const p = await page();
    try {
      await p.evaluate(() => { window.fixture.spaces[0].state = 'review'; window.pushState(window.fixture); });
      await p.locator('[data-a="screenshot"]').click(); await p.locator('dialog[open]').waitFor();
      assert.match(await p.locator('dialog img').getAttribute('src'), /^data:image\/png;base64,/);
      await p.keyboard.press('Escape'); assert.equal(await p.locator('dialog').evaluate(el => el.open), false);
      assert.equal(await p.evaluate(() => window.calls.length), 1);
    } finally { await p.close(); }
  });
});
