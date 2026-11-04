import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { detectBrowser } from '../worker/browser.mjs';

const detected = detectBrowser('chrome'), ui = new URL('../shell/ui/', import.meta.url);
const html = fs.readFileSync(new URL('overlay.html', ui), 'utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const theme = fs.readFileSync(new URL('theme.css', ui), 'utf8').replace(/^@import[^;]+;/m, '');
const icons = fs.readFileSync(new URL('icons.js', ui), 'utf8').replace(/^export /gm, '');
const patch = fs.readFileSync(new URL('patch-dom.js', ui), 'utf8').replace(/^export /gm, '');
const script = fs.readFileSync(new URL('overlay.js', ui), 'utf8').replace(/^import[^;]+;/gm, '');
let browser;
async function fixture(part = 'island') {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.route('**/*', route => route.abort());
  await page.route('https://trex-overlay.test/**', route => route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<style>${theme}</style></head>`) }));
  await page.goto(`https://trex-overlay.test/?part=${part}`);
  await page.evaluate(() => {
    window.calls = [];
    window.fixture = { platform: 'win32', automation: true, centerOpen: false, activeTab: 't1', canGoBack: false, canGoForward: false, zoom: 100,
      find: { open: false, query: '', total: 0 }, prompts: [], downloads: [], spaces: [],
      tabs: [{ id: 't1', url: 'https://fixture.test/', title: 'Fixture', loading: false, owner: 'Principal' }],
      agent: { label: 'Principal', state: 'working', tool: 'browser_click', detail: 'Guardar', model: 'Fixture' } };
    window.trexShell = { onState(fn) { window.pushState = fn; }, onReveal(fn) { window.reveal = fn; }, onPageFocus(fn) { window.pageFocus = fn; },
      state: async () => window.fixture, command: async (name, args) => window.calls.push({ name, args }) };
  });
  await page.addScriptTag({ type: 'module', content: icons + '\n' + patch + '\n' + script });
  await page.locator('#root > *').waitFor();
  if (part === 'island') { await page.evaluate(() => window.reveal()); await page.locator('.topbar').waitFor(); }
  return page;
}

describe('stable browser overlays during agent work', { skip: !detected.available && 'System Chromium unavailable', concurrency: false }, () => {
  before(async () => { browser = await chromium.launch({ executablePath: detected.executablePath, headless: true }); });
  after(async () => { await browser?.close(); });

  it('explains embedded Google sign-in and opens the system browser only after the person clicks', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => { window.fixture.tabs[0].url = 'https://accounts.google.com/signin'; window.pushState(window.fixture); });
      const notice = page.locator('[data-key=google-signin]');
      await notice.waitFor();
      assert.match(await notice.innerText(), /Google bloquea/);
      assert.equal((await page.evaluate(() => window.calls.filter(call => call.name === 'openExternal'))).length, 0);
      await notice.locator('button').click();
      assert.equal((await page.evaluate(() => window.calls.filter(call => call.name === 'openExternal'))).length, 1);
      await page.evaluate(() => { window.fixture.tabs[0].url = 'https://fixture.test/'; window.pushState(window.fixture); });
      assert.equal(await notice.count(), 0);
    } finally { await page.close(); }
  });

  it('keeps the bar, pressed controls and loading animation attached across activity and tab updates', async () => {
    const page = await fixture();
    try {
      const result = await page.evaluate(() => {
        const bar = document.querySelector('.topbar'), button = document.querySelector('[data-c=back]'), tab = document.querySelector('[data-tab=t1]');
        let removals = 0;
        const observer = new MutationObserver(records => { removals += records.filter(record => [...record.removedNodes].some(node => node === bar || node === button || node === tab)).length; });
        observer.observe(document.querySelector('#root'), { childList: true, subtree: true });
        for (let i = 0; i < 100; i++) { window.fixture.agent.tool = `work-${i}`; window.fixture.agent.detail = `Step ${i}`; window.fixture.spaces = [{ at: i }]; window.pushState(window.fixture); }
        window.fixture.tabs.push({ id: 't2', url: 'https://fixture.test/peer', title: 'Other agent', owner: 'Peer' }); window.pushState(window.fixture);
        window.fixture.canGoBack = true; window.pushState(window.fixture);
        const same = bar === document.querySelector('.topbar') && button === document.querySelector('[data-c=back]') && tab === document.querySelector('[data-tab=t1]');
        return new Promise(resolve => queueMicrotask(() => { observer.disconnect(); resolve({ same, removals, enabled: !button.disabled }); }));
      });
      assert.deepEqual(result, { same: true, removals: 0, enabled: true });
      await page.locator('[data-c=back]').click();
      assert.equal((await page.evaluate(() => window.calls.filter(call => call.name === 'back'))).length, 1);
    } finally { await page.close(); }
  });

  it('preserves the address draft, caret and focus while tabs and permission notices update', async () => {
    const page = await fixture();
    try {
      const input = page.locator('.url input'); await input.fill('https://draft.test/');
      const result = await page.evaluate(() => {
        const input = document.querySelector('.url input'); input.setSelectionRange(8, 13);
        for (let i = 0; i < 20; i++) { window.fixture.tabs[0].title = `Update ${i}`; window.fixture.prompts = [{ id: i, origin: 'https://fixture.test', label: 'usar la cámara' }]; window.pushState(window.fixture); }
        return { same: input === document.querySelector('.url input'), focused: document.activeElement === input, value: input.value, start: input.selectionStart, end: input.selectionEnd };
      });
      assert.deepEqual(result, { same: true, focused: true, value: 'https://draft.test/', start: 8, end: 13 });
      await input.press('Enter'); assert.equal((await page.evaluate(() => window.calls.filter(call => call.name === 'navigate'))).length, 1);
    } finally { await page.close(); }
  });

  it('updates find results and keyboard actions without recreating the input', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => { window.fixture.find = { open: true, query: '', total: 0 }; window.pushState(window.fixture); });
      const input = page.locator('input.find'); await input.fill('fixture');
      await page.evaluate(() => { window.savedFind = document.querySelector('input.find'); window.fixture.find = { open: true, query: 'fixture', total: 3, active: 2 }; window.pushState(window.fixture); });
      assert.equal(await page.evaluate(() => window.savedFind === document.querySelector('input.find')), true);
      assert.equal(await page.locator('.findrow .count').textContent(), '2/3');
      await input.press('Enter'); assert.equal((await page.evaluate(() => window.calls.filter(call => call.name === 'find' && call.args.next))).length, 1);
    } finally { await page.close(); }
  });

  it('keeps the dock pulse and buttons alive while tools change and peer thumbnails refresh', async () => {
    const page = await fixture('dock');
    try {
      assert.equal(await page.evaluate(() => {
        const dock = document.querySelector('.dock'), pulse = document.querySelector('.pulse'), button = document.querySelector('[data-k=pause]');
        for (let i = 0; i < 100; i++) { window.fixture.agent.detail = `Step ${i}`; window.fixture.agent.tool = i%2 ? 'browser_click' : 'browser_type'; window.pushState(window.fixture); }
        return dock === document.querySelector('.dock') && pulse === document.querySelector('.pulse') && button === document.querySelector('[data-k=pause]');
      }), true);
      await page.locator('[data-k=pause]').click(); assert.equal((await page.evaluate(() => window.calls.filter(call => call.name === 'control'))).length, 1);
    } finally { await page.close(); }
  });
});
