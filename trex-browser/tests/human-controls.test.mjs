import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { humanControls } from '../shell/human-controls.mjs';
import { BrowserService } from '../worker/browser.mjs';
import { context } from '../worker/security.mjs';

test('human controls wait for the matching worker confirmation and expose failures', async () => {
  const sent = [], channel = humanControls(message => sent.push(message));
  const one = channel.request({ action: 'focus', clientId: 'agent', profile: 'BROWSER2' });
  const two = channel.request({ action: 'pause', clientId: 'other', profile: 'BROWSER3' });
  assert.equal(channel.complete({ requestId: 'foreign', result: { ok: true } }), false);
  channel.complete({ requestId: sent[1].requestId, result: { ok: true, action: 'pause' } });
  assert.equal((await two).action, 'pause');
  const rejected = assert.rejects(one, /No se pudo mostrar/);
  channel.complete({ requestId: sent[0].requestId, result: { ok: false, error: 'No se pudo mostrar' } }); await rejected;
  assert.equal(channel.complete({ requestId: sent[0].requestId, result: { ok: true } }), false); channel.close();
});
test('disconnected controls fail within their deadline and native close cancels pending work', async () => {
  const channel = humanControls(() => {}, { timeoutMs: 20 });
  await assert.rejects(channel.request({ action: 'pause' }), /no confirmó/);
  const pending = channel.request({ action: 'focus' }), rejected = assert.rejects(pending, /ventana.*cerró/); channel.close(); await rejected;
  await assert.rejects(channel.request({ action: 'focus' }), /no está disponible/);
  await assert.rejects(humanControls(() => {}).request({ action: 'arbitrary' }), /no válido/);
});
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-human-controls-'));
  fs.mkdirSync(path.join(home, 'artifacts'));
  t.after(() => { assert.equal(path.dirname(home), os.tmpdir()); assert.ok(path.basename(home).startsWith('trex-human-controls-')); fs.rmSync(home, { recursive: true, force: true }); });
  const service = new BrowserService(home); service.notifyShell = () => {};
  const ctx = context({ cwd: home, clientId: 'same-agent', profile: 'BROWSER2', mode: 'full' });
  const own = service.state(ctx), other = service.state({ ...ctx, profile: 'BROWSER3' });
  for (const state of [own, other]) { state.browser = {}; state.owner = ctx.clientId; state.shell = { focus: async () => { state.focused = true; return true; } }; }
  return { service, own, other };
}
test('center controls address the precise profile even when one client owns several spaces', async t => {
  const { service, own, other } = fixture(t);
  await service.shellEvent(own, { type: 'control', action: 'focus', clientId: 'same-agent', profile: 'BROWSER3' });
  assert.equal(other.focused, true); assert.equal(own.focused, undefined);
  await assert.rejects(service.shellEvent(own, { type: 'control', action: 'focus', clientId: 'same-agent', profile: 'BROWSER9' }), /ya no está abierto/);
});
test('pause interrupts active work, takeover keeps it paused, and resume does not bypass recovery', async t => {
  const { service, own, other } = fixture(t), controller = new AbortController(); other.active = { controller, id: 'pending', name: 'browser_click' };
  const request = action => service.shellEvent(own, { type: 'control', action, clientId: 'same-agent', profile: 'BROWSER3' });
  await request('pause'); assert.equal(controller.signal.aborted, true); assert.equal(other.pauseReason, 'manual');
  const pausedGeneration = other.generation; await request('pause'); assert.ok(other.generation > pausedGeneration);
  await assert.rejects(request('resume'), /aún está terminando/);
  await request('takeover'); assert.equal(other.focused, true); assert.equal(other.paused, true);
  other.active = null; await request('resume'); assert.equal(other.paused, false);
  service.pause(other, 'uncertain'); await request('takeover'); assert.equal(other.pauseReason, 'uncertain');
  await assert.rejects(request('resume'), /requiere revisar/);
});
test('capture calls observation on the target owner and returns the image to the panel', async t => {
  const { service, own, other } = fixture(t); let called;
  service.call = async (...args) => { called = args; return { image: { mimeType: 'image/jpeg', data: 'fixture' } }; };
  const result = await service.shellEvent(own, { type: 'control', action: 'screenshot', clientId: 'same-agent', profile: 'BROWSER3' });
  assert.equal(called[0], other.ctx); assert.equal(called[1], 'browser_take_screenshot'); assert.equal(result.image.data, 'fixture');
});
