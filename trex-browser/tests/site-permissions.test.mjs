import assert from 'node:assert/strict';
import { it } from 'node:test';
import { PERSISTABLE, SESSION_ONLY, permissionKey, sanitizeSaved, permissionState, decisionFor, isGranted, recordDecision,
  chooserCancelled, chooserAnswered, hasSiteDecisions, forgetSite } from '../shell/site-permissions.mjs';

const SITE = 'https://example.test', RISKY = ['display-capture', 'media', 'openExternal'];
// What a browser start does: read the file back and begin with an empty memory.
const restart = state => permissionState(JSON.parse(JSON.stringify(state.saved)));

it('keeps the key format older versions wrote, with and without a profile', () => {
  assert.equal(permissionKey(undefined, SITE, 'geolocation'), 'https://example.test|geolocation');
  assert.equal(permissionKey('personal', SITE, 'geolocation'), 'personal|https://example.test|geolocation');
  for (const permission of RISKY) assert.equal(PERSISTABLE.has(permission), false);
  assert.deepEqual([...SESSION_ONLY].sort(), ['media', 'openExternal']);
});

it('never writes a risky permission, whatever the person answers', () => {
  const state = permissionState(undefined);
  for (const permission of RISKY) for (const profile of [undefined, 'personal']) {
    assert.equal(recordDecision(state, permissionKey(profile, SITE, permission), true), false, `${permission} asks for no file write`);
  }
  assert.equal(JSON.stringify(state.saved), '{}');
  // Camera, microphone and external apps last for this run; the screen is not remembered at all.
  assert.equal(decisionFor(state, permissionKey(undefined, SITE, 'media')), true);
  assert.equal(decisionFor(state, permissionKey('personal', SITE, 'openExternal')), true);
  assert.equal(decisionFor(state, permissionKey(undefined, SITE, 'display-capture')), undefined);
  assert.equal(isGranted(state, permissionKey('personal', SITE, 'display-capture')), false);
});

it('drops the risky allows of a legacy file and never answers from them', () => {
  const legacy = { 'https://example.test|display-capture': true, 'personal|https://example.test|media': true, 'https://example.test|openExternal': true,
    'https://example.test|notifications': true, 'personal|https://example.test|geolocation': true, 'https://example.test|midi': 'yes', 'https://example.test|clipboard-read': false, junk: true };
  const { saved, dropped } = sanitizeSaved(legacy);
  assert.deepEqual(saved, { 'https://example.test|notifications': true, 'personal|https://example.test|geolocation': true });
  assert.equal(dropped, 6);
  const state = permissionState(legacy);
  assert.equal(state.dropped, 6, 'the caller is told to rewrite the file');
  assert.equal(JSON.stringify(state.saved).includes('display-capture') || JSON.stringify(state.saved).includes('media'), false);
  for (const key of ['https://example.test|display-capture', 'personal|https://example.test|media', 'https://example.test|openExternal']) {
    assert.equal(decisionFor(state, key), undefined); assert.equal(isGranted(state, key), false);
    state.saved[key] = true;   // even if such an entry reached the saved map, the file is not a source for it
    assert.equal(isGranted(state, key), false);
  }
  assert.equal(isGranted(state, 'https://example.test|notifications'), true);
  for (const raw of [undefined, null, [], 'x', 7]) assert.deepEqual(sanitizeSaved(raw), { saved: {}, dropped: 0 });
});

it('persists a low-risk allow across restarts and keeps a block only for this run', () => {
  const state = permissionState(undefined), allowed = permissionKey('personal', SITE, 'notifications'), blocked = permissionKey('personal', SITE, 'geolocation');
  assert.equal(recordDecision(state, allowed, true), true, 'the file must be written');
  assert.equal(recordDecision(state, blocked, false), false);
  assert.equal(decisionFor(state, allowed), true); assert.equal(decisionFor(state, blocked), false);
  const next = restart(state);
  assert.equal(next.dropped, 0);
  assert.equal(isGranted(next, allowed), true);
  assert.equal(decisionFor(next, blocked), undefined, 'a block is asked again after a restart');
  assert.equal(isGranted(next, permissionKey('other', SITE, 'notifications')), false, 'another profile is not covered');
});

