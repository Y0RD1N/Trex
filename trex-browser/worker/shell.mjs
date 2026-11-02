// Trex Browser shell integration. The shell is an Electron executable that
// Playwright launches like Chromium (CDP over --remote-debugging-pipe, no
// port). Its own UI documents are WebContents too: they are recognised by CDP
// target id and never exposed to agents as tabs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const BINARY = process.platform === 'win32' ? 'trex-browser-shell.exe' : 'trex-browser-shell';

// Which browser agents get: 'auto' (Trex Browser when installed, else Chrome),
// 'trex' (same, explicit) or 'chrome' (the installed Chrome/Chromium/Edge).
export const ENGINES = ['auto', 'trex', 'chrome'];
export function readEngine(home) {
  try { const value = JSON.parse(fs.readFileSync(path.join(home, 'engine.json'), 'utf8')).engine; return ENGINES.includes(value) ? value : 'auto'; }
  catch { return 'auto'; }
}

/** Packaged shell beside the runtime, or the development Electron binary. */
export function detectShell(engine = 'auto') {
  if (process.env.TREX_BROWSER_ENGINE === 'chrome' || engine === 'chrome') return null;
  const candidates = [];
  if (process.env.TREX_BROWSER_SHELL) candidates.push(process.env.TREX_BROWSER_SHELL);
  candidates.push(process.platform === 'darwin'
    ? path.join(here, 'shell', 'Trex Browser.app', 'Contents', 'MacOS', 'Electron')
    : path.join(here, 'shell', BINARY));
  if (process.env.TREX_BROWSER_DEV === '1') {
    const dist = path.join(here, '..', 'shell', 'node_modules', 'electron', 'dist');
    candidates.push(process.platform === 'win32' ? path.join(dist, 'electron.exe')
      : process.platform === 'darwin' ? path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron') : path.join(dist, 'electron'));
  }
  for (const executablePath of candidates) try { if (fs.statSync(executablePath).isFile()) return { available: true, channel: 'trex-shell', executablePath, shell: true }; } catch {}
  return null;
}

async function targetIdOf(context, page) {
  const cdp = await context.newCDPSession(page);
  try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await cdp.detach().catch(() => {}); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class ShellLink {
  /** Waits for the shell UI and marks every UI document before tabs are attached. */
  static async connect(context, onEvent, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let ui;
    while (!(ui = context.pages().find(p => p.url() === 'trex://ui/index.html'))) {
      if (Date.now() > deadline) throw new Error('Trex Browser shell UI did not start');
      await sleep(40);
    }
    const link = new ShellLink(context, ui);
    const uiTargets = new Set(await link.call('uiTargets'));
    const found = new Set();
    while (true) {
      for (const p of context.pages()) {
        const id = found.size < uiTargets.size ? await targetIdOf(context, p).catch(() => null) : null;
        if (uiTargets.has(id)) { found.add(id); link.ui.add(p); }
      }
      if (found.size >= uiTargets.size) break;
      if (Date.now() > deadline) throw new Error('Trex Browser shell UI documents were not all found');
      await sleep(40);
    }
    await ui.exposeBinding('__trexWorkerEvent', (_source, message) => { try { onEvent(message); } catch {} });
    await ui.evaluate(() => window.trexShell.onWorkerEvent(m => window.__trexWorkerEvent(m)));
    return link;
  }
  constructor(context, uiPage) { this.context = context; this.uiPage = uiPage; this.ui = new WeakSet(); this.ui.add(uiPage); this.last = new Map(); }
  isUi(page) { return this.ui.has(page); }
  call(name, args) { return this.uiPage.evaluate(([n, a]) => window.trexShell.worker(n, a), [name, args ?? {}]); }
  /** Fire-and-forget UI updates; identical payloads are skipped. */
  push(name, payload) {
    const json = JSON.stringify(payload);
    if (this.last.get(name) === json) return;
    this.last.set(name, json);
    this.call(name, payload).catch(() => {});
  }
  async newTab(url) {
    const { targetId } = await this.call('newTab', { url, activate: true });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      for (const p of this.context.pages()) if (!this.ui.has(p) && await targetIdOf(this.context, p).catch(() => null) === targetId) return p;
      await sleep(40);
    }
    throw new Error('New tab did not attach');
  }
  async select(page) { return this.call('selectTarget', { targetId: await targetIdOf(this.context, page) }); }
  focus() { return this.call('focusWindow').catch(() => false); }
}

// ---- Agent activity, as shown by the shell -------------------------------
const host = url => { try { return new URL(url).host; } catch { return ''; } };
/** A short, non-sensitive description of what a tool is doing (never typed text). */
export function describe(name, args = {}) {
  switch (name) {
    case 'browser_navigate': return host(args.url) || '';
    case 'browser_click': case 'browser_hover': case 'browser_type': case 'browser_select_option': case 'browser_file_upload':
      return String(args.element || args.name || args.role || args.ref || args.selector || '').slice(0, 60);
    case 'browser_fill_form': return Array.isArray(args.fields) ? `${args.fields.length} campos` : '';
    case 'browser_press_key': return String(args.key || '').slice(0, 30);
    case 'browser_batch': return Array.isArray(args.steps) ? `${args.steps.length} pasos` : '';
    case 'browser_tabs': return String(args.action || 'list');
    case 'browser_save_download': return String(args.destination || '').split(/[\\/]/).filter(Boolean).pop()?.slice(0, 60) || '';
    default: return '';
  }
}
export function agentState(s) {
  if (s.paused) return s.pauseReason === 'manual' ? 'paused' : 'review';
  if (s.active || (s.lastOp && Date.now() - s.lastOp.at < 1500)) return 'working';
  return s.browser ? 'idle' : 'closed';
}

/** Trex labels spaces "Agent · Chat title"; collapse "Claude Code · Claude Code". */
export function spaceLabel(label) {
  const parts = String(label || '').split(' · ').map(p => p.trim()).filter(Boolean);
  return [...new Set(parts)].join(' · ').slice(0, 100);
}

// ---- Human windows (no automation) ---------------------------------------
// A person's own Trex Browser window is launched directly, without CDP or
// automation flags: sites that refuse automated browsers (YouTube playback,
// Cloudflare, Google sign-in) work there. Agent spaces stay honestly automated.
/** pid of the browser holding a Chromium user-data dir, or 0. */
export function profileHolder(userData) {
  try {
    const target = fs.readlinkSync(path.join(userData, 'SingletonLock')); // "<host>-<pid>"
    const pid = Number(target.slice(target.lastIndexOf('-') + 1));
    if (!Number.isInteger(pid) || pid <= 0) return 0;
    process.kill(pid, 0); return pid;
  } catch { return 0; }
}
export function openHumanWindow({ executablePath, userData, label, url, env }) {
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  // Already open: the new process hands its URL to that window, focuses it and exits.
  const reused = !!profileHolder(userData);
  const args = [`--user-data-dir=${userData}`];
  if (url) args.push(url);
  const child = spawn(executablePath, args, { detached: true, stdio: 'ignore', env: { ...env, TREX_SPACE_LABEL: label } });
  child.unref();
  return { opened: true, ...(reused ? { reused: true } : { pid: child.pid }) };
}
