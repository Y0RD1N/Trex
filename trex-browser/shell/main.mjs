// Trex Browser shell: a frameless glass window whose tabs are WebContentsViews.
// The worker launches this executable the same way it launched Chrome
// (Playwright launchPersistentContext over --remote-debugging-pipe), so no
// debugging port is opened. Automated spaces share one project window.
import { app, BaseWindow, WebContentsView, ipcMain, protocol, net, session, nativeTheme, Menu, clipboard, shell as desktop } from 'electron';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { humanControls } from './human-controls.mjs';
import { storageCommand, scopedDownload, grantedPermission } from './scope-storage.mjs';
import { setBounds, setVisible, keepOnTop } from './view-layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(here, 'ui');
const UI_ORIGIN = 'trex://ui';
const FRAME = 7;                 // visible glass frame around the page
const RADIUS = 12;
const OVERLAY_PAD = 16;          // matches #root padding in ui/overlay.html

/** Opened from the desktop icon / app menu (no profile given): the person's own
 * profile, the same one trex opens with "Abrir Trex Browser personal".
 * Mirrors privateHomePath() in worker/security.mjs. */
function personalProfile() {
  const env = process.env, home = app.getPath('home');
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  const root = path.resolve(env.TREX_BROWSER_HOME || (process.platform === 'linux' ? path.join(state, 'trex-browser')
    : path.join(env.LOCALAPPDATA || home, process.platform === 'win32' ? 'TrexBrowser' : '.trex-browser')));
  try {
    if (!fs.existsSync(root)) {
      // On Windows only the native launcher may create the private home (it sets its ACL).
      if (process.platform === 'win32') execFileSync(path.resolve(path.dirname(process.execPath), '..', '..', 'trex-browser.exe'), ['prepare', '--json'], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
      else fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    if (!fs.statSync(root).isDirectory()) return null;
    const dir = path.join(root, 'personal', 'user-data');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch { return null; }
}
// Playwright passes Chromium flags; honour the profile directory it chose.
const argValue = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const userDataDir = argValue('user-data-dir');
// Playwright's headless flag (tests/CI): keep rendering, never show the window.
const HEADLESS = process.argv.some(a => a === '--headless' || a.startsWith('--headless='));
// Launched by the worker (Playwright over the CDP pipe) rather than by a person.
const AUTOMATION = process.argv.includes('--remote-debugging-pipe');
const SHARED_ROOT = AUTOMATION && process.env.TREX_SHARED_PROJECT_ROOT && path.isAbsolute(process.env.TREX_SHARED_PROJECT_ROOT) ? path.resolve(process.env.TREX_SHARED_PROJECT_ROOT) : null;
if (userDataDir) app.setPath('userData', path.resolve(userDataDir));
else if (!AUTOMATION && app.isPackaged) { const personal = personalProfile(); if (personal) app.setPath('userData', personal); }
app.setName('Trex Browser');
// One process per profile (Chromium's SingletonLock in userData). A second
// launch on the same profile hands its URL to the running window and exits.
if (!app.requestSingleInstanceLock({ url: process.argv.slice(1).find(a => /^https?:\/\//.test(a)) || null })) { app.quit(); process.exit(0); }
// Windows does not expose Chromium's SingletonLock as a symlink. Advertise a
// manual sign-in window so shared agent sessions never open its storage too.
if (!AUTOMATION) {
  const dir = app.getPath('userData'), marker = path.join(dir, 'trex-human-window.json'), nonce = randomUUID();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${marker}.${nonce}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, marker);
  app.on('will-quit', () => { try { if (JSON.parse(fs.readFileSync(marker, 'utf8')).nonce === nonce) fs.unlinkSync(marker); } catch {} });
}
app.on('second-instance', (_e, _argv, _cwd, data) => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  if (data?.url && /^https?:\/\//.test(data.url)) createTab(data.url);
});
nativeTheme.themeSource = 'dark';

protocol.registerSchemesAsPrivileged([{ scheme: 'trex', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/** @type {BaseWindow} */ let win;
/** @type {WebContentsView} */ let chromeView;        // full-window UI: frame, agents center
const overlays = new Map();                          // part -> {view, rect}
const tabs = new Map();                              // id -> {id, view, title, url, favicon, loading}
const scopes = new Map(), closingScopes = new Set();
let activeTab = null, nextTab = 1, centerOpen = false;
let agent = { label: process.env.TREX_SPACE_LABEL || 'Agente', model: '', state: 'idle', tool: '', detail: '', step: '' };
let spaces = [];                                     // agents center inventory, pushed by the worker
let find = { open: false, query: '', active: 0, total: 0 };
let cursor = null, cursorShown = null, cursorTimer = null;      // agent pointer, in page CSS px
const downloads = new Map();                         // id -> {id, name, state, received, total, path, item}
const prompts = new Map();                           // id -> {id, tabId, origin, permission, label, done, timer}
let nextId = 1;

const uiPreload = path.join(here, 'preload.cjs');
// Our UI lives in its own in-memory session: only that session serves
// trex://ui, so web pages cannot even reach those documents.
const UI_PARTITION = 'trex-ui';
const uiPrefs = { preload: uiPreload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: UI_PARTITION };

function serveFrom(hosts) {
  return request => {
    const url = new URL(request.url);
    if (!hosts.includes(url.host)) return new Response('not found', { status: 404 });
    const name = url.host === 'newtab' && url.pathname === '/' ? '/newtab.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(UI_ROOT, name));
    if (!file.startsWith(UI_ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  };
}
function serveUi() {
  session.fromPartition(UI_PARTITION).protocol.handle('trex', serveFrom(['ui', 'newtab']));
  // Pages only get the new tab page (and its assets).
  protocol.handle('trex', request => {
    const url = new URL(request.url);
    if (url.host !== 'newtab') return Response.error();
    return serveFrom(['newtab'])(request);
  });
}

// UI documents are the views this process created for its own interface;
// never decide it from a URL, which a page can try to reach.
const uiContents = new WeakSet();
const isUi = wc => !!wc && uiContents.has(wc);

function snapshot() {
  if (SHARED_ROOT) agent = scopes.get(tabs.get(activeTab)?.profile)?.agent ?? { label: 'Trex Browser', model: '', state: 'idle', tool: '', detail: '', step: '' };
  return {
    tabs: [...tabs.values()].map(t => ({ id: t.id, title: t.title, url: t.url, favicon: t.favicon, loading: t.loading, ...(t.profile ? { profile: t.profile, owner: scopes.get(t.profile)?.agent.label || t.profile } : {}) })),
    activeTab, centerOpen, agent, spaces: SHARED_ROOT ? spaces.map(sp => ({ ...sp, self: sp.profile === tabs.get(activeTab)?.profile })) : spaces,
    canGoBack: tabs.get(activeTab)?.view.webContents.navigationHistory.canGoBack() ?? false,
    canGoForward: tabs.get(activeTab)?.view.webContents.navigationHistory.canGoForward() ?? false,
    maximized: win && !win.isDestroyed() ? win.isMaximized() : false,
    zoom: Math.round((tabs.get(activeTab)?.view.webContents.getZoomFactor() ?? 1) * 100),
    find,
    downloads: [...downloads.values()].slice(-8).reverse().map(({ item, ...d }) => d),
    prompts: [...prompts.values()].map(({ done, timer, ...p }) => p),
    automation: AUTOMATION,
    project: process.env.TREX_PROJECT_LABEL || '',
    platform: process.platform,
  };
}
let broadcastQueued = false;
function broadcast() {
  if (broadcastQueued || closing) return; broadcastQueued = true;
  queueMicrotask(() => {
    broadcastQueued = false;
    const state = snapshot();
    saveSession();
    for (const v of [chromeView, ...[...overlays.values()].map(o => o.view)]) if (v && !v.webContents.isDestroyed()) v.webContents.send('shell:state', state);
  });
}

function layout() {
  if (!win || win.isDestroyed()) return;
  if (SHARED_ROOT) snapshot();
  const { width, height } = win.getContentBounds();
  setBounds(chromeView, { x: 0, y: 0, width, height });
  const page = { x: FRAME, y: FRAME, width: Math.max(0, width - FRAME * 2), height: Math.max(0, height - FRAME * 2) };
  for (const t of tabs.values()) {
    // Background agent tabs must keep a live input/render surface. Their views
    // stay underneath the selected page instead of being hidden by Electron.
    setVisible(t.view, SHARED_ROOT ? true : t.id === activeTab && !centerOpen);
    setBounds(t.view, page);
  }
  const front = centerOpen ? chromeView : tabs.get(activeTab)?.view;
  keepOnTop(win.contentView, centerOpen ? [chromeView] : [front, ...[...overlays.values()].map(o => o.view)].filter(Boolean));
  for (const [part, o] of overlays) {
    const r = o.rect; if (!r) continue;
    let x, y;
    // Overlay documents keep OVERLAY_PAD px of transparent room for their shadow.
    const inset = FRAME + 10 - OVERLAY_PAD;
    if (part === 'island') { // full-width strip at the top; the bar is centred inside it
      setBounds(o.view, { x: 0, y: 0, width, height: r.height });
    } else {
      x = Math.round(width / 2 - r.width / 2); y = height - inset - r.height;
      setBounds(o.view, { x, y, width: r.width, height: r.height });
    }
    if (part === 'cursor') { placeCursor(); continue; }
    setVisible(o.view, !centerOpen && (part !== 'dock' || agent.state !== 'idle'));
    debug('overlay', part, JSON.stringify(o.view.getBounds()), 'visible', o.view.getVisible());
  }
}
/** Show the top bar (Ctrl+L, new tab) and optionally focus the address field. */
function revealBar(focus = false, panel = null) {
  const island = overlays.get('island'); if (!island) return;
  if (focus) island.view.webContents.focus();
  island.view.webContents.send('shell:reveal', { focus, panel });
}

// ---- Agent cursor --------------------------------------------------------
// A small transparent view that glides to where the agent acts. Agent input
// travels over CDP, so this view never intercepts it.
const CURSOR_TIP = { x: 4, y: 4 };    // arrow tip inside overlay.html?part=cursor
let cursorAnim = null;
function cursorTarget() {
  const zoom = tabs.get(activeTab)?.view.webContents.getZoomFactor() ?? 1;
  return { x: FRAME + cursor.x * zoom - CURSOR_TIP.x, y: FRAME + cursor.y * zoom - CURSOR_TIP.y };
}
function placeCursor() {
  const o = overlays.get('cursor'); if (!o) return;
  const show = !!cursor && !centerOpen && agent.state === 'working' && !HEADLESS;
  if (!show) { setVisible(o.view, false); cursorShown = null; return; }
  const p = cursorShown ?? cursorTarget();
  setBounds(o.view, { x: Math.round(p.x), y: Math.round(p.y), width: 220, height: 44 });
  setVisible(o.view, true);
}
function animateCursor() {
  clearInterval(cursorAnim);
  if (!cursor || HEADLESS) return layout();
  const to = cursorTarget(), from = cursorShown ?? to, start = Date.now(), duration = 220;
  cursorAnim = setInterval(() => {
    const t = Math.min(1, (Date.now() - start) / duration), k = 1 - Math.pow(1 - t, 3);
    cursorShown = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    placeCursor();
    if (t >= 1) clearInterval(cursorAnim);
  }, 16);
}

// ---- Context menu (pages only) -------------------------------------------
const searchUrl = text => `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
function contextMenu(tab, p) {
  if (HEADLESS) return; // a hidden Wayland window cannot parent a menu
  const wc = tab.view.webContents, history = wc.navigationHistory, items = [];
  const sep = () => { if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' }); };
  if (p.linkURL && /^https?:/i.test(p.linkURL)) {
    items.push({ label: 'Abrir enlace en pestaña nueva', click: () => createTab(p.linkURL, { activate: false, profile: tab.profile }) },
      { label: 'Copiar dirección del enlace', click: () => clipboard.writeText(p.linkURL) }); sep();
  }
  if (p.mediaType === 'image' && /^(https?|data):/i.test(p.srcURL)) {
    items.push({ label: 'Abrir imagen en pestaña nueva', click: () => createTab(p.srcURL, { activate: false, profile: tab.profile }) },
      { label: 'Copiar imagen', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Guardar imagen como…', click: () => wc.downloadURL(p.srcURL) }); sep();
  }
  const selection = p.selectionText?.trim();
  if (p.isEditable) {
    items.push({ role: 'undo', label: 'Deshacer', enabled: p.editFlags.canUndo }, { role: 'redo', label: 'Rehacer', enabled: p.editFlags.canRedo }, { type: 'separator' },
      { role: 'cut', label: 'Cortar', enabled: p.editFlags.canCut }, { role: 'copy', label: 'Copiar', enabled: p.editFlags.canCopy },
      { role: 'paste', label: 'Pegar', enabled: p.editFlags.canPaste }, { role: 'selectAll', label: 'Seleccionar todo' }); sep();
  } else if (selection) {
    const short = selection.length > 32 ? `${selection.slice(0, 32)}…` : selection;
    items.push({ role: 'copy', label: 'Copiar' }, { label: `Buscar «${short}»`, click: () => createTab(searchUrl(selection), { profile: tab.profile }) }); sep();
  }
  if (!p.isEditable && !selection && !p.linkURL && p.mediaType !== 'image') {
    items.push({ label: 'Atrás', enabled: history.canGoBack(), click: () => history.goBack() },
      { label: 'Adelante', enabled: history.canGoForward(), click: () => history.goForward() },
      { label: 'Recargar', click: () => wc.reload() }); sep();
    items.push({ label: 'Buscar en la página…', click: () => commands.findOpen() }); sep();
  }
  items.push({ label: 'Inspeccionar', click: () => { if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' }); wc.inspectElement(p.x, p.y); } });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---- Site permissions ----------------------------------------------------
// Prompted permissions are remembered per origin in this profile; anything not
// listed is denied. CDP grants from the worker bypass this handler.
const PROMPTED = { media: 'usar tu cámara o micrófono', geolocation: 'conocer tu ubicación', notifications: 'mostrar notificaciones',
  'clipboard-read': 'leer tu portapapeles', midi: 'usar dispositivos MIDI', 'display-capture': 'compartir tu pantalla', openExternal: 'abrir una aplicación externa' };
const SILENT = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
let decisions = null;
const decisionsFile = () => path.join(app.getPath('userData'), 'trex-permissions.json');
function loadDecisions() { if (decisions) return decisions; try { decisions = JSON.parse(fs.readFileSync(decisionsFile(), 'utf8')); } catch { decisions = {}; } return decisions; }
function saveDecisions() { try { fs.writeFileSync(decisionsFile(), JSON.stringify(decisions), { mode: 0o600 }); } catch {} }
const originOf = url => { try { return new URL(url).origin; } catch { return ''; } };
function permissionLabel(permission, details) {
  if (permission === 'media') { const t = details?.mediaTypes ?? []; return t.includes('video') && t.includes('audio') ? 'usar tu cámara y micrófono' : t.includes('video') ? 'usar tu cámara' : 'usar tu micrófono'; }
  return PROMPTED[permission];
}
function requestPermission(wc, permission, done, details) {
  if (SILENT.has(permission)) return done(true);
  const tab = [...tabs.values()].find(t => t.view.webContents === wc);
  const origin = originOf(details?.requestingUrl || wc.getURL());
  if (tab && grantedPermission(scopes.get(tab.profile), permission, origin)) return done(true);
  if (!tab || !PROMPTED[permission] || !origin || HEADLESS) return done(false);
  const key = `${tab.profile ? tab.profile + '|' : ''}${origin}|${permission}`, saved = loadDecisions()[key];
  if (saved !== undefined) return done(saved);
  const id = nextId++;
  const timer = setTimeout(() => resolvePrompt(id, false, false), 120_000);
  prompts.set(id, { id, tabId: tab.id, origin, permission, label: permissionLabel(permission, details), done, timer, key });
  broadcast(); revealBar(false);
}
function resolvePrompt(id, allow, remember) {
  const p = prompts.get(id); if (!p) return;
  prompts.delete(id); clearTimeout(p.timer);
  if (remember) { loadDecisions()[p.key] = allow; saveDecisions(); }
  try { p.done(allow); } catch {}
  broadcast();
}
function denyPrompts(tabId) { for (const p of [...prompts.values()]) if (p.tabId === tabId) resolvePrompt(p.id, false, false); }

// ---- Downloads -----------------------------------------------------------
// When the worker drives the browser, Playwright owns download paths
// (private artifacts); the shell only shows progress. A person's downloads go
// to the user's Downloads folder with a unique name.
function uniquePath(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext) || 'descarga';
  for (let i = 0; ; i++) { const candidate = path.join(dir, i ? `${base} (${i})${ext}` : `${base}${ext}`); if (!fs.existsSync(candidate)) return candidate; }
}
function trackDownload(_event, item) {
  if (!AUTOMATION && !item.getSavePath()) item.setSavePath(uniquePath(app.getPath('downloads'), item.getFilename()));
  const id = nextId++;
  const d = { id, name: item.getFilename(), state: 'progressing', received: 0, total: item.getTotalBytes(), path: item.getSavePath(), item };
  downloads.set(id, d);
  let last = 0;
  item.on('updated', (_e, state) => { d.state = state === 'interrupted' ? 'interrupted' : 'progressing'; d.received = item.getReceivedBytes(); d.total = item.getTotalBytes(); d.path = item.getSavePath(); if (Date.now() - last > 250) { last = Date.now(); broadcast(); } });
  item.once('done', (_e, state) => { d.state = state; d.received = item.getReceivedBytes(); d.path = item.getSavePath(); delete d.item; broadcast(); });
  broadcast(); revealBar(false, 'downloads');
}

// ---- Session restore (people only) ---------------------------------------
const sessionFile = () => path.join(app.getPath('userData'), 'trex-session.json');
let sessionTimer = null, closing = false;
function saveSession(now = false) {
  if (AUTOMATION || closing || !win) return;
  clearTimeout(sessionTimer);
  const write = () => {
    const list = [...tabs.values()].filter(t => /^https?:/i.test(t.url)).map(t => t.url);
    const active = [...tabs.values()].filter(t => /^https?:/i.test(t.url)).findIndex(t => t.id === activeTab);
    try { fs.writeFileSync(sessionFile(), JSON.stringify({ tabs: list.slice(0, 50), active }), { mode: 0o600 }); } catch {}
  };
  if (now) write(); else sessionTimer = setTimeout(write, 500);
}
function restoreSession() {
  if (AUTOMATION) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    const list = (saved.tabs ?? []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 50);
    if (!list.length) return false;
    const ids = list.map(u => createTab(u, { activate: false }));
    commands.selectTab({ id: ids[Math.max(0, Math.min(ids.length - 1, saved.active ?? 0))] });
    return true;
  } catch { return false; }
}

const debug = (...a) => { if (process.env.TREX_SHELL_DEBUG === '1') console.log('[shell]', ...a); };
function addOverlay(part) {
  const view = new WebContentsView({ webPreferences: uiPrefs });
  uiContents.add(view.webContents);
  view.setBackgroundColor('#00000000');
  view.webContents.loadURL(`${UI_ORIGIN}/overlay.html?part=${part}`);
  view.webContents.on('console-message', (e) => debug('console', part, e.level, e.message));
  view.webContents.on('did-fail-load', (_e, code, desc) => debug('fail', part, code, desc));
  view.webContents.on('did-finish-load', () => debug('loaded', part));
  // Start with a real size: a 0x0 view never paints, so it could not measure itself.
  const { width } = win.getContentBounds();
  view.setBounds(part === 'island' ? { x: 0, y: 0, width, height: 12 } : part === 'cursor' ? { x: 0, y: 0, width: 220, height: 44 } : { x: 0, y: 0, width: 720, height: 90 });
  if (part !== 'island') view.setVisible(false);
  overlays.set(part, { view, rect: null });
  win.contentView.addChildView(view);
}

const NEW_TAB = 'trex://newtab/';
function createTab(url = NEW_TAB, { activate = true, profile = tabs.get(activeTab)?.profile || scopes.keys().next().value } = {}) {
  const scope = profile && scopes.get(profile);
  if (SHARED_ROOT && !scope) return null;
  const id = `t${nextTab++}`;
  const view = new WebContentsView({ webPreferences: { ...(scope ? { session: scope.session } : {}), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: !HEADLESS && !AUTOMATION } });
  view.setBorderRadius(RADIUS);
  view.setBackgroundColor('#121212');
  const tab = { id, view, title: 'Nueva pestaña', url, favicon: null, loading: true, profile };
  tabs.set(id, tab);
  const wc = view.webContents;
  const update = () => { tab.title = wc.getTitle() || tab.title; tab.url = wc.getURL(); broadcast(); };
  wc.on('page-title-updated', update);
  wc.on('did-navigate', update);
  wc.on('did-navigate-in-page', update);
  wc.on('did-start-loading', () => { tab.loading = true; broadcast(); });
  wc.on('did-stop-loading', () => { tab.loading = false; update(); });
  wc.once('destroyed', () => {
    const targetId = targetIds.get(wc);
    if (profile && targetId) emitToWorker({ type: 'scope-target-close', profile, targetId });
    denyPrompts(id);
    if (!tabs.has(id)) return;
    // Closing the window destroys it before its tabs: only forget the tab then.
    if (closing || app.isQuitting || !win || win.isDestroyed()) { tabs.delete(id); return; }
    win.contentView.removeChildView(view); tabs.delete(id);
    if (activeTab === id) activeTab = [...tabs.keys()].at(-1) ?? null;
    if (!app.isQuitting && (SHARED_ROOT ? !closingScopes.has(profile) && ![...tabs.values()].some(t => t.profile === profile) : !tabs.size)) createTab(undefined, { profile, activate: activeTab === null });
    layout(); broadcast();
  });
  wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] ?? null; broadcast(); });
  wc.on('context-menu', (_e, params) => contextMenu(tab, params));
  // Interacting with the page dismisses transient bar panels (downloads).
  const pageInteraction = () => { const island = overlays.get('island'); if (island && !island.view.webContents.isDestroyed()) island.view.webContents.send('shell:page-focus'); };
  wc.on('focus', pageInteraction);
  wc.on('input-event', (_e, input) => { if (input.type === 'mouseDown') pageInteraction(); });
  wc.on('zoom-changed', (_e, direction) => { if (activeTab === id) commands.zoom({ delta: direction === 'in' ? 1 : -1 }); });
  wc.on('found-in-page', (_e, r) => { if (activeTab !== id) return; find = { ...find, active: r.activeMatchOrdinal ?? find.active, total: r.matches ?? find.total }; broadcast(); });
  wc.on('did-navigate', () => denyPrompts(id));
  // Tabs never load our privileged UI documents.
  // trex://ui does not exist in the pages' session (see serveUi): such a
  // navigation simply fails like any unknown address, without a cancelled
  // navigation that automation would wait on forever.
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) createTab(target, { profile, activate: !SHARED_ROOT || tabs.get(activeTab)?.profile === profile });
    return { action: 'deny' };
  });
  // Background tabs start below the visible page and chrome. They never flash
  // above the foreground while the worker attaches or the first URL loads.
  win.contentView.addChildView(view, 0);
  wc.loadURL(url).catch(() => {});
  if (activate) activeTab = id;
  layout(); broadcast();
  if (profile) void targetIdOf(wc).then(targetId => emitToWorker({ type: 'scope-target', profile, targetId })).catch(() => {});
  return id;
}

function closeTab(id) {
  const tab = tabs.get(id); if (!tab) return;
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tabs.delete(id);
  if (activeTab === id) activeTab = [...tabs.keys()].at(-1) ?? null;
  if (SHARED_ROOT ? !closingScopes.has(tab.profile) && ![...tabs.values()].some(t => t.profile === tab.profile) : !tabs.size) createTab(undefined, { profile: tab.profile, activate: activeTab === null });
  layout(); broadcast();
}

function normalizeAddress(input) {
  const text = String(input).trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

// Commands from our own UI documents only (trex://ui).
const commands = {
  navigate: ({ url }) => tabs.get(activeTab)?.view.webContents.loadURL(normalizeAddress(url)).catch(() => {}),
  back: () => tabs.get(activeTab)?.view.webContents.navigationHistory.goBack(),
  forward: () => tabs.get(activeTab)?.view.webContents.navigationHistory.goForward(),
  reload: () => tabs.get(activeTab)?.view.webContents.reload(),
  newTab: ({ url } = {}) => {
    const id = createTab(url ? normalizeAddress(url) : undefined);
    if (url) return;
    // A freshly loaded page may take keyboard focus; give it back to the address field.
    revealBar(true);
    tabs.get(id)?.view.webContents.once('did-finish-load', () => { if (activeTab === id) revealBar(true); });
  },
  selectTab: ({ id }) => { if (tabs.has(id)) { if (id !== activeTab) commands.findClose(); activeTab = id; const scope=scopes.get(tabs.get(id).profile);if(scope)scope.selectedId=id;layout(); broadcast(); } },
  closeTab: ({ id }) => closeTab(id),
  toggleCenter: async ({ open } = {}) => {
    centerOpen = open ?? !centerOpen;
    let backdrop = null;
    if (centerOpen) backdrop = await tabs.get(activeTab)?.view.webContents.capturePage().then(i => i.resize({ width: 960 }).toDataURL()).catch(() => null);
    layout(); broadcast();
    chromeView.webContents.send('shell:backdrop', backdrop);
    if (!centerOpen) tabs.get(activeTab)?.view.webContents.focus();
    emitToWorker({ type: 'center', open: centerOpen, profile: tabs.get(activeTab)?.profile });
  },
  overlaySize: ({ part, width, height }, sender) => {
    const o = overlays.get(part); if (!o || o.view.webContents !== sender) return;
    o.rect = { width: Math.ceil(width), height: Math.ceil(height) }; layout();
  },
  window: ({ action }) => { if (action === 'close') win.close(); else if (action === 'minimize') win.minimize(); else win.isMaximized() ? win.unmaximize() : win.maximize(); },
  // Find in page
  find: ({ text = '', forward = true, next = false }) => {
    const wc = tabs.get(activeTab)?.view.webContents; if (!wc) return;
    find = { ...find, open: true, query: String(text).slice(0, 500) };
    if (!find.query) { wc.stopFindInPage('clearSelection'); find = { ...find, active: 0, total: 0 }; broadcast(); return; }
    // Electron: findNext=true starts a new search session; false continues it.
    wc.findInPage(find.query, { forward, findNext: !next });
    broadcast();
  },
  findOpen: () => { find = { ...find, open: true }; broadcast(); revealBar('find'); },
  findClose: () => {
    if (!find.open) return;
    tabs.get(activeTab)?.view.webContents.stopFindInPage('keepSelection');
    find = { open: false, query: find.query, active: 0, total: 0 }; broadcast();
    tabs.get(activeTab)?.view.webContents.focus();
  },
  // Zoom (Chrome's steps)
  zoom: ({ delta = 0, reset = false }) => {
    const wc = tabs.get(activeTab)?.view.webContents; if (!wc) return;
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    const current = wc.getZoomFactor();
    let index = steps.findIndex(f => f >= current - 0.001); if (index < 0) index = steps.length - 1;
    const next = reset ? 1 : steps[Math.max(0, Math.min(steps.length - 1, index + Math.sign(delta)))];
    wc.setZoomFactor(next); broadcast();
  },
  devtools: () => {
    const wc = tabs.get(activeTab)?.view.webContents; if (!wc || HEADLESS) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: 'detach' });
  },
  // Downloads
  downloadOpen: ({ id }) => { const d = downloads.get(Number(id)); if (d?.state === 'completed') desktop.openPath(d.path); },
  downloadShow: ({ id }) => { const d = downloads.get(Number(id)); if (d?.path) desktop.showItemInFolder(d.path); },
  downloadCancel: ({ id }) => downloads.get(Number(id))?.item?.cancel(),
  downloadsClear: () => { for (const [id, d] of downloads) if (d.state !== 'progressing') downloads.delete(id); broadcast(); },
  // Site permissions
  permission: ({ id, allow }) => resolvePrompt(Number(id), !!allow, true),
  // Human controls are forwarded to the worker, which owns policy.
  control: args => {
    const selected = tabs.get(activeTab), scope = scopes.get(selected?.profile);
    return controls.request(SHARED_ROOT && (!args.clientId || args.clientId === 'self') && scope ? { ...args, clientId: scope.clientId, profile: selected.profile } : args);
  },
};
ipcMain.handle('shell:command', async (event, name, args) => {
  debug('command', name, event.sender.getURL());
  if (!isUi(event.sender) || !Object.hasOwn(commands, name)) throw new Error('Command rejected');
  return commands[name](args ?? {}, event.sender);
});
ipcMain.handle('shell:state', event => { if (!isUi(event.sender)) throw new Error('rejected'); return snapshot(); });

// CDP target ids let the worker map Playwright pages to shell tabs and
// recognise our own UI documents without trusting page URLs.
const targetIds = new WeakMap();
const contextIds = new WeakMap();
async function targetIdOf(wc) {
  if (targetIds.has(wc)) return targetIds.get(wc);
  const dbg = wc.debugger, attached = dbg.isAttached();
  if (!attached) dbg.attach('1.3');
  try { const { targetInfo } = await dbg.sendCommand('Target.getTargetInfo'); targetIds.set(wc, targetInfo.targetId); contextIds.set(wc, targetInfo.browserContextId); return targetInfo.targetId; }
  finally { if (!attached) dbg.detach(); }
}
const tabByTarget = async targetId => { for (const t of tabs.values()) if (await targetIdOf(t.view.webContents) === targetId) return t; return null; };

// Worker channel. The worker reaches the chrome document through CDP (the
// same pipe Playwright uses) and calls window.trexShell.worker(...). Events go
// back through a Playwright binding the worker installs on that document.
const workerApi = {
  openScope: async ({ profile, label, model = '', clientId }) => {
    if (!SHARED_ROOT || !/^BROWSER[1-9][0-9]?$/.test(profile) || typeof clientId !== 'string' || !clientId || clientId.length > 256) throw new Error('Invalid browser space');
    let scope = scopes.get(profile);
    if (!scope) {
      const storage = path.join(SHARED_ROOT, profile, 'user-data');
      fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
      const ses = session.fromPath(storage);
      ses.protocol.handle('trex', request => new URL(request.url).host === 'newtab' ? serveFrom(['newtab'])(request) : Response.error());
      ses.setUserAgent(webUserAgent(ses.getUserAgent()));
      ses.setPermissionRequestHandler(requestPermission);
      ses.setPermissionCheckHandler((_wc, permission, origin) => SILENT.has(permission) || grantedPermission(scopes.get(profile), permission, originOf(origin)) || loadDecisions()[`${profile}|${originOf(origin)}|${permission}`] === true);
      scope = { profile, session: ses }; scopes.set(profile, scope);
      ses.on('will-download', (event, item, wc) => {
        scopedDownload(scope, item, wc, path.resolve(SHARED_ROOT, '..', '..', 'artifacts'), targetIdOf, emitToWorker);
        trackDownload(event, item);
      });
    }
    scope.clientId = clientId; scope.agent = { label: String(label || profile).slice(0, 100), model: String(model).slice(0, 100), state: 'idle', tool: '', detail: '', step: '' };
    scope.permissions = new Map();
    closingScopes.delete(profile);
    const existing = [...tabs.values()].find(t => t.profile === profile);
    const id = existing?.id || createTab(undefined, { profile, activate: !activeTab });
    const wc = tabs.get(id).view.webContents, targetId = await targetIdOf(wc);
    return { targetId, browserContextId: contextIds.get(wc), profile };
  },
  closeScope: async ({ profile }) => {
    if (!scopes.has(profile)) return false;
    closingScopes.add(profile);
    for (const item of scopes.get(profile).downloads || []) item.cancel();
    for (const tab of [...tabs.values()]) if (tab.profile === profile) closeTab(tab.id);
    scopes.get(profile).session.flushStorageData(); await scopes.get(profile).session.cookies.flushStore();
    return true;
  },
  scopeStorage: ({ profile, method, params }) => { const scope=scopes.get(profile);if(!scope)throw new Error('Unknown native session');return storageCommand(scope,method,params); },
  controlResult: payload => controls.complete(payload),
  hello: () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, scopeProtocol: SHARED_ROOT ? 1 : 0 }),
  setAgent: next => {
    if (SHARED_ROOT && next.profile) {
      const scope = scopes.get(next.profile); if (!scope) return false; scope.agent = { ...scope.agent, ...next };
      // A peer's heartbeat must not reset the visible agent's cursor or dock.
      if (tabs.get(activeTab)?.profile !== next.profile) { broadcast(); return true; }
      agent = scope.agent;
    }
    else agent = { ...agent, ...next };
    // The cursor fades out shortly after the agent stops acting.
    clearTimeout(cursorTimer);
    if (agent.state !== 'working' && cursor) cursorTimer = setTimeout(() => { cursor = null; layout(); }, 1200);
    layout(); broadcast(); return true;
  },
  setCursor: ({ x, y, profile }) => {
    if (SHARED_ROOT && profile !== tabs.get(activeTab)?.profile) return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    clearTimeout(cursorTimer);
    cursor = { x, y }; animateCursor(); return true;
  },
  setSpaces: list => { spaces = Array.isArray(list) ? list : []; broadcast(); return true; },
  newTab: async ({ url, activate = true, profile } = {}) => {
    const id = createTab(url && /^https?:\/\//.test(url) ? url : undefined, { activate, profile });
    if (!id) throw new Error('No browser space selected');
    const scope=scopes.get(profile);if(scope)scope.selectedId=id;
    return { id, targetId: await targetIdOf(tabs.get(id).view.webContents) };
  },
  selectTab: ({ id }) => commands.selectTab({ id }),
  selectTarget: async ({ targetId, profile, background }) => { const t = await tabByTarget(targetId); if (!t || profile && t.profile !== profile) return false;
    const scope=scopes.get(profile);if(scope)scope.selectedId=t.id;
    if(!background||!SHARED_ROOT||tabs.get(activeTab)?.profile===profile){commands.selectTab({ id: t.id });cursor = null;}return true; },
  uiTargets: () => Promise.all([chromeView, ...[...overlays.values()].map(o => o.view)].map(v => targetIdOf(v.webContents))),
  focusWindow: async ({ profile, targetId } = {}) => {
    if (profile) { const t = targetId ? await tabByTarget(targetId) : tabs.get(scopes.get(profile)?.selectedId)||[...tabs.values()].find(t => t.profile === profile); if (!t || t.profile !== profile) return false; commands.selectTab({ id: t.id }); }
    if (centerOpen) { centerOpen = false; layout(); broadcast(); emitToWorker({ type: 'center', open: false, profile: tabs.get(activeTab)?.profile }); }
    if (HEADLESS) return true;
    if (win.isMinimized()) win.restore(); win.show(); win.focus(); tabs.get(activeTab)?.view.webContents.focus(); return true;
  },
  tabs: () => snapshot().tabs,
  // Development only: compose the window from its layers (no desktop capture
  // permission needed). Returns a PNG data URL.
  ...(process.env.TREX_SHELL_DEV === '1' ? { debugCapture: async () => {
    const { width, height } = win.getContentBounds();
    const layers = [];
    for (const v of win.contentView.children) {
      if (!v.getVisible()) continue;
      const b = v.getBounds();
      layers.push({ ...b, png: (await v.webContents.capturePage()).toDataURL() });
    }
    return { width, height, layers };
  } } : {}),
};
ipcMain.handle('shell:worker', (event, name, args) => {
  if (event.sender !== chromeView.webContents || !Object.hasOwn(workerApi, name)) throw new Error('Worker call rejected');
  return workerApi[name](args ?? {});
});
function emitToWorker(message) { if(chromeView&&!chromeView.webContents.isDestroyed())chromeView.webContents.send('shell:to-worker', message); }
const controls = humanControls(emitToWorker);

// Present as plain Chromium: the "TrexBrowser/x" and "Electron/x" tokens make
// Google (YouTube playback, sign-in) and Cloudflare treat us as an embedded app.
const webUserAgent = ua => ua.replace(/ TrexBrowser\/\S+/i, '').replace(/ Trex Browser\/\S+/i, '').replace(/ Electron\/\S+/, '');
app.userAgentFallback = webUserAgent(app.userAgentFallback);

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(webUserAgent(session.defaultSession.getUserAgent()));
  serveUi();
  session.defaultSession.setPermissionRequestHandler(requestPermission);
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => SILENT.has(permission) || loadDecisions()[`${originOf(origin)}|${permission}`] === true);
  session.defaultSession.on('will-download', trackDownload);
  win = new BaseWindow({
    width: 1360, height: 860, minWidth: 720, minHeight: 480,
    frame: false, transparent: process.platform !== 'win32', backgroundColor: '#00000000', show: !HEADLESS,
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window', visualEffectState: 'active', titleBarStyle: 'hidden' } : {}),
    ...(process.platform === 'win32' ? { backgroundMaterial: 'acrylic' } : {}),
    ...(process.platform !== 'darwin' ? { icon: path.join(here, 'icons', process.platform === 'win32' ? 'trex-browser.ico' : 'trex-browser-256.png') } : {}),
    title: SHARED_ROOT ? `Trex Browser — ${process.env.TREX_PROJECT_LABEL || 'Proyecto'}` : process.env.TREX_SPACE_LABEL ? `Trex Browser — ${process.env.TREX_SPACE_LABEL}` : 'Trex Browser',
  });
  chromeView = new WebContentsView({ webPreferences: uiPrefs });
  uiContents.add(chromeView.webContents);
  chromeView.setBackgroundColor('#00000000');
  win.contentView.addChildView(chromeView);
  chromeView.webContents.loadURL(`${UI_ORIGIN}/index.html`);
  for (const part of ['cursor', 'island', 'dock']) addOverlay(part);
  const initial = process.argv.slice(1).find(a => /^https?:\/\//.test(a));
  if (!SHARED_ROOT && (initial || !restoreSession())) createTab(initial);
  // Start with the keyboard on the page, not on our UI.
  tabs.get(activeTab)?.view.webContents.once('did-finish-load', () => { if (!tabs.get(activeTab)?.url.startsWith('trex://newtab')) tabs.get(activeTab)?.view.webContents.focus(); });
  win.on('resize', layout);
  win.on('maximize', broadcast); win.on('unmaximize', broadcast);
  win.on('close', () => { saveSession(true); closing = true; });
  win.on('closed', () => { closing = true; controls.close(); });
  win.on('closed', () => app.quit());
  layout();
});

// Browser shortcuts work no matter which view (page or UI) has focus.
function shortcut(input) {
  if (input.type !== 'keyDown') return false;
  const mod = process.platform === 'darwin' ? input.meta : input.control;
  const key = input.key.toLowerCase();
  if (mod && input.shift && key === 'a') { commands.toggleCenter(); return true; }
  if (mod && key === 't') { commands.newTab(); return true; }
  if (mod && key === 'w') { if (activeTab) closeTab(activeTab); return true; }
  if (mod && key === 'l') { revealBar(true); return true; }
  if (mod && key === 'f') { commands.findOpen(); return true; }
  if (key === 'escape' && find.open) { commands.findClose(); return true; }
  if (mod && (key === '=' || key === '+')) { commands.zoom({ delta: 1 }); return true; }
  if (mod && key === '-') { commands.zoom({ delta: -1 }); return true; }
  if (mod && key === '0') { commands.zoom({ reset: true }); return true; }
  if (key === 'f12' || mod && input.shift && key === 'i') { commands.devtools(); return true; }
  if (mod && key === 'r' || key === 'f5') { commands.reload(); return true; }
  if (input.alt && key === 'arrowleft') { commands.back(); return true; }
  if (input.alt && key === 'arrowright') { commands.forward(); return true; }
  if (mod && /^[1-9]$/.test(key)) { const t = [...tabs.keys()][Number(key) - 1]; if (t) commands.selectTab({ id: t }); return true; }
  return false;
}

// Thin, rounded Trex scrollbars for pages. A user-origin sheet: a site that
// styles its own scrollbars (or uses scrollbar-color) keeps its design.
const SCROLLBAR_CSS = `
::-webkit-scrollbar{width:12px;height:12px;background:transparent}
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
::-webkit-scrollbar-button{display:none;width:0;height:0}
::-webkit-scrollbar-thumb{background:rgba(140,140,150,.5);background-clip:padding-box;border:3px solid transparent;border-radius:12px;min-height:36px;min-width:36px}
::-webkit-scrollbar-thumb:hover{background-color:rgba(150,150,160,.66);border-width:2px}
::-webkit-scrollbar-thumb:active{background-color:rgba(232,131,74,.85);border-width:2px}`;
app.on('web-contents-created', (_e, wc) => {
  wc.on('dom-ready', () => { if (!isUi(wc) && !wc.getURL().startsWith('devtools:')) wc.insertCSS(SCROLLBAR_CSS, { cssOrigin: 'user' }).catch(() => {}); });
  if (process.env.TREX_SHELL_DEBUG === '1') wc.on('input-event', (_ev, input) => { if (/mouseDown|keyDown|mouseEnter/.test(input.type)) debug('input', input.type, wc.getURL().slice(0, 50), input.x ?? '', input.y ?? '', input.key ?? ''); });
  wc.on('before-input-event', (event, input) => { if (shortcut(input)) event.preventDefault(); });
  wc.on('will-attach-webview', e => e.preventDefault());
  // Our UI never navigates away from trex://ui.
  wc.on('will-navigate', (e, url) => { if (isUi(wc) && !url.startsWith(UI_ORIGIN + '/')) e.preventDefault(); });
});
app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => app.quit());
