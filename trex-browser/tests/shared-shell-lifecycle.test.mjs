import assert from 'node:assert/strict';
import test from 'node:test';
import { SharedShell } from '../worker/shared-shell.mjs';

test('an arriving personal window survives the last agent finishing during native scope creation', async () => {
  const host = new SharedShell();
  let finishOpening;
  const opening = new Promise(resolve => { finishOpening = resolve; });
  host.link = { call: async name => { if (name === 'openScope') await opening; return true; } };
  host.shutdown = async () => { host.closed = true; };
  host.scopes.set('agent', { browser: { close: async () => {} } });
  const personal = host.openHuman({ profile: 'personal', label: 'Personal' });
  await host.release('agent');
  assert.notEqual(host.closed, true);
  finishOpening();
  assert.equal((await personal).opened, true);
  assert.equal(host.humanScopes.has('personal'), true);
});

test('detaching an agent preserves targets in its manually opened space for the next connection', async () => {
  const host = new SharedShell();
  host.link = { call: async () => true };
  host.humanScopes.add('agent'); host.targets.set('agent', new Set(['tab-one', 'tab-two']));
  host.scopes.set('agent', { browser: { close: async () => {} } });
  await host.release('agent');
  assert.deepEqual([...host.targets.get('agent')], ['tab-one', 'tab-two']);
});
