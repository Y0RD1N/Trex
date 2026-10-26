import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build-time downloads only. Installed execution uses these private assets,
// never npm, npx, PATH Node, or an unpinned package resolution.
import { NODE_VERSION, NODE_ARCHIVES, verifyNodeArchive, assertPinnedLock, cleanBuildEnvironment, assertBrowserMcpHandshake } from './browser-build-common.mjs';
export { NODE_VERSION, NODE_ARCHIVES, verifyNodeArchive, assertPinnedLock, cleanBuildEnvironment, assertBrowserMcpHandshake };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installerRoot = join(root, 'src-tauri', 'installer');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, shell: false, windowsHide: true, stdio: 'inherit', timeout: 15 * 60_000, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Trex Browser build command failed.');
  return result.stdout;
}

async function officialDownload(url, limit) {
  // fetch performs ordinary certificate/hostname verification. No insecure TLS
  // switch, credentials, alternate mirror, or redirect to another origin.
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error('Cannot download the pinned official Node release.');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('Official Node download exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function removeBuildTree(path) {
  const resolved = resolve(path);
  if (!resolved.startsWith(`${resolve(installerRoot)}${sep}`)
      || resolved === resolve(installerRoot)) throw new Error('Unsafe build cleanup target.');
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) throw new Error('Build directory is a link.');
  rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}

function walkFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw new Error('Runtime payload cannot contain links.');
    if (entry.isDirectory()) files.push(...walkFiles(path, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error('Runtime payload contains an unsupported filesystem entry.');
  }
  return files.sort();
}

function assertPe(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 4096 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('Runtime executable is not a real PE binary.');
}

