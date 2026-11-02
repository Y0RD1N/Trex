// New tab page: runs as an ordinary page (no shell API) and navigates itself.
const form = document.getElementById('go'), q = document.getElementById('q');
function address(text) {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}
form.addEventListener('submit', e => { e.preventDefault(); if (q.value.trim()) location.href = address(q.value); });
for (const a of document.querySelectorAll('[data-url]')) a.addEventListener('click', () => { location.href = a.dataset.url; });
const h = new Date().getHours();
document.getElementById('hello').textContent = h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
