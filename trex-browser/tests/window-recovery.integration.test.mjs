import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { detectShell } from '../worker/shell.mjs';

process.env.TREX_BROWSER_DEV ??= '1';
const executable = detectShell()?.executablePath;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch(args = []) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-window-recovery-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: executable, args: [...args, `--user-data-dir=${userData}`], env });
  const deadline = Date.now() + 10000;
  let ui;
  while (!(ui = application.context().pages().find(page => page.url() === 'trex://ui/index.html'))) {
    assert.ok(Date.now() < deadline, 'Shell UI did not load'); await pause(30);
  }
  await ui.waitForLoadState();
  const state = () => application.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0];
    return { minimized: win.isMinimized(), content: win.getContentBounds(),
      views: win.contentView.children.filter(v => v.getVisible()).map(v => ({ url: v.webContents.getURL(), crashed: v.webContents.isCrashed(), ...v.getBounds() })) };
  });
  const until = async (check, label, ms = 5000) => {
    for (const end = Date.now() + ms; ;) { const now = await state(); if (check(now)) return now; if (Date.now() > end) return assert.fail(`${label}: ${JSON.stringify(now)}`); await pause(100); }
  };
  return { application, ui, state, until };
}

// Agents keep working while the window is minimized. Windows reports a 0x0 client area then, and the
// page, frame and bar used to be laid out at that size; restoring emits no resize, so the window came
// back as bare glass until something else moved a view.
it('agent activity while minimized does not leave the restored window empty', {
  skip: !executable || process.platform !== 'win32',
  timeout: 45000,
}, async t => {
  const { application, ui, state, until } = await launch();
  try {
    await until(s => s.views.length >= 2 && s.views.every(v => v.width > 0 && v.height > 0), 'initial layout');
    await application.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].minimize());
    for (let end = Date.now() + 5000; !(await state()).minimized;) {
      if (Date.now() > end) return t.skip('this desktop session does not minimize windows');
      await pause(100);
    }
    for (let i = 0; i < 5; i++) await ui.evaluate(n => window.trexShell.worker('setAgent', { label: 'Fixture', state: n % 2 ? 'working' : 'idle', tool: 'browser_click' }), i);
    await application.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].restore());
    const restored = await until(s => !s.minimized && s.views.every(v => v.width > 0 && v.height > 0), 'views stayed empty after restore');
    const chrome = restored.views.find(v => v.url === 'trex://ui/index.html');
    assert.deepEqual([chrome.width, chrome.height], [restored.content.width, restored.content.height]);
  } finally { await application.close(); }
});

it('the frame and bar load again when their renderer dies', {
  skip: !executable || process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
  timeout: 45000,
}, async () => {
  const { application, until } = await launch(['--headless']);
  try {
    await until(s => s.views.some(v => v.url === 'trex://ui/index.html'), 'frame view');
    await application.evaluate(({ BaseWindow }) => {
      for (const v of BaseWindow.getAllWindows()[0].contentView.children) if (v.webContents.getURL().startsWith('trex://ui/')) v.webContents.forcefullyCrashRenderer();
    });
    await until(s => s.views.some(v => v.crashed), 'renderers did not crash', 3000).catch(() => {});
    const back = await until(s => s.views.filter(v => v.url.startsWith('trex://ui/')).every(v => !v.crashed), 'UI documents were not reloaded', 8000);
    assert.ok(back.views.some(v => v.url === 'trex://ui/index.html'));
    // The reloaded frame answers again (its own state request goes through the main process). Asked from
    // the main process: Playwright keeps treating a crashed target as dead even after it loads again.
    const answer = await application.evaluate(({ BaseWindow }) => {
      const frame = BaseWindow.getAllWindows()[0].contentView.children.find(v => v.webContents.getURL() === 'trex://ui/index.html');
      return frame.webContents.executeJavaScript('window.trexShell.state().then(s => Array.isArray(s.tabs))');
    });
    assert.equal(answer, true);
  } finally { await application.close(); }
});
