import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLinuxExecutable } from './build-trex-browser-linux.mjs';
import { LINUX_NODE_ARCHIVES, NODE_VERSION, verifyNodeArchive } from './browser-build-common.mjs';

test('Linux private runtime rejects the wrong ELF architecture and non-native payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'trex-linux-elf-'));
  try {
    const file = join(root, 'node'), bytes = Buffer.alloc(4096);
    bytes.set([127, 69, 76, 70, 2, 1]); bytes.writeUInt16LE(62, 18);
    writeFileSync(file, bytes);
    assert.doesNotThrow(() => assertLinuxExecutable(file, 'x64'));
    assert.throws(() => assertLinuxExecutable(file, 'arm64'));
    bytes[4] = 1; writeFileSync(file, bytes);
    assert.throws(() => assertLinuxExecutable(file, 'x64'));
    writeFileSync(file, '#!/bin/sh\necho fake');
    assert.throws(() => assertLinuxExecutable(file, 'x64'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux Node downloads must match pinned official archive hashes', () => {
  for (const arch of ['x64', 'arm64']) {
    assert.match(LINUX_NODE_ARCHIVES[arch], /^[a-f0-9]{64}$/);
    assert.throws(() => verifyNodeArchive(Buffer.from('forged runtime'),
      `${LINUX_NODE_ARCHIVES[arch]}  node-v${NODE_VERSION}-linux-${arch}.tar.xz\n`, arch, 'linux'));
  }
});

test('Fedora RPM installs executable siblings and its private runtime at fixed paths', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.linux.conf.json', import.meta.url)));
  assert.deepEqual(config.bundle.targets, ['rpm']);
  const rpm = config.bundle.linux.rpm;
  assert.equal(rpm.files['/usr/bin/trex-agent'], 'installer/payload/trex-agent');
  assert.equal(rpm.files['/usr/bin/trex-browser'], 'installer/payload/browser-linux/trex-browser');
  assert.equal(rpm.files['/usr/lib/trex/trex-browser-runtime/'], 'installer/payload/browser-linux/trex-browser-runtime/');
  assert.ok(rpm.depends.includes('webkit2gtk4.1'));
});
