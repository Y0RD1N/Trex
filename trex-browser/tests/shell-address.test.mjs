// What the shell's address field accepts and what its error page shows. These live in main.mjs (the
// Electron main process), so the functions are read from the source and run without Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../shell/main.mjs', import.meta.url), 'utf8');
const grab = pattern => { const match = pattern.exec(source); assert.ok(match, `not found in main.mjs: ${pattern}`); return match[0]; };
const normalizeAddress = new Function(`${grab(/function normalizeAddress\(input\) \{[\s\S]*?\n\}/)};return normalizeAddress;`)();
const errorPage = new Function(`${grab(/const NET_ERRORS = \{[\s\S]*?\n\};/)}\n${grab(/const escapeHtml = [^\n]+/)}\n${grab(/function errorPage\(url\) \{[\s\S]*?\n\}/)}\nreturn errorPage;`)();

test('web addresses, development hosts and searches are told apart', () => {
  assert.equal(normalizeAddress('example.com'), 'https://example.com');
  assert.equal(normalizeAddress('docs.rs/serde'), 'https://docs.rs/serde');
  assert.equal(normalizeAddress('https://x.org/a?b=1'), 'https://x.org/a?b=1');
  assert.equal(normalizeAddress('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeAddress('127.0.0.1:5173/app'), 'http://127.0.0.1:5173/app');
  assert.equal(normalizeAddress('[::1]:8080'), 'http://[::1]:8080');
  assert.equal(normalizeAddress('hola mundo'), 'https://duckduckgo.com/?q=hola%20mundo');
  assert.equal(normalizeAddress('palabra'), 'https://duckduckgo.com/?q=palabra');
});

test('LAN addresses and hosts with a custom port use http, as in every browser', () => {
  assert.equal(normalizeAddress('192.168.1.5:8080/panel'), 'http://192.168.1.5:8080/panel');
  assert.equal(normalizeAddress('10.0.0.2'), 'http://10.0.0.2');
  assert.equal(normalizeAddress('foo.test:3000'), 'http://foo.test:3000');
  assert.equal(normalizeAddress('mi-servidor.local'), 'http://mi-servidor.local');
  assert.equal(normalizeAddress('intranet:8080'), 'http://intranet:8080');
  assert.equal(normalizeAddress('example.com:8443'), 'https://example.com:8443', 'secure ports stay https');
  assert.equal(normalizeAddress('example.com:443/x'), 'https://example.com:443/x');
});

test('about:blank, file: and view-source: are kept; internal browser pages are searches', () => {
  assert.equal(normalizeAddress('about:blank'), 'about:blank');
  assert.equal(normalizeAddress('file:///tmp/a.html'), 'file:///tmp/a.html');
  assert.equal(normalizeAddress('view-source:https://example.com'), 'view-source:https://example.com');
  assert.match(normalizeAddress('chrome://settings'), /^https:\/\/duckduckgo\.com\/\?q=/);
});

test('the error page explains the failure in Spanish and offers a retry for web addresses only', async () => {
  const html = await errorPage(new URL('trex://error/?code=ERR_NAME_NOT_RESOLVED&url=' + encodeURIComponent('http://no-existe.invalid/'))).text();
  assert.match(html, /<h1>No se encontró el sitio<\/h1>/);
  assert.match(html, /href="http:\/\/no-existe\.invalid\/"/);
  const crash = await errorPage(new URL('trex://error/?code=CRASHED&url=' + encodeURIComponent('https://example.com/'))).text();
  assert.match(crash, /La pestaña se cerró inesperadamente/);
  const noRetry = await errorPage(new URL('trex://error/?code=ERR_BLOCKED_BY_CLIENT&url=' + encodeURIComponent('file:///etc/passwd'))).text();
  assert.doesNotMatch(noRetry, /class="btn"/);
});

test('nothing in the error page URL can inject markup', async () => {
  const evil = '"><script>alert(1)</script>';
  const html = await errorPage(new URL('trex://error/?code=' + encodeURIComponent(evil) + '&url=' + encodeURIComponent('http://x.test/' + evil))).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<h1>No se pudo cargar la página<\/h1>/, 'an unknown code falls back to the generic message');
});
