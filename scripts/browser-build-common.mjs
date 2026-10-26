import { createHash } from 'node:crypto';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const NODE_VERSION = '24.22.1';
export const NODE_ARCHIVES = Object.freeze({
  x64: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
  arm64: 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171',
});
export const LINUX_NODE_ARCHIVES = Object.freeze({
  x64: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
  arm64: 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e',
});

export function cleanBuildEnvironment(inherited) {
  // Playwright accepts both direct variables and npm config aliases for its
  // download host. Remove inherited configuration before setting owned values;
  // npm must also use the isolated config/cache selected below.
  return Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    !/^(?:PLAYWRIGHT_|NPM_CONFIG_|NPM_PACKAGE_CONFIG_)/i.test(name)
      && !/^(?:NODE_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED)$/i.test(name)));
}

export function verifyNodeArchive(bytes, manifest, arch, platform = 'win') {
  const filename = platform === 'linux' ? `node-v${NODE_VERSION}-linux-${arch}.tar.xz` : `node-v${NODE_VERSION}-win-${arch}.zip`;
  const expected = (platform === 'linux' ? LINUX_NODE_ARCHIVES : NODE_ARCHIVES)[arch];
  if (!expected) throw new Error('Unsupported private Node architecture.');
  const entry = manifest.split(/\r?\n/).find(line => line.trim().endsWith(`  ${filename}`));
  if (entry?.split(/\s+/)[0] !== expected || sha256(bytes) !== expected) {
    throw new Error('Official Node archive or SHA256 manifest verification failed.');
  }
}

export function assertPinnedLock(packageJson, lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages || !packageJson.dependencies?.playwright
      || !/^\d+\.\d+\.\d+$/.test(packageJson.dependencies.playwright)
      || lock.packages['']?.dependencies?.playwright !== packageJson.dependencies.playwright) {
    throw new Error('Trex Browser requires an exact Playwright version and matching npm v3 lock.');
  }
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || lock.packages['']?.dependencies?.[name] !== version) {
      throw new Error('Browser runtime dependencies must all be exact versions matching the lock.');
    }
  }
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (item.link || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(item.version ?? '')
        || !item.resolved?.startsWith('https://registry.npmjs.org/')
        || !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity ?? '')) {
      throw new Error('Browser dependencies must be pinned HTTPS registry packages with SHA512 integrity.');
    }
  }
}

export function assertBrowserMcpHandshake(output) {
  const frames = String(output).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const initialized = frames.find(frame => frame.id === 1);
  const inventory = frames.find(frame => frame.id === 2);
  if (initialized?.error || initialized?.result?.protocolVersion !== '2025-06-18'
      || !Array.isArray(inventory?.result?.tools)
      || !['browser_navigate', 'browser_snapshot', 'browser_status'].every(name => inventory.result.tools.some(tool => tool.name === name))) {
    throw new Error('Assembled Browser payload did not negotiate the Codex MCP protocol and navigation tools.');
  }
}
