import { icons, esc, initial, favicon, fixFavicons, STATE_LABEL } from './icons.js';

const shell = window.trexShell;
const $ = id => document.getElementById(id);
let state = null, filter = 'all', query = '';
const feed = [];          // [{at, label, tool, detail, color}]
const cards = new Map(), controls = new Map(), activityRows = new Map();
let lastAgentKey = '';

const COLORS = ['#e8834a', '#7d6bff', '#38b6c9', '#e7c35a', '#ef7d7d', '#5fd08a', '#d36bd0'];
const colorFor = key => COLORS[[...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 3 ? 'ahora' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`; };

/** Saved/reserved profiles are not open browser instances. */
function spacesFrom(s) {
  if (s.automation === false && !s.spaces.length) return [];
  if (s.spaces.length) return s.spaces.filter(sp => sp.state !== 'closed');
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
  return `<article class="card glass ${live ? 'working' : ''}" data-client="${esc(sp.clientId)}" data-profile="${esc(sp.profile || '')}" data-self="${!!sp.self}">
    <div class="thumb" style="${thumb ? `background-image:url('${esc(thumb)}')` : ''}">${thumb ? '' : st === 'closed' ? 'Sin abrir' : 'Sin vista previa'}
      ${live ? '<span class="badge"><i></i>EN VIVO</span>' : ''}${sp.tabCount ? `<span class="tabs-mini">${sp.tabCount} ${sp.tabCount === 1 ? 'pestaña' : 'pestañas'}</span>` : ''}</div>
    <div class="meta">
      <div class="row"><span class="av" style="--c:${colorFor(sp.clientId)}">${initial(sp.label)}</span><span class="name" title="${esc(sp.project ? `${sp.label} · ${sp.project}` : sp.label)}">${esc(sp.project ? `${sp.label} · ${sp.project}` : sp.label)}</span><span class="model" title="${esc(sp.model || sp.profile || '')}">${esc(sp.model || sp.profile || '')}</span><span class="pill ${esc(st)}"><em></em>${esc(STATE_LABEL[st] || st)}</span></div>
      <div class="tool" title="${esc(sp.tool || sp.detail || '')}">${tool}</div>
      <div class="cur">${favicon({ url: sp.url || '', title: sp.title || sp.profile || '' })}<div><strong title="${esc(sp.title || sp.profile || '')}">${esc(sp.title || sp.profile || 'Sin página')}</strong><small title="${esc(sp.url || '')}">${esc(sp.url || 'perfil persistente')}</small></div></div>
    </div>
    <div class="acts">${acts}</div>
  </article>`;
}
const cardKey = sp => JSON.stringify([sp.profile || '', sp.clientId]);
function renderCards(shown) {
  const grid = $('grid'), used = new Set();
  if (shown.length) grid.querySelector(':scope > .empty')?.remove();
  shown.forEach((sp, index) => {
    const key = cardKey(sp); used.add(key);
    const template = document.createElement('template'); template.innerHTML = card(sp, backdropUrl);
    const next = template.content.firstElementChild;
    let entry = cards.get(key);
    if (!entry) {
      entry = { node: next, parts: {} }; next.dataset.key = key;
      const feedback = document.createElement('p'); feedback.className = 'feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); next.append(feedback);
      cards.set(key, entry);
    }
    entry.node.className = next.className;
    entry.node.dataset.self = next.dataset.self;
    for (const selector of ['.thumb', '.meta', '.acts']) {
      const markup = next.querySelector(selector).innerHTML;
      const style = next.querySelector(selector).getAttribute('style') || '';
      const signature = markup + '\0' + style;
      if (entry.parts[selector] !== signature) {
        const target = entry.node.querySelector(selector);
        target.innerHTML = markup; target.setAttribute('style', style); entry.parts[selector] = signature;
      }
    }
    const control = controls.get(key), feedback = entry.node.querySelector('.feedback');
    entry.node.querySelectorAll('.acts button').forEach(button => { button.disabled = !!control?.pending; });
    feedback.textContent = control?.message || ''; feedback.classList.toggle('error', !!control?.error);
    feedback.setAttribute('role', control?.error ? 'alert' : 'status');
    if (grid.children[index] !== entry.node) grid.insertBefore(entry.node, grid.children[index] ?? null);
  });
  for (const [key, entry] of cards) if (!used.has(key)) { entry.node.remove(); cards.delete(key); }
  if (!shown.length && !grid.children.length) grid.innerHTML = '<p class="empty">No hay agentes con este filtro.</p>';
}

let backdropUrl = null;
function renderFeed() {
  const list = $('feed'), previousTop = list.scrollTop, followNewest = previousTop <= 1;
  const top = list.getBoundingClientRect().top;
  const anchor = followNewest ? null : [...list.children].find(row => row.dataset.event && row.getBoundingClientRect().bottom > top);
  const anchorKey = anchor?.dataset.event, offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const used = new Set();
  if (feed.length) list.querySelector(':scope > .empty')?.remove();
  feed.forEach((event, index) => {
    const key = event.id ?? JSON.stringify([event.at, event.label, event.tool, event.detail]); used.add(key);
    let row = activityRows.get(key);
    if (!row) { const node = document.createElement('div'); node.className = 'ev'; node.dataset.event = key; row = { node }; activityRows.set(key, row); }
    const markup = `<span class="av" style="--c:${event.color}">${initial(event.label)}</span><p><b>${esc(event.label)}</b> <code>${esc(event.tool)}</code>${event.detail ? ` “${esc(event.detail)}”` : ''}</p><time>${ago(event.at)}</time>`;
    if (row.markup !== markup) { row.node.innerHTML = markup; row.markup = markup; }
    if (list.children[index] !== row.node) list.insertBefore(row.node, list.children[index] ?? null);
  });
  for (const [key, row] of activityRows) if (!used.has(key)) { row.node.remove(); activityRows.delete(key); }
  if (!feed.length && !list.children.length) list.innerHTML = '<p class="empty">La actividad de los agentes aparecerá aquí.</p>';
  // Keep the same visible event even when newer entries arrive above it.
  const retained = anchorKey && activityRows.get(anchorKey)?.node;
  if (retained) list.scrollTop += retained.getBoundingClientRect().top - list.getBoundingClientRect().top - offset;
  else list.scrollTop = followNewest ? 0 : previousTop;
  $('activity-count').textContent = feed.length ? `${feed.length} · en vivo` : 'en vivo';
}
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
  renderCards(shown);
  renderFeed();
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
$('grid').addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const card = b.closest('[data-client]'), { client: clientId, profile, key } = card.dataset, action = b.dataset.a;
  if (controls.get(key)?.pending) return;
  controls.set(key, { pending: true, message: 'Aplicando…' }); renderCenter();
  try {
    const result = action === 'focus' && !state?.automation && (card.dataset.self === 'true' || clientId === 'self')
      ? await shell.command('toggleCenter', { open: false })
      : await shell.command('control', { action, clientId, ...(profile ? { profile } : {}) });
    if (action === 'screenshot') {
      const image = result?.image;
      if (!image || !['image/png', 'image/jpeg'].includes(image.mimeType) || typeof image.data !== 'string') throw new Error('No se pudo obtener la captura de este espacio.');
      $('capture').querySelector('img').src = `data:${image.mimeType};base64,${image.data}`; $('capture').showModal();
    }
    controls.set(key, { message: action === 'pause' ? 'Automatización pausada' : action === 'resume' ? 'Automatización reanudada' : action === 'takeover' ? 'Control manual: el agente permanece pausado' : '' });
  } catch (error) { controls.set(key, { error: true, message: error?.message || 'No se pudo aplicar la acción. Vuelve a intentarlo.' }); }
  renderCenter();
});
$('capture').querySelector('[data-capture-close]').addEventListener('click', () => { $('capture').close(); $('capture').querySelector('img').removeAttribute('src'); });
addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('capture').open) { e.preventDefault(); $('capture').close(); $('capture').querySelector('img').removeAttribute('src'); }
  else if (e.key === 'Escape' && state?.centerOpen) shell.command('toggleCenter', { open: false });
});
shell.onBackdrop(data => { backdropUrl = data; $('backdrop').style.backgroundImage = data ? `url('${data}')` : ''; renderCenter(); });
shell.onState(render);
shell.state().then(render);
setInterval(() => state?.centerOpen && renderCenter(), 5000);
