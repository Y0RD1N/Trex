import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/terminalResize.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { TerminalResizeCoordinator } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");
const settle = () => new Promise(resolve => setImmediate(resolve));
const write = (_t, term, data) => new Promise(resolve => term.write(data, resolve));

function fixture(t, notify) {
  const term = new Terminal({ cols: 120, rows: 36, allowProposedApi: true });
  const state = { size: { cols: 120, rows: 36 }, id: "claude", calls: [], refreshes: 0 };
  const coordinator = new TerminalResizeCoordinator({
    measure: () => state.size,
    currentSize: () => ({ cols: term.cols, rows: term.rows }),
    session: () => state.id,
    apply: ({ cols, rows }) => term.resize(cols, rows),
    notify: async (id, size) => {
      assert.deepEqual({ cols: term.cols, rows: term.rows }, size, "rejilla y PTY se ajustan juntos");
      state.calls.push({ id, ...size });
      await notify?.(id, size);
    },
    refresh: () => state.refreshes++,
  }, 150);
  coordinator.spawned(state.id, state.size);
  t.after(() => { coordinator.dispose(); term.dispose(); });
  return { term, state, coordinator, advance: async () => { await new Promise(resolve => setTimeout(resolve, 180)); await settle(); } };
}

test("el proceso arranca con las dimensiones reales sin un segundo aviso al PTY", t => {
  const { term, state, coordinator } = fixture(t);
  state.id = null;
  state.size = { cols: 96, rows: 28 };
  coordinator.request();
  assert.equal(term.cols, 96);
  assert.equal(term.rows, 28);
  state.id = "claude-new";
  coordinator.spawned(state.id, state.size);
  assert.deepEqual(state.calls, []);
});

test("un arrastre conserva la rejilla mientras Claude escribe y solo aplica la medida final", async t => {
  const { term, state, coordinator, advance } = fixture(t);
  await write(t, term, "\x1b[?1049h\x1b[H");
  state.size = { cols: 80, rows: 24 };
  coordinator.request();
  await write(t, term, "─".repeat(120) + "\r\n› mensaje sin enviar");
  assert.equal(term.cols, 120);
  assert.equal(term.buffer.active.getLine(1).translateToString(true), "› mensaje sin enviar");
  for (const cols of [90, 150, 104]) {
    state.size = { cols, rows: 30 };
    coordinator.request();
  }
  await advance();
  assert.deepEqual(state.calls, [{ id: "claude", cols: 104, rows: 30 }]);
  // Claude fullscreen redibuja su propio frame, sin inyectar borrados desde TREX.
  await write(t, term, "\x1b[H\x1b[2J" + "─".repeat(104) + "\r\n› mensaje sin enviar\r\n" + "─".repeat(104));
  const lines = Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(row).translateToString(true));
  assert.equal(lines.filter(line => line === "─".repeat(104)).length, 2);
  assert.equal(lines.filter(line => line.includes("mensaje sin enviar")).length, 1);
  assert.equal(term.buffer.active.type, "alternate");
});

test("ocultar y mostrar una pestaña conserva el buffer y no genera tamaños cero ni avisos redundantes", async t => {
  const { term, state, coordinator, advance } = fixture(t);
  await write(t, term, "contenido de Claude");
  state.size = { cols: 80, rows: 24 };
  coordinator.request();
  state.size = undefined;
  await advance();
  assert.equal(term.cols, 120);
  assert.deepEqual(state.calls, []);
  state.size = { cols: 120, rows: 36 };
  for (let i = 0; i < 10; i++) coordinator.request();
  await advance();
  assert.deepEqual(state.calls, []);
  assert.equal(term.buffer.active.getLine(0).translateToString(true), "contenido de Claude");
});

test("las respuestas IPC pendientes se serializan y la siguiente usa la medida más reciente", async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { term, state, coordinator, advance } = fixture(t, () => state.calls.length === 1 ? blocked : undefined);
  state.size = { cols: 80, rows: 24 };
  coordinator.request();
  await advance();
  state.size = { cols: 160, rows: 40 };
  coordinator.request();
  await advance();
  assert.equal(term.cols, 80);
  assert.equal(state.calls.length, 1);
  state.size = { cols: 100, rows: 32 };
  release();
  await settle();
  assert.deepEqual(state.calls, [{ id: "claude", cols: 80, rows: 24 }, { id: "claude", cols: 100, rows: 32 }]);
});

test("un ajuste fallido puede reintentarse aunque la rejilla ya tenga esa medida", async t => {
  let fail = true;
  const { state, coordinator, advance } = fixture(t, () => { if (fail) throw new Error("IPC failed"); });
  state.size = { cols: 80, rows: 24 };
  coordinator.request();
  await advance();
  fail = false;
  coordinator.request();
  await advance();
  assert.equal(state.calls.length, 2);
  coordinator.request();
  await advance();
  assert.equal(state.calls.length, 2);
});

test("cerrar o reiniciar una sesión no aplica respuestas antiguas a su sustituta", async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { state, coordinator, advance } = fixture(t, () => blocked);
  state.size = { cols: 80, rows: 24 };
  coordinator.request();
  await advance();
  state.id = "claude-r1";
  coordinator.spawned(state.id, state.size);
  const refreshes = state.refreshes;
  release();
  await settle();
  assert.equal(state.refreshes, refreshes);
  coordinator.request();
  await advance();
  assert.equal(state.calls.length, 1);
  state.size = { cols: 100, rows: 32 };
  coordinator.request();
  coordinator.dispose();
  await advance();
  assert.equal(state.calls.length, 1);
});
