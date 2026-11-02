import { icons, esc, favicon, fixFavicons, hostOf, ACTIVITY } from './icons.js';
import { patchMarkup } from './patch-dom.js';

const part = new URLSearchParams(location.search).get('part');
const root = document.getElementById('root');
const shell = window.trexShell;
const cmd = (name, args) => shell.command(name, args);
let state = null;

function agentChip(a) {
  const cls = a.state === 'working' ? '' : a.state === 'paused' ? 'paused' : 'idle';
  const label = a.state === 'working' ? (ACTIVITY[a.tool] || 'Trabajando') : a.state === 'paused' ? 'En pausa' : 'Disponible';
  return `<div class="agentchip ${cls}" title="${esc(a.model ? `${a.label} · ${a.model}` : a.label)}"><span class="av">${esc((a.label[0] || 'A').toUpperCase())}</span><span class="name">${esc(a.label)}</span>${a.model ? `<em class="model">${esc(a.model)}</em>` : ''}${a.state === 'working' ? '<span class="pulse"></span>' : ''}<small>${esc(label)}</small></div>`;
}
const bytes = n => !n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

// ---- Top bar: hidden in full view, revealed from the top edge ------------
// Collapsed, this view is a transparent 12px strip along the top edge.
// Moving the pointer there reveals tabs + toolbar; leaving hides them again.
// It stays visible while typing, on the new tab page, while searching in the
// page, while a site asks for a permission and while the downloads panel is open.
let revealed = false, leaving = false, hideTimer = null, lastPointer = null, panel = null, entering = false;
const isNewTab = s => (s?.tabs.find(t => t.id === s.activeTab)?.url || '').startsWith('trex://newtab');
// A blurred document keeps its activeElement, so also require real focus.
const typing = () => document.hasFocus() && document.activeElement?.tagName === 'INPUT' && root.contains(document.activeElement);
const pinned = () => typing() || isNewTab(state) || !!state?.find.open || !!state?.prompts.length || panel === 'downloads';

// Focus requests survive re-renders: they are applied after the next render.
let focusPending = null;
function applyFocus() {
  if (!focusPending) return;
  const f = root.querySelector(focusPending === 'find' ? 'input.find' : '.url input'); if (!f) return;
  focusPending = null; f.focus(); f.select();
}
function reveal(focus = false, nextPanel = null) {
  clearTimeout(hideTimer);
  if (focus) focusPending = focus === 'find' ? 'find' : 'url';
  if (nextPanel) panel = nextPanel;
  if (!revealed || leaving || nextPanel) { if (!revealed) entering = true; revealed = true; leaving = false; render(state); }
  else applyFocus();
}
function scheduleHide(delay = 650) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!revealed || pinned()) return;
    leaving = true; root.querySelector('.topbar')?.classList.add('out');
    hideTimer = setTimeout(() => { leaving = false; revealed = false; panel = null; render(state); }, 160);
  }, delay);
}
const barRect = () => root.querySelector('.topbar')?.getBoundingClientRect();
const overBar = (x, y) => { const r = barRect(); return !!r && x >= r.left - 8 && x <= r.right + 8 && y <= r.bottom + 6; };
// Strictly inside the bar (e.g. the pointer went onto the window drag area).
const insideBar = (x, y) => { const r = barRect(); return !!r && x > r.left && x < r.right && y > r.top && y < r.bottom - 4; };

function tabPill(t, active) {
  return `<div class="tabpill ${active ? 'on' : ''}" data-tab="${esc(t.id)}" title="${esc(t.owner ? `${t.owner} · ${t.title || t.url}` : t.title || t.url)}">
    ${t.owner ? `<span class="tab-owner" title="${esc(t.owner)}">${esc(t.owner.slice(0,1).toUpperCase())}</span>` : ''}
    ${t.loading ? `<span class="fav loading">${icons.reload}</span>` : favicon(t)}<span class="t">${esc(t.title || 'Nueva pestaña')}</span>
    <button class="x" data-close="${esc(t.id)}" title="Cerrar pestaña (Ctrl+W)">${icons.close}</button></div>`;
}

