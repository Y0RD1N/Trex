import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const debug = process.argv.includes('--debug') || process.env.TAURI_ENV_DEBUG === 'true';
const target = process.env.TAURI_ENV_TARGET_TRIPLE;
let explicitTarget = target;
if (target) {
  const rustc = spawnSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8', shell: false });
  if (rustc.error) throw rustc.error;
  if (rustc.status !== 0) throw new Error('Cannot determine the Rust host target.');
  // An explicit host target would duplicate every dependency artifact. The
  // native layout is also the checkout-local path used by the debug resolver.
  const host = /^host: (.+)$/m.exec(rustc.stdout)?.[1]?.trim();
  if (target === host) explicitTarget = undefined;
}
const args = ['build', '--locked', '--manifest-path', join(root, 'trex-cli', 'Cargo.toml'),
  '--target-dir', join(root, 'trex-cli', 'target')];
if (!debug) args.push('--release');
if (explicitTarget) args.push('--target', explicitTarget);
const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const windows = target ? target.includes('windows') : process.platform === 'win32';
const binary = join(root, 'trex-cli', 'target', ...(explicitTarget ? [explicitTarget] : []),
  debug ? 'debug' : 'release', windows ? 'trex-agent.exe' : 'trex-agent');
if (debug && explicitTarget) {
  // Keep the single documented development fallback aligned for cross-target
  // debug builds too; production never consults this checkout-local location.
  const developmentBinary = join(root, 'trex-cli', 'target', 'debug', windows ? 'trex-agent.exe' : 'trex-agent');
  mkdirSync(dirname(developmentBinary), { recursive: true });
  copyFileSync(binary, `${developmentBinary}.tmp`);
  renameSync(`${developmentBinary}.tmp`, developmentBinary);
}
// The resource map renames this source to trex-agent.payload in the installer.
// Keeping the .exe source extension lets Tauri's configured signing sign it.
// Only the NSIS opt-in hook promotes the installed payload to a usable CLI.
const payload = join(root, 'src-tauri', 'installer', 'payload', windows ? 'trex-agent.exe' : 'trex-agent');
mkdirSync(dirname(payload), { recursive: true });
copyFileSync(binary, `${payload}.tmp`);
if (!windows) chmodSync(`${payload}.tmp`, 0o755);
renameSync(`${payload}.tmp`, payload);
console.log(`Trex CLI ${debug ? 'debug' : 'release'} payload refreshed.`);
