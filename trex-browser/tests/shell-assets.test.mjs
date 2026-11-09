// What the packaged shell must carry: every module main.mjs imports, and the fonts with their license.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fonts = new URL('../shell/ui/fonts/', import.meta.url);

test('every module the shell imports is copied into the packaged app', () => {
  const imported = [...read('../shell/main.mjs').matchAll(/from '\.\/([\w-]+\.mjs)'/g)].map(match => match[1]);
  const packaging = read('../../scripts/browser-build-common.mjs');
  const listed = /for \(const name of \[([^\]]+)\]\) _copy\(_join\(source, name\)/.exec(packaging)?.[1].match(/'[^']+'/g)?.map(name => name.slice(1, -1));
  assert.ok(listed?.length, 'the list of shell files is found in browser-build-common.mjs');
  assert.ok(imported.length >= 5, 'main.mjs imports its helper modules');
  for (const name of imported) assert.ok(listed.includes(name), `${name} is imported by main.mjs but not packaged`);
  for (const name of listed) assert.ok(fs.existsSync(new URL(`../shell/${name}`, import.meta.url)), `${name} is packaged but missing`);
});

test('the bundled fonts are declared, exist and ship with their license', () => {
  const css = read('../shell/ui/fonts/fonts.css');
  const declared = [...css.matchAll(/url\(\.\/([^)]+\.woff2)\)/g)].map(match => match[1]);
  const present = fs.readdirSync(fonts).filter(name => name.endsWith('.woff2'));
  assert.deepEqual([...declared].sort(), [...present].sort(), 'no font file is unused or missing');
  const license = read('../shell/ui/fonts/LICENSE.txt');
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(license, /IBM Plex Sans: Copyright 2019 IBM Corp/);
  assert.match(license, /IBM Plex Mono: Copyright 2017 IBM Corp/);
  assert.match(read('../../THIRD-PARTY-NOTICES.md'), /IBM Plex Sans y IBM Plex Mono/);
});