function windowControls(mac) {
  if (mac) return `<div class="wc mac"><button data-w="close" style="--c:#ff5f57" title="Cerrar"></button><button data-w="minimize" style="--c:#febc2e" title="Minimizar"></button><button data-w="maximize" style="--c:#28c840" title="Maximizar"></button></div>`;
  return `<div class="wc">
    <button data-w="minimize" title="Minimizar"><svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg></button>
    <button data-w="maximize" title="Maximizar"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>
    <button data-w="close" class="danger" title="Cerrar"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>`;
}

function downloadsButton(s) {
  if (!s.downloads.length) return '';
  const busy = s.downloads.some(d => d.state === 'progressing');
  return `<button class="ib dl ${panel === 'downloads' ? 'on' : ''} ${busy ? 'busy' : ''}" data-c="downloads" title="Descargas">${icons.download}</button>`;
}

const findCount = f => f.query ? (f.total ? `${f.active}/${f.total}` : 'Sin resultados') : '';
function findRow(f) {
  if (!f.open) return '';
  return `<div class="row findrow" data-key="find">${icons.search}<input class="find" spellcheck="false" placeholder="Buscar en la página" value="${esc(f.query)}">
    <span class="count ${f.query && !f.total ? 'none' : ''}">${esc(findCount(f))}</span>
    <button class="ib" data-c="findprev" title="Anterior (Mayús+Intro)">${icons.up}</button><button class="ib" data-c="findnext" title="Siguiente (Intro)">${icons.down}</button>
    <button class="ib" data-c="findclose" title="Cerrar (Esc)">${icons.close}</button></div>`;
}

function promptRows(s) {
  return s.prompts.map(p => `<div class="row notice" data-key="permission-${p.id}">${icons.shield}<span class="msg"><b>${esc(hostOf(p.origin) || p.origin)}</b> quiere ${esc(p.label)}</span>
    <button class="btn" data-perm="${p.id}" data-allow="0">Bloquear</button><button class="btn primary" data-perm="${p.id}" data-allow="1">Permitir</button></div>`).join('');
}

function downloadsPanel(s) {
  if (panel !== 'downloads' || !s.downloads.length) return '';
  const item = d => {
    const pct = d.total ? Math.min(100, Math.round(d.received / d.total * 100)) : null;
    const status = d.state === 'progressing' ? `${bytes(d.received) || '0 B'}${d.total ? ` de ${bytes(d.total)}` : ''}`
      : d.state === 'completed' ? `Completado · ${bytes(d.received)}` : d.state === 'cancelled' ? 'Cancelado' : 'Interrumpido';
    const acts = d.state === 'progressing' ? `<button class="btn" data-dl="cancel" data-id="${d.id}">Cancelar</button>`
      : d.state === 'completed' ? `<button class="btn" data-dl="open" data-id="${d.id}">Abrir</button><button class="ib" data-dl="show" data-id="${d.id}" title="Mostrar en la carpeta">${icons.folder}</button>` : '';
    return `<div class="dlitem ${esc(d.state)}" data-key="download-${d.id}"><span class="dlicon">${icons.download}</span><div class="dlmeta"><strong title="${esc(d.name)}">${esc(d.name)}</strong>
      ${d.state === 'progressing' ? `<div class="bar"><i class="${pct == null ? 'indet' : ''}" style="width:${pct ?? 30}%"></i></div>` : ''}<small>${esc(status)}</small></div>${acts}</div>`;
  };
  return `<div class="row panelhead" data-key="downloads-heading"><b>Descargas</b><button class="link" data-c="dlclear">Limpiar</button></div><div class="dllist">${s.downloads.map(item).join('')}</div>`;
}

