import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/agentActivity.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { screenActivity, activitySignal } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("Claude sigue ocupado durante la espera del modelo, sin depender de nuevos bytes", () => {
  const footer = ["✻ Coalescing… (15s · ↓ 120 tokens · thinking)", "❯ ", "⏵⏵ auto mode on"];
  assert.equal(screenActivity("claude", footer), "working");
  assert.equal(screenActivity("claude", footer), "working");
  assert.equal(screenActivity("claude", ["✻ Crunched for 1m 30s", "❯ ", "⏵⏵ auto mode on"]), "idle");
});

test("Codex reconoce el indicador de trabajo y la tecla de interrupción", () => {
  assert.equal(screenActivity("codex", ["• Working (14s • esc to interrupt)", "› Explain this code", "100% context left"]), "working");
  assert.equal(screenActivity("codex", ["• Thinking", "› "]), "working");
  assert.equal(screenActivity("codex", ["─ Worked for 14s ─", "• Done", "› "]), "idle");
});

test("las confirmaciones detienen la animación y la siguiente tarea puede reactivarla", () => {
  assert.equal(screenActivity("claude", ["✻ Running…", "Do you want to proceed?", "1. Yes", "2. No"]), "waiting");
  assert.equal(screenActivity("codex", ["Would you like to run the following command?", "1. Yes, proceed", "2. No"]), "waiting");
  assert.equal(screenActivity("codex", ["Would you like to apply the following edits?", "• Working (1s • esc to interrupt)", "› "]), "working");
  assert.equal(screenActivity("codex", ["Waiting for your response."]), "waiting");
});

test("el historial, los títulos, la escritura y los shells no activan el icono", () => {
  assert.equal(screenActivity("claude", ["✻ Thinking…", ...Array(18).fill("History"), "❯ "]), "idle");
  assert.equal(screenActivity("codex", ["› Do you want to proceed?", "Working directory: /project", "Copied 100 bytes"]), "idle");
  assert.equal(screenActivity("claude", ["Claude Code", "❯ esc to interrupt"]), "idle");
  assert.equal(screenActivity("shell", ["• Working (5s • esc to interrupt)"]), "idle");
});

test("el progreso OSC mantiene el estado hasta terminar o pausarse", () => {
  assert.equal(activitySignal(9, "4;1;25"), "working");
  assert.equal(activitySignal(9, "4;3"), "working");
  assert.equal(activitySignal(9, "4;4;25"), "waiting");
  assert.equal(activitySignal(9, "4;2;25"), "waiting");
  assert.equal(activitySignal(9, "4;0"), "idle");
  assert.equal(activitySignal(9, "4;99"), undefined);
});

test("las notificaciones de finalización y el regreso al prompt limpian el estado", () => {
  assert.equal(activitySignal(9, "Codex finished your task"), "idle");
  assert.equal(activitySignal(777, "notify;Claude Code;Waiting for approval"), "waiting");
  assert.equal(activitySignal(777, "notify;Claude Code;Task complete"), "idle");
  for (const marker of ["A", "B", "D;0"]) assert.equal(activitySignal(133, marker), "idle");
  assert.equal(activitySignal(133, "C"), undefined);
  assert.equal(activitySignal(777, "unrelated"), undefined);
});