export async function buildBrowser(argv = process.argv.slice(2)) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Verified TLS is required for Browser runtime downloads.');
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  const linuxTarget = target ? target.includes('linux') : process.platform === 'linux';
  if (linuxTarget) { const { buildLinuxBrowser } = await import('./build-trex-browser-linux.mjs'); return buildLinuxBrowser(argv); }
  const windowsTarget = target ? target.includes('windows') : process.platform === 'win32';
  if (!windowsTarget) {
    if (argv.includes('--standalone')) throw new Error('The standalone Trex Browser installer targets Windows only.');
    console.log('Optional Trex Browser Windows payload skipped for this desktop target.');
    return;
  }
  if (process.platform !== 'win32') throw new Error('Build the private Windows Browser runtime on a Windows host.');
  const debug = argv.includes('--debug') || process.env.TAURI_ENV_DEBUG === 'true';
  const buildEnv = cleanBuildEnvironment(process.env);
  const arch = target ? (target.startsWith('aarch64-') ? 'arm64' : target.startsWith('x86_64-') ? 'x64' : '') : process.arch;
  if (!NODE_ARCHIVES[arch]) throw new Error('Unsupported Browser installer target.');
  const coreRoot = join(root, 'trex-browser');
  const packageJson = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(coreRoot, 'package-lock.json'), 'utf8'));
  assertPinnedLock(packageJson, lock);
  const workers = readdirSync(join(coreRoot, 'worker')).filter(name => name.endsWith('.mjs'));
  if (!workers.includes('worker.mjs') || !existsSync(join(coreRoot, 'Cargo.lock'))) {
    throw new Error('Browser core sources/locked launcher are not ready; refusing to stage an incomplete payload.');
  }
  const hostInfo = run('rustc', ['-vV'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const host = /^host: (.+)$/m.exec(hostInfo)?.[1]?.trim();
  const explicitTarget = target && target !== host ? target : undefined;
  if (arch !== process.arch) throw new Error('Build the private Browser runtime on its target architecture to verify every executable.');
  const cargoArgs = ['build', '--locked', '--manifest-path', join(coreRoot, 'Cargo.toml'), '--target-dir', join(coreRoot, 'target')];
  if (!debug) cargoArgs.push('--release');
  if (explicitTarget) cargoArgs.push('--target', explicitTarget);
  run('cargo', cargoArgs);
  const launcher = join(coreRoot, 'target', ...(explicitTarget ? [explicitTarget] : []), debug ? 'debug' : 'release', 'trex-browser.exe');
  assertPe(launcher);

  const cache = join(installerRoot, '.cache', `node-v${NODE_VERSION}-win-${arch}`);
  mkdirSync(cache, { recursive: true });
  const filename = `node-v${NODE_VERSION}-win-${arch}.zip`;
  const archive = join(cache, filename);
  const release = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const manifest = (await officialDownload(`${release}/SHASUMS256.txt`, 128 * 1024)).toString('utf8');
  let bytes = existsSync(archive) ? readFileSync(archive) : await officialDownload(`${release}/${filename}`, 128 * 1024 * 1024);
  verifyNodeArchive(bytes, manifest, arch);
  if (!existsSync(archive)) writeFileSync(archive, bytes, { flag: 'wx' });
  bytes = undefined;

  const work = join(installerRoot, 'payload', `.browser-build-${randomUUID()}`);
  mkdirSync(work, { recursive: true });
  let promoted = false;
  try {
    const extracted = join(work, 'node-archive');
    const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const tar = join(windowsRoot, 'System32', 'tar.exe');
    mkdirSync(extracted);
    if (existsSync(tar)) run(tar, ['-xf', archive, '-C', extracted]);
    else {
      const powershell = join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:TREX_BUILD_NODE_ZIP -DestinationPath $env:TREX_BUILD_NODE_EXTRACT -ErrorAction Stop'],
      { env: { ...process.env, TREX_BUILD_NODE_ZIP: archive, TREX_BUILD_NODE_EXTRACT: extracted } });
    }
    const distribution = join(extracted, `node-v${NODE_VERSION}-win-${arch}`);
    const payload = join(work, 'browser');
    const runtime = join(payload, 'trex-browser-runtime');
    mkdirSync(runtime, { recursive: true });
    copyFileSync(launcher, join(payload, 'trex-browser.exe'));
    copyFileSync(join(distribution, 'node.exe'), join(runtime, 'node.exe'));
    copyFileSync(join(distribution, 'LICENSE'), join(runtime, 'NODE_LICENSE'));
    for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(coreRoot, name), join(runtime, name));
    for (const name of workers) copyFileSync(join(coreRoot, 'worker', name), join(runtime, name));
    const node = join(runtime, 'node.exe');
    assertPe(node);
    const version = run(node, ['--version'], { env: buildEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    if (version !== `v${NODE_VERSION}`) throw new Error('Private Node version verification failed.');
    const env = { ...buildEnv, TREX_BROWSER_HOME: join(work, 'private-probe-home'),
      APPDATA: join(work, 'probe-roaming'), LOCALAPPDATA: join(work, 'probe-local'),
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PLAYWRIGHT_BROWSERS_PATH: join(runtime, 'ffmpeg'),
      npm_config_cache: join(installerRoot, '.cache', 'npm'), npm_config_update_notifier: 'false',
      npm_config_userconfig: join(work, 'empty.npmrc'), npm_config_globalconfig: join(work, 'empty-global.npmrc') };
    // The private official Node runs the archive's npm CLI at build time only.
    run(node, [join(distribution, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime, env });
    // Official pinned Playwright selects its pinned ffmpeg revision and HTTPS
    // download. The assembled executable is verified and hashed below.
    delete env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
    run(node, [join(runtime, 'node_modules', 'playwright', 'cli.js'), 'install', 'ffmpeg'], { cwd: runtime, env });
    const executables = walkFiles(join(runtime, 'ffmpeg')).filter(name => /ffmpeg[^\\/]*\.exe$/i.test(name));
    if (executables.length !== 1) throw new Error('Expected exactly one real Playwright ffmpeg executable.');
    const ffmpeg = join(runtime, 'ffmpeg', executables[0]);
    assertPe(ffmpeg);
    const ffmpegVersion = run(ffmpeg, ['-version'], { cwd: runtime, timeout: 15_000,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!/^ffmpeg version /m.test(ffmpegVersion)) throw new Error('Playwright ffmpeg version verification failed.');
    const links = join(runtime, 'ffmpeg', '.links');
    if (existsSync(links)) removeBuildTree(links);
    const files = walkFiles(payload);
    for (const name of files.filter(name => name.endsWith('.exe'))) assertPe(join(payload, name));
    const assets = files.map(name => ({ path: name.replaceAll('\\', '/'), bytes: lstatSync(join(payload, name)).size,
      sha256: sha256(readFileSync(join(payload, name))) }));
    writeFileSync(join(runtime, 'runtime-manifest.json'), `${JSON.stringify({ version: packageJson.version,
      hashStage: 'before-code-signing',
      node: NODE_VERSION, nodeArchiveSha256: NODE_ARCHIVES[arch], playwright: packageJson.dependencies.playwright,
      architecture: arch, ffmpeg: relative(payload, ffmpeg).replaceAll('\\', '/'), assets }, null, 2)}\n`);
    // A real non-launching machine probe checks the assembled layout before it
    // can replace the previous payload. No browser/profile or daemon is started.
    const probe = JSON.parse(run(join(payload, 'trex-browser.exe'), ['doctor', '--json'],
      { cwd: payload, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 15_000 }));
    if (probe.protocolVersion !== '2025-11-25' || !probe.runtime?.node || !probe.runtime?.playwright) {
      throw new Error('Assembled Browser payload did not pass its runtime doctor.');
    }
    const handshake = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trex-build-check', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    assertBrowserMcpHandshake(run(join(payload, 'trex-browser.exe'), ['mcp', '--cwd', work, '--mode', 'observe', '--client', 'build-check'],
      { cwd: payload, env, input: handshake, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], timeout: 15_000 }));
    const destination = join(installerRoot, 'payload', 'browser');
    const previous = join(work, 'previous');
    if (existsSync(destination)) {
      if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory()) throw new Error('Payload destination is not an ordinary directory.');
      renameSync(destination, previous);
    }
    try { renameSync(payload, destination); }
    catch (error) { if (existsSync(previous)) renameSync(previous, destination); throw error; }
    promoted = true;
    if (debug) {
      // This single checkout-local layout is the only development fallback.
      const debugRoot = join(coreRoot, 'target', 'debug');
      if (resolve(launcher) !== resolve(join(debugRoot, 'trex-browser.exe'))) copyFileSync(launcher, join(debugRoot, 'trex-browser.exe'));
      cpSync(join(destination, 'trex-browser-runtime'), join(debugRoot, 'trex-browser-runtime'), { recursive: true });
    }
    if (argv.includes('--standalone')) {
      const compiler = process.env.TREX_MAKENSIS ?? join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe');
      if (!existsSync(compiler)) throw new Error('NSIS compiler is missing; set TREX_MAKENSIS to an absolute makensis.exe path.');
      const out = join(installerRoot, 'output', `TrexBrowser_${packageJson.version}_${arch}-setup.exe`);
      mkdirSync(dirname(out), { recursive: true });
      const temporaryOut = join(dirname(out), `.TrexBrowser_${randomUUID()}.tmp.exe`);
      try {
        run(resolve(compiler), ['/NOCONFIG', '/WX', '/INPUTCHARSET', 'UTF8', '/OUTPUTCHARSET', 'UTF8', '/V2',
          `/DTREX_BROWSER_PAYLOAD_DIR=${destination}`, `/DTREX_BROWSER_OUTFILE=${temporaryOut}`, `/DTREX_BROWSER_VERSION=${packageJson.version}`,
          join(installerRoot, 'browser-installer.nsi')]);
        assertPe(temporaryOut);
        if (existsSync(out) && (!lstatSync(out).isFile() || lstatSync(out).isSymbolicLink())) throw new Error('Standalone installer destination is not an ordinary file.');
        renameSync(temporaryOut, out);
      } finally { if (existsSync(temporaryOut)) rmSync(temporaryOut); }
      console.log(`Standalone Trex Browser installer built: ${out}`);
    }
    console.log(`Trex Browser ${debug ? 'debug' : 'release'} payload verified: Node ${NODE_VERSION}, Playwright ${packageJson.dependencies.playwright}, ffmpeg ${executables[0]}.`);
    return destination;
  } finally {
    try { removeBuildTree(work); }
    catch (error) {
      // A verified, atomically published payload is independent of its ignored
      // extraction/previous tree. Windows can retain a directory temporarily;
      // report that cleanup failure without invalidating the verified payload.
      if (!promoted || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      console.warn('Verified Browser payload published; an ignored temporary build tree was retained because cleanup was denied.');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBrowser().catch(error => { console.error(error.message); process.exitCode = 1; });
}
