const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const icons = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  forward: svg('<path d="M9 18l6-6-6-6"/>'),
  reload: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  stop: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  globe: svg('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16"/>'),
  grid: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  pause: svg('<path d="M9 5v14M15 5v14"/>'),
  play: svg('<path d="M7 5l12 7-12 7z"/>'),
  takeover: svg('<path d="M12 3v10M7 8l5-5 5 5M5 21h14"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  folder: svg('<path d="M3 7h6l2 2h10v10H3z"/>'),
  shield: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
  eye: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
};
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const initial = s => esc((String(s || '?').trim()[0] || '?').toUpperCase());
export const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };
export function favicon(tab) {
  const host = hostOf(tab.url);
  if (tab.favicon && /^(https?|data):/.test(tab.favicon)) return `<span class="fav" data-letter="${initial(host.replace(/^www\./, '') || tab.title)}"><img src="${esc(tab.favicon)}" alt=""></span>`;
  return `<span class="fav" style="--f:${host ? '#3a3a3e' : 'rgba(255,255,255,.08)'}">${initial(host.replace(/^www\./, '') || tab.title)}</span>`;
}
export const ACTIVITY = {
  browser_navigate: 'Abriendo página', browser_navigate_back: 'Volviendo', browser_reload: 'Recargando', browser_snapshot: 'Inspeccionando',
  browser_click: 'Haciendo clic', browser_type: 'Escribiendo', browser_fill_form: 'Rellenando formulario', browser_press_key: 'Pulsando teclas',
  browser_hover: 'Señalando', browser_select_option: 'Eligiendo opción', browser_take_screenshot: 'Capturando', browser_evaluate: 'Ejecutando script',
  browser_wait_for: 'Esperando', browser_tabs: 'Gestionando pestañas', browser_file_upload: 'Subiendo archivo', browser_save_download: 'Guardando descarga', browser_drag: 'Arrastrando',
  browser_batch: 'Ejecutando pasos', browser_network_requests: 'Revisando red', browser_console_messages: 'Leyendo consola',
};
export const STATE_LABEL = { working: 'Trabajando', idle: 'Disponible', paused: 'Pausado', review: 'Revisar', closed: 'Sin abrir' };

/** Broken favicons fall back to the site's initial. */
export function fixFavicons(root) {
  for (const img of root.querySelectorAll('.fav img')) {
    const fallback = () => { const fav = img.parentElement; if (fav) fav.textContent = fav.dataset.letter || '·'; };
    if (img.complete && !img.naturalWidth) fallback(); else img.addEventListener('error', fallback, { once: true });
  }
}