let wasPinned = false, lastActiveTab = null;
function renderIsland(s) {
  const pin = pinned();
  if (pin && !revealed) { revealed = true; entering = true; }
  // Leaving the new tab page (or finishing an edit) releases the bar.
  if (wasPinned && !pin && !(lastPointer && overBar(lastPointer.x, lastPointer.y))) scheduleHide(900);
  wasPinned = pin;
  document.body.classList.toggle('revealed', revealed);
  if (!revealed) { lastActiveTab = null; patchMarkup(root, '<div class="hot" aria-hidden="true"></div>'); return; }
  const tab = s.tabs.find(t => t.id === s.activeTab) ?? { url: '' };
  const internal = tab.url.startsWith('trex:');  // new tab page
  const secure = tab.url.startsWith('https:') || /^http:\/\/(localhost|127\.0\.0\.1)/.test(tab.url);
  const mac = s.platform === 'darwin';
  const enterClass = entering || root.querySelector('.topbar.enter') ? 'enter' : ''; entering = false;
  patchMarkup(root, `<div class="topbar glass ${enterClass} ${leaving ? 'out' : ''}">
    <div class="tabsrow">
      ${mac ? windowControls(true) : ''}
      <div class="tabs">${s.tabs.map(t => tabPill(t, t.id === s.activeTab)).join('')}</div>
      <button class="ib newtab" data-c="newtab" title="Nueva pestaña (Ctrl+T)">${icons.plus}</button>
      <div class="dragspace"></div>
      ${mac ? '' : windowControls(false)}
    </div>
    <div class="toolrow">
      <button class="ib" data-c="back" ${s.canGoBack ? '' : 'disabled'} title="Atrás (Alt+←)">${icons.back}</button>
      <button class="ib" data-c="forward" ${s.canGoForward ? '' : 'disabled'} title="Adelante (Alt+→)">${icons.forward}</button>
      <button class="ib" data-c="reload" title="Recargar (Ctrl+R)">${tab.loading ? `<span class="spin">${icons.reload}</span>` : icons.reload}</button>
      <label class="url">${secure ? icons.lock : icons.globe.replace('<svg', '<svg class="insecure"')}<input spellcheck="false" placeholder="Busca o escribe una dirección" value="${esc(internal ? '' : tab.url)}">
        ${s.zoom !== 100 ? `<button class="zoom" data-c="zoomreset" title="Restablecer zoom (Ctrl+0)">${s.zoom} %</button>` : ''}</label>
      ${downloadsButton(s)}
      ${agentChip(s.agent)}
      <div class="sep"></div>
      <button class="ib ${s.centerOpen ? 'on' : ''}" data-c="center" title="Centro de agentes (Ctrl+Shift+A)">${icons.grid}</button>
    </div>
    ${findRow(s.find)}${promptRows(s)}${downloadsPanel(s)}
  </div>`);
  if (lastActiveTab !== s.activeTab) root.querySelector('.tabpill.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  lastActiveTab = s.activeTab;
  applyFocus();
}

function renderDock(s) {
  const a = s.agent;
  const paused = a.state === 'paused';
  const doing = paused ? 'está en pausa' : `${(ACTIVITY[a.tool] || 'está trabajando').toLowerCase()}`;
  patchMarkup(root, `<div class="dock glass ${paused ? 'paused' : ''}">
    <span class="pulse"></span>
    <span class="msg"><b>${esc(a.label)}</b> ${esc(doing)}${a.detail ? ` <b>“${esc(a.detail)}”</b>` : ''}</span>
    ${a.tool ? `<code>${esc(a.tool)}${a.step ? ' · ' + esc(a.step) : ''}</code>` : ''}
    ${paused ? `<button class="btn primary" data-k="resume">${icons.play}Reanudar</button>`
             : `<button class="btn" data-k="pause">${icons.pause}Pausar</button><button class="btn primary" data-k="takeover">${icons.takeover}Tomar control</button>`}
  </div>`);
}

// Report our size to the main process after every render. A view that is
// still 0x0 does not paint, so ResizeObserver alone would never fire.
let lastSize = '';
function reportSize() {
  const r = root.getBoundingClientRect(), size = `${Math.ceil(r.width)}x${Math.ceil(r.height)}`;
  if (size === lastSize) return; lastSize = size;
  cmd('overlaySize', { part, width: r.width, height: r.height });
}
function renderCursor(s) {
  patchMarkup(root, `<div class="agentcursor"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3l7 18 2.5-7.5L21 11z"/></svg><span>${esc(s.agent.label)}</span></div>`);
}
let lastRender = '';
function render(s, force = false) {
  state = s; if (!s) return;
  const visible = part === 'island' ? { tabs: s.tabs, activeTab: s.activeTab, canGoBack: s.canGoBack, canGoForward: s.canGoForward,
    zoom: s.zoom, find: s.find, prompts: s.prompts, downloads: s.downloads, platform: s.platform, centerOpen: s.centerOpen,
    agent: { label: s.agent.label, model: s.agent.model, state: s.agent.state } } : part === 'cursor' ? s.agent.label : s.agent;
  const signature = JSON.stringify([visible, revealed, leaving, panel, focusPending, entering]);
  if (!force && signature === lastRender) return;
  lastRender = signature;
  if (part === 'island') renderIsland(s); else if (part === 'cursor') renderCursor(s); else renderDock(s);
  fixFavicons(root);
  reportSize();
}

root.addEventListener('animationend', e => { if (e.animationName === 'drop') e.target.classList.remove('enter'); });
root.addEventListener('focusin', e => { if (e.target.matches('.url input')) e.target.select(); });
root.addEventListener('input', e => { if (e.target.matches('input.find')) cmd('find', { text: e.target.value }); });
root.addEventListener('keydown', e => {
  const input = e.target;
  if (input.matches('.url input')) {
    if (e.key === 'Enter' && input.value.trim()) { cmd('navigate', { url: input.value }); input.blur(); }
    if (e.key === 'Escape') { input.blur(); render(state, true); }
  } else if (input.matches('input.find') && e.key === 'Enter') {
    e.preventDefault(); cmd('find', { text: input.value, forward: !e.shiftKey, next: true });
  }
});

root.addEventListener('click', e => {
  const t = e.target.closest('button,[data-tab],[data-c]'); if (!t) return;
  if (t.dataset.close) { e.stopPropagation(); return cmd('closeTab', { id: t.dataset.close }); }
  if (t.dataset.w) return cmd('window', { action: t.dataset.w });
  if (t.dataset.k) return cmd('control', { action: t.dataset.k });
  if (t.dataset.perm) return cmd('permission', { id: t.dataset.perm, allow: t.dataset.allow === '1' });
  if (t.dataset.dl) return cmd({ open: 'downloadOpen', show: 'downloadShow', cancel: 'downloadCancel' }[t.dataset.dl], { id: t.dataset.id });
  if (t.dataset.tab) return cmd('selectTab', { id: t.dataset.tab });
  const findText = root.querySelector('input.find')?.value ?? '';
  switch (t.dataset.c) {
    case 'back': return cmd('back'); case 'forward': return cmd('forward'); case 'reload': return cmd('reload');
    case 'center': return cmd('toggleCenter'); case 'newtab': return cmd('newTab');
    case 'zoomreset': e.preventDefault(); return cmd('zoom', { reset: true });
    case 'downloads': panel = panel === 'downloads' ? null : 'downloads'; return render(state);
    case 'dlclear': return cmd('downloadsClear');
    case 'findnext': return cmd('find', { text: findText, forward: true, next: true });
    case 'findprev': return cmd('find', { text: findText, forward: false, next: true });
    case 'findclose': return cmd('findClose');
  }
});
root.addEventListener('auxclick', e => { // middle click closes a tab
  const t = e.button === 1 && e.target.closest('[data-tab]'); if (t) { e.preventDefault(); cmd('closeTab', { id: t.dataset.tab }); }
});
root.addEventListener('dblclick', e => { if (e.target.closest('.dragspace')) cmd('window', { action: 'maximize' }); });

document.body.dataset.part = part;
if (part === 'island') {
  document.addEventListener('pointermove', e => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!revealed || leaving) return reveal();
    if (overBar(e.clientX, e.clientY)) clearTimeout(hideTimer); else scheduleHide(250);
  });
  // Leaving the view into the page hides the bar; leaving into a drag area of the bar does not.
  document.documentElement.addEventListener('mouseleave', () => { if (!lastPointer || !insideBar(lastPointer.x, lastPointer.y)) scheduleHide(300); });
  // Leaving an input may release the bar.
  root.addEventListener('focusout', () => setTimeout(() => { if (!pinned() && !(lastPointer && overBar(lastPointer.x, lastPointer.y))) scheduleHide(); }, 0));
  shell.onReveal(({ focus, panel: p } = {}) => reveal(focus, p));
  shell.onPageFocus(() => {
    if (panel === 'downloads') { panel = null; render(state); }
    if (!pinned() && !(lastPointer && overBar(lastPointer.x, lastPointer.y))) scheduleHide(300);
  });
  // Focus moving to the page (another view) does not fire focusout here.
  window.addEventListener('blur', () => { if (!pinned() && !(lastPointer && overBar(lastPointer.x, lastPointer.y))) scheduleHide(); });
}
new ResizeObserver(reportSize).observe(root);
shell.onState(render);
shell.state().then(render);
