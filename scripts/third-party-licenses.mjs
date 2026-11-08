#!/usr/bin/env node
// Regenerates docs/third-party-licenses.md: the licenses of every Rust crate and
// npm package that ends up in a trex build.
//
//   node scripts/third-party-licenses.mjs
//
// Sources: the three Cargo.lock files and the production closure of the npm
// lockfiles (the lockfiles already carry each npm package's license). Rust
// licenses come from the public deps.dev API, so this needs network access.
// Run it before every release and commit the result.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs', 'third-party-licenses.md');
const read = file => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');

// ---- Rust -------------------------------------------------------------------
const CARGO_LOCKS = ['src-tauri/Cargo.lock', 'trex-cli/Cargo.lock', 'trex-browser/Cargo.lock'];
const crates = new Map();
for (const file of CARGO_LOCKS) {
  for (const block of read(file).split('\n[[package]]\n').slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const source = /^source = "([^"]+)"/m.exec(block)?.[1];
    // Path/vendored crates (trex's own, trex-cli/vendor/*) have no registry source.
    if (name && version && source?.startsWith('registry+')) crates.set(`${name}@${version}`, { name, version });
  }
}

async function crateLicense({ name, version }, attempt = 0) {
  const url = `https://api.deps.dev/v3/systems/cargo/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()).licenses ?? []).join(' AND ') || null;
  } catch (error) {
    if (attempt >= 3) throw new Error(`Cannot read the license of ${name}@${version}: ${error.message}`);
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    return crateLicense({ name, version }, attempt + 1);
  }
}

const pending = [...crates.values()];
await Promise.all(Array.from({ length: 16 }, async () => {
  for (let entry; (entry = pending.pop());) entry.license = await crateLicense(entry);
}));

// ---- npm --------------------------------------------------------------------
function npmProduction(lockFile) {
  const lock = JSON.parse(read(lockFile));
  const found = new Map();
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (!path || info.dev || info.devOptional) continue;
    const name = info.name ?? path.replace(/^.*node_modules\//, '');
    found.set(`${name}@${info.version}`, { name, version: info.version, license: typeof info.license === 'string' ? info.license : null });
  }
  return [...found.values()];
}
const NPM_SETS = [
  ['Interfaz (React, xterm.js y fuentes)', 'package-lock.json'],
  ['Trex Browser: worker', 'trex-browser/package-lock.json'],
];

// ---- Rendering --------------------------------------------------------------
const COPYLEFT = /\b(A?GPL|LGPL|MPL|EPL|CDDL|OSL)/;
// An SPDX expression needs attention when no OR-alternative is free of copyleft.
const attention = license => !license || (COPYLEFT.test(license) && license.split(' OR ').every(part => COPYLEFT.test(part)));

function group(items) {
  const byLicense = new Map();
  for (const item of items) {
    const key = item.license ?? 'Desconocida';
    byLicense.set(key, (byLicense.get(key) ?? new Set()).add(item.name));
  }
  return [...byLicense].map(([license, names]) => ({ license, names: [...names].sort() }))
    .sort((a, b) => b.names.length - a.names.length || a.license.localeCompare(b.license));
}
const table = items => [
  '| Licencia | Paquetes | Lista |', '|---|---:|---|',
  ...group(items).map(({ license, names }) => `| \`${license}\` | ${names.length} | ${names.map(n => `\`${n}\``).join(', ')} |`),
].join('\n');

const rustItems = [...crates.values()];
const flagged = [...rustItems, ...NPM_SETS.flatMap(([, file]) => npmProduction(file))].filter(item => attention(item.license));
const flaggedNames = [...new Set(flagged.map(item => `${item.name} (${item.license ?? 'desconocida'})`))].sort();

const doc = `# Licencias de dependencias

> Archivo generado con \`node scripts/third-party-licenses.mjs\`. No lo edites a mano:
> vuelve a generarlo antes de cada release. Los componentes que se redistribuyen
> aparte (Node, Electron, Playwright, ffmpeg…) están en
> [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

Una dependencia con varias licencias («\`A OR B\`») se puede usar con cualquiera de ellas.
Los Cargo.lock incluyen los paquetes de todas las plataformas, así que esta lista es
un máximo: cada instalador lleva solo una parte.

## Requieren atención

${flaggedNames.length ? flaggedNames.map(entry => `- ${entry}`).join('\n') : 'Ninguna.'}

## Rust (${new Set(rustItems.map(c => c.name)).size} crates de crates.io)

${table(rustItems)}

${NPM_SETS.map(([title, file]) => {
  const items = npmProduction(file);
  return `## npm — ${title} (${new Set(items.map(i => i.name)).size} paquetes)\n\n${table(items)}`;
}).join('\n\n')}
`;

writeFileSync(output, doc);
console.log(`Wrote ${output} (${rustItems.length} crate versions, ${flaggedNames.length} need attention)`);
