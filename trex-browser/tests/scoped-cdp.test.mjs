import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import { ScopedCdp } from '../worker/scoped-cdp.mjs';

function fixture(options = {}) {
  const root = new EventEmitter(), sent = [], replies = [];
  root.send = async (method, params) => {
    sent.push({ method, params });
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'own' }, { targetId: 'foreign' }] };
    return {};
  };
  root.detach = async () => {};
  const transport = new ScopedCdp(root, { targets: ['own'], ...options });
  transport.onmessage = message => replies.push(message);
  let id = 0;
  const command = async (method, params = {}, sessionId) => {
    const message = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    transport.send(message);
    for (let turn = 0; turn < 20; turn++) {
      await new Promise(resolve => setImmediate(resolve));
      const reply = replies.find(reply => reply.id === message.id && reply.sessionId === message.sessionId);
      if (reply) return reply;
    }
    throw new Error(`No reply for ${method}`);
  };
  return { root, sent, replies, transport, command };
}

it('filters target inventory and rejects foreign targets even through an owned page session', async () => {
  const f = fixture();
  f.root.emit('Target.attachedToTarget', { sessionId: 'page', targetInfo: { targetId: 'own' } });
  assert.deepEqual((await f.command('Target.getTargets')).result.targetInfos, [{ targetId: 'own' }]);
  for (const channel of [undefined, 'page']) {
    for (const method of ['Target.attachToTarget', 'Target.closeTarget', 'Target.getTargetInfo'])
      assert.match((await f.command(method, { targetId: 'foreign' }, channel)).error.message, /outside/);
    for (const method of ['Browser.close', 'Target.sendMessageToTarget', 'Target.disposeBrowserContext', 'Storage.clearDataForOrigin'])
      assert.match((await f.command(method, {}, channel)).error.message, /Browser-wide/);
  }
  assert.match((await f.command('Runtime.evaluate', {}, 'foreign-session')).error.message, /outside/);
  assert.equal(f.sent.some(item => item.method === 'Target.closeTarget'), false);
});

it('routes cookies and downloads to the native scope and replies asynchronously', async () => {
  const stored = [], f = fixture({ storage: async (method, params) => { stored.push({ method, params }); return { cookies: [] }; } });
  f.root.emit('Target.attachedToTarget', { sessionId: 'page', targetInfo: { targetId: 'own' } });
  const reply = await f.command('Storage.getCookies', { browserContextId: 'foreign' }, 'page');
  assert.equal(reply.sessionId, 'page'); assert.deepEqual(reply.result, { cookies: [] });
  await f.command('Browser.cancelDownload', { guid: 'file' });
  assert.deepEqual(stored.map(call => call.method), ['Storage.getCookies', 'Browser.cancelDownload']);
  const before = f.replies.length;
  f.transport.send({ id: 100, method: 'Target.attachToBrowserTarget', params: {} });
  assert.equal(f.replies.length, before, 'Playwright registers callbacks after send returns');
  await new Promise(resolve => setImmediate(resolve));
  const channel = f.replies.find(reply => reply.id === 100).result.sessionId;
  assert.equal((await f.command('Target.getTargets', {}, channel)).result.targetInfos.length, 1);
  assert.match((await f.command('Browser.close', {}, channel)).error.message, /Browser-wide/);
});

it('does not expose foreign events and releases performance trace ownership on error and disconnect', async () => {
  const phases = [], f = fixture({ traceControl: phase => phases.push(phase) });
  f.root.emit('Target.attachedToTarget', { sessionId: 'other', targetInfo: { targetId: 'foreign' } });
  f.root.emit('Target.receivedMessageFromTarget', { sessionId: 'other', message: JSON.stringify({ method: 'Page.frameNavigated', params: {} }) });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.replies.length, 0);
  f.root.emit('Target.attachedToTarget', { sessionId: 'page', targetInfo: { targetId: 'own' } });
  f.transport.send({ id: 3, method: 'Tracing.start', sessionId: 'page' });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(phases, ['start']);
  f.root.emit('Target.receivedMessageFromTarget', { sessionId: 'page', message: JSON.stringify({ id: 3, error: { message: 'busy' } }) });
  assert.deepEqual(phases, ['start', 'end']);
  f.transport.close(); assert.equal(phases.at(-1), 'end');
});
