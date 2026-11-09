import { createHash } from 'node:crypto';
import { chmodSync as _chmod, copyFileSync as _copy, cpSync as _cp, existsSync as _exists, lstatSync as _lstat, mkdirSync as _mkdir, readFileSync as _read, readdirSync as _readdir, rmSync as _rm, writeFileSync as _write } from 'node:fs';
import { join as _join, relative as _relative } from 'node:path';
import { renameSync as _rename } from 'node:fs';
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

/**
 * Renames a path, trying again while Windows reports it in use (EPERM or EBUSY). A virus scanner, the
 * indexer or a child process that is still exiting can hold a file of a freshly built tree for a moment,
 * and a directory cannot be renamed meanwhile. Any other error, and the last failure, is thrown as is.
 * The waits grow (250 ms, 500 ms, ...), about 7 s in all with the defaults.
 */
export async function renameWithRetry(from, to, { rename = _rename, attempts = 8, delayMs = 250, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return rename(from, to); }
    catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY'].includes(error?.code)) throw error;
      await sleep(delayMs * attempt);
    }
  }
}

// ---- Trex Browser shell (Electron) packaging ------------------------------
// The pinned Electron runtime goes to trex-browser-runtime/shell with our app
// as real files in resources/app (no default app). Linux and Windows rename
// the executable to trex-browser-shell; macOS keeps Electron's bundle layout
// (helpers are located by name) inside "Trex Browser.app".
/** Chromium UI locales kept in the package (the rest fall back to en-US). */
export const SHELL_LOCALES = ['en-US', 'es', 'es-419'];
export const SHELL_EXECUTABLE = Object.freeze({ linux: 'trex-browser-shell', win32: 'trex-browser-shell.exe', darwin: 'Trex Browser.app/Contents/MacOS/Electron' });
export function packageShell(core, runtime, { platform = process.platform } = {}) {
  const source = _join(core, 'shell'), shellPackage = JSON.parse(_read(_join(source, 'package.json'), 'utf8')), pinned = shellPackage.devDependencies?.electron;
  if (!/^\d+\.\d+\.\d+$/.test(pinned || '')) throw new Error('The Trex Browser shell must pin an exact Electron version.');
  const dist = _join(source, 'node_modules', 'electron', 'dist');
  if (!_exists(_join(dist, 'version'))) throw new Error('Electron is not downloaded: run `npm ci` and `npx electron --version` in trex-browser/shell.');
  if (_read(_join(dist, 'version'), 'utf8').trim().replace(/^v/, '') !== pinned) throw new Error('Downloaded Electron does not match the pinned shell version.');
  const target = _join(runtime, 'shell'); _mkdir(target, { recursive: true });
  let appDir;
  if (platform === 'darwin') {
    const bundle = _join(target, 'Trex Browser.app');
    _cp(_join(dist, 'Electron.app'), bundle, { recursive: true, verbatimSymlinks: true });
    const resources = _join(bundle, 'Contents', 'Resources');
    _rm(_join(resources, 'default_app.asar'), { force: true });
    const plist = _join(bundle, 'Contents', 'Info.plist');
    let info = _read(plist, 'utf8');
    for (const [key, value] of [['CFBundleDisplayName', 'Trex Browser'], ['CFBundleName', 'Trex Browser'], ['CFBundleIdentifier', 'com.trex.browser']])
      info = info.replace(new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`), `$1${value}$2`);
    _write(plist, info);
    appDir = _join(resources, 'app');
  } else {
    for (const item of _readdir(dist, { withFileTypes: true })) {
      if (item.name === 'resources') continue;
      if (item.isSymbolicLink()) throw new Error('Electron distribution contains a link.');
      const name = item.name === 'electron' || item.name === 'electron.exe' ? SHELL_EXECUTABLE[platform] : item.name;
      _cp(_join(dist, item.name), _join(target, name), { recursive: true });
    }
    for (const pak of _readdir(_join(target, 'locales'))) if (!SHELL_LOCALES.includes(pak.replace(/\.pak$/, ''))) _rm(_join(target, 'locales', pak));
    appDir = _join(target, 'resources', 'app');
  }
  _mkdir(appDir, { recursive: true });
  _write(_join(appDir, 'package.json'), JSON.stringify({ name: shellPackage.name, productName: 'Trex Browser', desktopName: 'trex-browser.desktop', version: shellPackage.version, private: true, type: 'module', main: 'main.mjs' }, null, 2) + '\n');
  for (const name of ['main.mjs', 'preload.cjs', 'human-controls.mjs', 'scope-storage.mjs', 'scope-path.mjs', 'view-layout.mjs', 'theme.mjs']) _copy(_join(source, name), _join(appDir, name));
  _cp(_join(source, 'ui'), _join(appDir, 'ui'), { recursive: true });
  _cp(_join(source, 'icons'), _join(appDir, 'icons'), { recursive: true });
  if (platform === 'linux') {
    // The native guard refuses group/other-writable executables.
    const tighten = path => { const stat = _lstat(path); if (stat.isSymbolicLink()) throw new Error('Linux shell contains a link.'); _chmod(path, stat.mode & 0o755); if (stat.isDirectory()) for (const name of _readdir(path)) tighten(_join(path, name)); };
    tighten(target);
    for (const name of [SHELL_EXECUTABLE.linux, 'chrome_crashpad_handler', 'chrome-sandbox']) if (_exists(_join(target, name))) _chmod(_join(target, name), 0o755);
  }
  return { electron: pinned, executable: _relative(runtime, _join(target, SHELL_EXECUTABLE[platform])).replaceAll('\\', '/') };
}
