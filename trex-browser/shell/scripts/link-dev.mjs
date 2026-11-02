// Development only: let the downloaded Electron binary run this shell as its
// bundled app (resources/app), exactly like a packaged build. Playwright can
// then launch the binary itself, with no positional app argument.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const shell = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(shell, 'node_modules', 'electron', 'dist');
const resources = process.platform === 'darwin' ? path.join(dist, 'Electron.app', 'Contents', 'Resources') : path.join(dist, 'resources');
if (!fs.existsSync(resources)) { console.log('Electron binary not downloaded yet; run `npx electron --version` first.'); process.exit(0); }
// The native guard refuses group/other-writable executables (as it should);
// Electron's zip is extracted with permissive modes, so tighten them.
if (process.platform !== 'win32') {
  const tighten = p => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) return; fs.chmodSync(p, st.mode & ~0o022); if (st.isDirectory()) for (const n of fs.readdirSync(p)) tighten(path.join(p, n)); };
  tighten(dist);
}
const link = path.join(resources, 'app');
fs.rmSync(link, { force: true, recursive: false });
fs.symlinkSync(path.relative(resources, shell), link, process.platform === 'win32' ? 'junction' : 'dir');
console.log(`Linked ${link} -> ${shell}`);
