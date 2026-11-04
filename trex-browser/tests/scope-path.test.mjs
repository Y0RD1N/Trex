import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { scopePath } from '../shell/scope-path.mjs';

test('global scope identities preserve the existing per-project and personal storage locations', () => {
  const root = path.resolve('private-browser-home'), a = 'a'.repeat(24), b = 'b'.repeat(24);
  assert.equal(scopePath(root, `${a}/BROWSER2`), path.join(root, 'projects', a, 'BROWSER2', 'user-data'));
  assert.notEqual(scopePath(root, `${a}/BROWSER2`), scopePath(root, `${b}/BROWSER2`));
  assert.equal(scopePath(root, 'personal'), path.join(root, 'personal', 'user-data'));
});

test('scope storage refuses traversal, absolute paths and ambiguous project-less agent profiles', () => {
  for (const id of ['../personal', '/tmp/profile', 'BROWSER2', `${'a'.repeat(24)}/../personal`, `${'a'.repeat(24)}/BROWSER0`, `${'a'.repeat(24)}/BROWSER100`]) {
    assert.throws(() => scopePath(path.resolve('private-browser-home'), id), /Invalid browser space/);
  }
});
