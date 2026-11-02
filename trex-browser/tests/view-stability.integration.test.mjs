import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { detectShell } from '../worker/shell.mjs';

process.env.TREX_BROWSER_DEV ??= '1';
const executable = detectShell()?.executablePath;
it('real Electron activity does not resize, hide or detach the page, including when a background tab opens', {
  skip: !executable || process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
  timeout: 45000,
}, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-view-stability-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: executable, args: ['--headless', `--user-data-dir=${userData}`], env });
  try {
    const deadline = Date.now()+10000;
    let ui;
    while (!(ui = application.context().pages().find(page => page.url() === 'trex://ui/index.html'))) {
      assert.ok(Date.now()<deadline, 'Shell UI did not load'); await new Promise(resolve => setTimeout(resolve, 30));
    }
    await ui.waitForLoadState();
    await ui.evaluate(() => window.trexShell.worker('setAgent', { label: 'Fixture', state: 'working', tool: 'browser_click', detail: 'Ready' }));
    await new Promise(resolve => setTimeout(resolve, 350));
    await application.evaluate(({ BaseWindow }) => {
      const parent = BaseWindow.getAllWindows()[0].contentView;
      globalThis.viewAudit = { pageBounds: 0, pageVisibility: 0, detached: 0, reordered: 0, added: [] };
      for (const view of parent.children) {
        if (!['trex://ui/index.html', 'trex://newtab/'].includes(view.webContents.getURL())) continue;
        const bounds = view.setBounds.bind(view), visibility = view.setVisible.bind(view);
        view.setBounds = (...args) => { globalThis.viewAudit.pageBounds++; return bounds(...args); };
        view.setVisible = (...args) => { globalThis.viewAudit.pageVisibility++; return visibility(...args); };
      }
      const add = parent.addChildView.bind(parent), remove = parent.removeChildView.bind(parent);
      parent.addChildView = (view, index) => {
        if (parent.children.includes(view)) globalThis.viewAudit.reordered++;
        else globalThis.viewAudit.added.push(index);
        return index === undefined ? add(view) : add(view, index);
      };
      parent.removeChildView = view => { globalThis.viewAudit.detached++; return remove(view); };
    });
    await ui.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        await window.trexShell.worker('setAgent', { label: 'Fixture', state: 'working', tool: i%2 ? 'browser_click' : 'browser_type', detail: `Action ${i}` });
        await window.trexShell.worker('setSpaces', [{ clientId: 'peer', tool: `work-${i}`, events: [] }]);
      }
      await window.trexShell.worker('newTab', { activate: false });
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    const audit = await application.evaluate(() => globalThis.viewAudit);
    assert.deepEqual(audit, { pageBounds: 0, pageVisibility: 0, detached: 0, reordered: 0, added: [0] });
  } finally { await application.close(); }
});
