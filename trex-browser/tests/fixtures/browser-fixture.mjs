import http from 'node:http';
import { once } from 'node:events';

const page = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Trex loopback fixture</title>
<style>
body { font: 16px sans-serif; margin: 24px; background: #eef4fa; color: #172331; }
button, input, select { margin: 6px; padding: 8px; }
iframe { display: block; width: 480px; height: 140px; }
#animation { width: 24px; height: 24px; background: #136ac5; animation: move 1s infinite alternate; }
@keyframes move { to { transform: translateX(240px); } }
</style></head><body>
<h1>Trex local integration fixture</h1>
<button id="increment">Increment counter</button><output id="count">0</output>
<form id="form">
<label>Name <input id="name" name="name" aria-label="Name"></label>
<label>Notes <textarea id="notes" aria-label="Notes"></textarea></label>
<label><input id="agree" type="checkbox">Agree</label>
<label>Color <select id="color"><option value="red">Red</option><option value="blue">Blue</option></select></label>
<input id="upload" type="file" aria-label="Upload fixture">
<button id="submit" type="submit">Submit fixture</button>
</form><output id="submitted"></output>
<a id="next" href="/next">Next fixture page</a>
<a id="popup" href="/popup" target="_blank">Open fixture popup</a>
<a id="download" href="/download">Download fixture</a>
<iframe name="fixture-frame" title="Fixture frame" src="/frame"></iframe>
<div id="animation" aria-label="Animated square"></div>
<script>
document.querySelector('#increment').onclick = () => {
  document.querySelector('#count').textContent = String(Number(document.querySelector('#count').textContent) + 1);
};
document.querySelector('#form').onsubmit = event => {
  event.preventDefault();
  document.querySelector('#submitted').textContent = 'Submitted ' + document.querySelector('#name').value;
};
console.info('loopback fixture ready');
</script></body></html>`;

export const downloadBytes = Buffer.from('Trex loopback download\n', 'utf8');

const controlsPage = `<!doctype html><html><head><title>Trex pointer controls fixture</title>
<style>body{font:16px sans-serif;margin:24px}button{padding:10px;margin:8px}.drag-row{display:flex;gap:36px;margin:20px 0}.drag-row div{width:150px;height:65px;background:#ddd;display:grid;place-items:center}#scroll-panel{height:120px;width:320px;overflow:auto;border:1px solid}#scroll-panel div{height:900px}</style></head><body>
<button id="low-click" onclick="document.querySelector('#low-count').textContent=String(Number(document.querySelector('#low-count').textContent)+1)">Pointer target</button><output id="low-count">0</output>
<button id="hover-target" onmouseenter="document.querySelector('#hover-state').textContent='Hovered'">Hover target</button><output id="hover-state">Idle</output>
<div class="drag-row"><div id="drag-source" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','fixture payload')">Drag source</div><div id="drag-target" ondragover="event.preventDefault()" ondrop="event.preventDefault();this.textContent='Dropped '+event.dataTransfer.getData('text/plain')">Drop target</div></div>
<div id="scroll-panel" onscroll="document.querySelector('#scroll-state').textContent='Scrolled'"><div>Scrollable test content</div></div><output id="scroll-state">Idle</output>
</body></html>`;

// Every page, request, popup, upload and download stays on this ephemeral server.
export async function startBrowserFixture() {
  const requests = [];
  const gates = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, pathname: url.pathname });
    const send = (status, type, body, extra = {}) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      response.writeHead(status, {
        'content-type': type,
        'content-length': bytes.length,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        ...extra,
      });
      response.end(bytes);
    };
    if (url.pathname.startsWith('/gate/')) {
      const id = url.pathname.slice('/gate/'.length);
      if (!/^[a-z0-9-]{1,80}$/i.test(id) || gates.has(id) || gates.size >= 16) return send(400, 'text/plain', 'Invalid test gate');
      const finish = status => { clearTimeout(timer); gates.delete(id); send(status, 'application/json', JSON.stringify({ released: status === 200 })); };
      const timer = setTimeout(() => finish(504), 60_000); timer.unref();
      gates.set(id, () => finish(200));
      response.once('close', () => { clearTimeout(timer); gates.delete(id); });
      return;
    }
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', page);
    if (url.pathname === '/controls') return send(200, 'text/html; charset=utf-8', controlsPage);
    if (url.pathname === '/frame') return send(200, 'text/html', '<!doctype html><html><body><h2>Child frame</h2><button id="frame-button" onclick="this.textContent=\'Frame clicked\'">Frame action</button></body></html>');
    if (url.pathname === '/next' || url.pathname === '/popup') return send(200, 'text/html', `<!doctype html><html><head><title>${url.pathname === '/next' ? 'Next' : 'Popup'} fixture</title></head><body><h1>${url.pathname.slice(1)} fixture</h1><a href="/">Home</a></body></html>`);
    if (url.pathname === '/api/echo') {
      let body = '';
      for await (const chunk of request) body += chunk;
      return send(200, 'application/json', JSON.stringify({ source: 'loopback', method: request.method, body }));
    }
    if (url.pathname === '/download') return send(200, 'application/octet-stream', downloadBytes, { 'content-disposition': 'attachment; filename="fixture.txt"' });
    if (url.pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
    send(404, 'text/plain', 'Fixture route not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    isGateHeld(id) { return gates.has(id); },
    releaseGate(id) { const release = gates.get(id); if (!release) return false; release(); return true; },
    async close() {
      for (const release of [...gates.values()]) release();
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
