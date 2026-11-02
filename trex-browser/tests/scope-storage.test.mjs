import assert from 'node:assert/strict';
import { it } from 'node:test';
import { storageCommand, grantedPermission } from '../shell/scope-storage.mjs';

it('bounds explicit permission grants to the profile and origin and supports reset', async () => {
  const a = {}, b = {};
  await storageCommand(a, 'Browser.grantPermissions', { origin: 'https://example.test', permissions: ['geolocation'] });
  assert.equal(grantedPermission(a, 'geolocation', 'https://example.test'), true);
  assert.equal(grantedPermission(b, 'geolocation', 'https://example.test'), false);
  assert.equal(grantedPermission(a, 'geolocation', 'https://other.test'), false);
  await assert.rejects(storageCommand(a, 'Browser.grantPermissions', { permissions: ['videoCapture'] }));
  await storageCommand(a, 'Browser.resetPermissions');
  assert.equal(grantedPermission(a, 'geolocation', 'https://example.test'), false);
});

it('cookie commands use only the supplied native session and cancellation requires an owned download', async () => {
  const writes = [], scope = { session: { cookies: { get: async () => [{ name: 'fixture', value: 'test', domain: 'example.test', path: '/', session: true }], set: async cookie => writes.push(cookie) } } };
  assert.equal((await storageCommand(scope, 'Storage.getCookies', { browserContextId: 'foreign' })).cookies.length, 1);
  await storageCommand(scope, 'Storage.setCookies', { cookies: [{ name: 'fixture', value: 'test', domain: '.example.test', secure: true, sameSite: 'Lax' }] });
  assert.equal(writes[0].url, 'https://example.test/'); assert.equal(writes[0].sameSite, 'lax');
  await assert.rejects(storageCommand(scope, 'Browser.cancelDownload', { guid: 'foreign' }), /outside/);
  let canceled = false; scope.downloadIds = new Map([['own', { cancel: () => { canceled = true; } }]]);
  await storageCommand(scope, 'Browser.cancelDownload', { guid: 'own' }); assert.equal(canceled, true);
});
