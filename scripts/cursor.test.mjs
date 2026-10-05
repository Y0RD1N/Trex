import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/cursor.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { normalizeCursorStyle, normalizeCursorWidth, cursorOptions, installCursorPolicy, applyCursorOptions } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));

test("las instalaciones anteriores mantienen el cursor automático y los valores inválidos se recuperan", () => {
  for (const value of [undefined, null, "", "beam", 2]) assert.equal(normalizeCursorStyle(value), "auto");
  for (const value of ["block", "bar", "underline", "auto"]) assert.equal(normalizeCursorStyle(value), value);
  for (const value of [undefined, null, "4", NaN, Infinity]) assert.equal(normalizeCursorWidth(value), 1);
  assert.equal(normalizeCursorWidth(-2), 1);
  assert.equal(normalizeCursorWidth(100), 6);
  assert.equal(normalizeCursorWidth(2.6), 3);
});

test("una barra fina o gruesa mantiene la forma y el parpadeo elegidos", () => {
  for (const width of [1, 2, 4, 6]) assert.deepEqual(cursorOptions({ cursorStyle: "bar", cursorWidth: width, cursorBlink: false }), { cursorStyle: "bar", cursorWidth: width, cursorBlink: false });
  assert.equal(cursorOptions({ cursorStyle: "auto", cursorWidth: 1, cursorBlink: true }).cursorStyle, "block");
});

test("el modo automático deja pasar los estilos y el parpadeo del programa", async t => {
  const term = new Terminal({ allowProposedApi: true });
  t.after(() => term.dispose());
  const requests = [];
  term.parser.registerCsiHandler({ intermediates: " ", final: "q" }, params => { requests.push(params[0]); return false; });
  const settings = { cursorStyle: "auto", cursorWidth: 1, cursorBlink: true };
  installCursorPolicy(term, () => settings);
  applyCursorOptions(term, settings);
  await write(term, "\x1b[6 q\x1b[?12l");
  assert.deepEqual(requests, [6]);
  assert.equal(term.options.cursorBlink, false);
});

test("Claude o Codex no sustituyen un estilo personalizado y cambiarlo no borra la terminal", async t => {
  const term = new Terminal({ allowProposedApi: true });
  t.after(() => term.dispose());
  const requests = [];
  term.parser.registerCsiHandler({ intermediates: " ", final: "q" }, params => { requests.push(params[0]); return false; });
  let settings = { cursorStyle: "auto", cursorWidth: 1, cursorBlink: true };
  installCursorPolicy(term, () => settings);
  await write(term, "historial\x1b[2 q");
  settings = { cursorStyle: "bar", cursorWidth: 4, cursorBlink: false };
  applyCursorOptions(term, settings);
  await write(term, "\x1b[1 q\x1b[2 q\x1b[3 q\x1b[4 q\x1b[5 q\x1b[6 q\x1b[?12h");
  assert.deepEqual(requests, [2, 0]);
  assert.equal(term.options.cursorStyle, "bar");
  assert.equal(term.options.cursorWidth, 4);
  assert.equal(term.options.cursorBlink, false);
  assert.equal(term.buffer.active.getLine(0).translateToString(true), "historial");
});

test("la política respeta mostrar y ocultar el cursor incluso junto a órdenes de parpadeo", async t => {
  const term = new Terminal({ allowProposedApi: true });
  t.after(() => term.dispose());
  const settings = { cursorStyle: "underline", cursorWidth: 1, cursorBlink: true };
  installCursorPolicy(term, () => settings);
  applyCursorOptions(term, settings);
  const replies = [];
  term.onData(data => replies.push(data));
  await write(term, "\x1b[?12;25l\x1b[?25$p");
  assert.equal(term.options.cursorBlink, true);
  assert.equal(replies.at(-1), "\x1b[?25;2$y");
  await write(term, "\x1b[?12;25h\x1b[?25$p");
  assert.equal(replies.at(-1), "\x1b[?25;1$y");
});