it('honours session grants in the check path and loses them with a fresh state', () => {
  const state = permissionState(undefined), camera = permissionKey('personal', SITE, 'media'), external = permissionKey(undefined, SITE, 'openExternal');
  assert.equal(isGranted(state, camera), false);
  recordDecision(state, camera, true); recordDecision(state, external, true);
  assert.equal(isGranted(state, camera), true); assert.equal(isGranted(state, external), true);
  assert.equal(isGranted(state, permissionKey(undefined, SITE, 'media')), false, 'the grant belongs to its profile');
  assert.equal(isGranted(state, permissionKey('personal', 'https://other.test', 'media')), false, 'and to its origin');
  const next = restart(state);
  assert.equal(isGranted(next, camera), false); assert.equal(isGranted(next, external), false);
  assert.equal(decisionFor(next, camera), undefined, 'the person is asked again');
});

it('blocks a site whose screen chooser keeps being cancelled, until restart or until it is forgotten', () => {
  const state = permissionState(undefined), key = permissionKey(undefined, SITE, 'display-capture');
  assert.equal(chooserCancelled(state, key), false); assert.equal(chooserCancelled(state, key), false);
  chooserAnswered(state, key);                                   // sharing something starts the count again
  assert.equal(chooserCancelled(state, key), false); assert.equal(chooserCancelled(state, key), false);
  assert.equal(decisionFor(state, key), undefined);
  assert.equal(chooserCancelled(state, key), true);
  assert.equal(decisionFor(state, key), false);
  assert.equal(hasSiteDecisions(state, undefined, SITE), true);
  assert.equal(forgetSite(state, undefined, SITE), false, 'nothing of it was in the file');
  assert.equal(decisionFor(state, key), undefined);
  assert.equal(decisionFor(restart(state), key), undefined);
});

it('forgets one origin in one profile, saved and session decisions alike, and nothing else', () => {
  const state = permissionState(undefined);
  const mine = ['notifications', 'media', 'geolocation'].map(permission => permissionKey('personal', SITE, permission));
  const others = [permissionKey(undefined, SITE, 'notifications'), permissionKey('agent', SITE, 'notifications'), permissionKey('personal', 'https://other.test', 'notifications'),
    permissionKey('personal', 'https://example.test.evil.test', 'notifications'), permissionKey('personal', 'https://example.test:8443', 'media'), permissionKey('agent', SITE, 'media')];
  recordDecision(state, mine[0], true); recordDecision(state, mine[1], true); recordDecision(state, mine[2], false);
  for (const key of others) recordDecision(state, key, true);
  assert.equal(hasSiteDecisions(state, 'personal', SITE), true);
  assert.equal(hasSiteDecisions(state, 'personal', 'https://never.test'), false);
  assert.equal(hasSiteDecisions(state, 'personal', ''), false);
  assert.equal(forgetSite(state, 'personal', SITE), true, 'the file must be rewritten');
  for (const key of mine) assert.equal(decisionFor(state, key), undefined);
  for (const key of others) assert.equal(decisionFor(state, key), true, `${key} is untouched`);
  assert.equal(hasSiteDecisions(state, 'personal', SITE), false);
  assert.deepEqual(Object.keys(state.saved).sort(), others.filter(key => key.endsWith('|notifications')).sort());
  assert.equal(forgetSite(state, 'personal', SITE), false);
  // A session-only decision needs no file write.
  assert.equal(forgetSite(state, 'agent', SITE), true); recordDecision(state, others[5], true);
  assert.equal(forgetSite(state, 'agent', SITE), false); assert.equal(isGranted(state, others[5]), false);
});
