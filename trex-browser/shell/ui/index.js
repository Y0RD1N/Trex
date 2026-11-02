import { icons, esc, initial, favicon, fixFavicons, STATE_LABEL } from './icons.js';

const shell = window.trexShell;
const $ = id => document.getElementById(id);
let state = null, filter = 'all', query = '';
const feed = [];          // [{at, label, tool, detail, color}]
let lastAgentKey = '';

const COLORS = ['#e8834a', '#7d6bff', '#38b6c9', '#e7c35a', '#ef7d7d', '#5fd08a', '#d36bd0'];
const colorFor = key => COLORS[[...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 3 ? 'ahora' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`; };

/** The worker pushes every space of the project; without it we show ourselves. */
function spacesFrom(s) {
  if (s.spaces.length) return s.spaces;
  const tab = s.tabs.find(t => t.id === s.activeTab) ?? {};
  return [{ clientId: 'self', label: s.agent.label, model: s.agent.model, state: s.agent.state, tool: s.agent.tool, detail: s.agent.detail,
    tabCount: s.tabs.length, title: tab.title, url: tab.url, self: true }];
}

function card(sp, backdrop) {
  const st = sp.state || 'idle';
  const thumb = sp.thumbnail || (sp.self ? backdrop : null);
  const live = st === 'working';
  const tool = st === 'working' ? `<b>${esc(sp.tool || 'trabajando')}</b>${sp.detail ? ` → “${esc(sp.detail)}”` : ''}`
    : st === 'paused' ? (sp.tool ? `Pausado antes de <b>${esc(sp.tool)}</b>` : 'Pausado por una persona')
    : st === 'review' ? `Acción incierta${sp.tool ? `: <b>${esc(sp.tool)}</b>` : ''}`
    : st === 'closed' ? 'Esperando la primera navegación' : 'Sin tarea en curso';
  const acts = st === 'closed' ? `<span class="hint">Se abrirá cuando el agente navegue</span>`
    : st === 'paused' ? `<button class="btn" data-a="focus">${icons.eye}Ver</button><button class="btn primary" data-a="resume">${icons.play}Reanudar</button><button class="btn" data-a="takeover">Tomar control</button>`
    : st === 'review' ? `<button class="btn" data-a="focus">${icons.eye}Ver</button><button class="btn" data-a="screenshot">${icons.camera}Captura</button><button class="btn" data-a="takeover">Tomar control</button>`
    : `<button class="btn" data-a="focus">${icons.eye}Ver</button><button class="btn" data-a="pause">${icons.pause}Pausar</button><button class="btn" data-a="takeover">Tomar control</button>`;
  return `<article class="card glass ${live ? 'working' : ''}" data-client="${esc(sp.clientId)}">
    <div class="thumb" style="${thumb ? `background-image:url('${esc(thumb)}')` : ''}">${thumb ? '' : st === 'closed' ? 'Sin abrir' : 'Sin vista previa'}
      ${live ? '<span class="badge"><i></i>EN VIVO</span>' : ''}${sp.tabCount ? `<span class="tabs-mini">${sp.tabCount} ${sp.tabCount === 1 ? 'pestaña' : 'pestañas'}</span>` : ''}</div>
    <div class="meta">
      <div class="row"><span class="av" style="--c:${colorFor(sp.clientId)}">${initial(sp.label)}</span><span class="name">${esc(sp.label)}</span><span class="model">${esc(sp.model || sp.profile || '')}</span><span class="pill ${esc(st)}"><em></em>${esc(STATE_LABEL[st] || st)}</span></div>
      <div class="tool">${tool}</div>
      <div class="cur">${favicon({ url: sp.url || '', title: sp.title || sp.profile || '' })}<div><strong>${esc(sp.title || sp.profile || 'Sin página')}</strong><small>${esc(sp.url || 'perfil persistente')}</small></div></div>
    </div>
    <div class="acts">${acts}</div>
  </article>`;
}

let backdropUrl = null;
function renderCenter() {
  const s = state; if (!s) return;
  document.body.classList.toggle('center-open', s.centerOpen);
  if (!s.centerOpen) return;
  const all = spacesFrom(s);
  const shown = all.filter(sp => (filter === 'all' || sp.state === filter)
    && (!query || `${sp.label} ${sp.url} ${sp.title}`.toLowerCase().includes(query)));
  $('proj').textContent = s.project || '';
  $('proj').hidden = !s.project;
  const working = all.filter(sp => sp.state === 'working').length, tabs = all.reduce((n, sp) => n + (sp.tabCount || 0), 0);
  const count = (n, one, many) => `<span><b>${n}</b> ${n === 1 ? one : many}</span>`;
  $('stats').innerHTML = count(all.length, 'espacio', 'espacios') + count(working, 'trabajando', 'trabajando') + count(tabs, 'pestaña', 'pestañas');
  $('grid').innerHTML = shown.length ? shown.map(sp => card(sp, backdropUrl)).join('') : '<p class="empty">No hay agentes con este filtro.</p>';
  $('feed').innerHTML = feed.length ? feed.slice(0, 40).map(e => `<div class="ev"><span class="av" style="--c:${e.color}">${initial(e.label)}</span><p><b>${esc(e.label)}</b> <code>${esc(e.tool)}</code>${e.detail ? ` “${esc(e.detail)}”` : ''}</p><time>${ago(e.at)}</time></div>`).join('')
    : '<p class="empty">La actividad de los agentes aparecerá aquí.</p>';
  fixFavicons($('grid'));
}

function render(s) {
  state = s;
  const a = s.agent;
  document.body.classList.toggle('agent', a.state === 'working');
  document.body.classList.toggle('paused', a.state === 'paused' || a.state === 'review');
  document.body.classList.toggle('maximized', s.maximized);
  document.body.classList.toggle('native-glass', s.platform === 'darwin' || s.platform === 'win32');
  const key = `${a.tool}|${a.detail}|${a.step}`;
  // Without a worker inventory the shell logs its own agent; once the worker
  // sends spaces (with their own event ids) those local entries are dropped.
  if (s.spaces.length) { for (let i = feed.length - 1; i >= 0; i--) if (feed[i].local) feed.splice(i, 1); }
  else if (a.state === 'working' && a.tool && key !== lastAgentKey) feed.unshift({ local: true, at: Date.now(), label: a.label, tool: a.tool, detail: a.detail, color: colorFor('self') });
  lastAgentKey = key;
  for (const sp of s.spaces) for (const e of sp.events ?? []) if (!feed.some(f => f.id === e.id)) feed.push({ ...e, label: sp.label, color: colorFor(sp.clientId) });
  feed.sort((x, y) => y.at - x.at); feed.length = Math.min(feed.length, 80);
  renderCenter();
}

$('filter').addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  filter = b.dataset.f; for (const x of $('filter').children) x.classList.toggle('on', x === b); renderCenter();
});
$('q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderCenter(); });
document.querySelector('[data-close]').addEventListener('click', () => shell.command('toggleCenter', { open: false }));
$('grid').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const clientId = b.closest('[data-client]').dataset.client;
  if (b.dataset.a === 'focus' && clientId === 'self') return shell.command('toggleCenter', { open: false });
  shell.command('control', { action: b.dataset.a, clientId });
});
addEventListener('keydown', e => {
  if (e.key === 'Escape' && state?.centerOpen) shell.command('toggleCenter', { open: false });
});
shell.onBackdrop(data => { backdropUrl = data; $('backdrop').style.backgroundImage = data ? `url('${data}')` : ''; renderCenter(); });
shell.onState(render);
shell.state().then(render);
setInterval(() => state?.centerOpen && renderCenter(), 5000);
