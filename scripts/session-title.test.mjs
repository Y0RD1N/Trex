import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/sessionTitle.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { sessionTitle, sessionLabel } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const codex = { kind: "codex", subtitle: "codex 1", oscTitle: null };

test("Codex conserva cada fotograma original y el título no duplica el indicador", () => {
  for (const frame of "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏") {
    const tab = { ...codex, oscTitle: `${frame} Actualiza el proyecto · 日本語 🚀` };
    assert.deepEqual(sessionTitle(tab), { label: "Actualiza el proyecto · 日本語 🚀", nativeIndicator: frame });
    assert.equal(sessionLabel(tab), "Actualiza el proyecto · 日本語 🚀");
  }
});

test("el aviso nativo, los títulos sin icono y el título vacío cambian sin dejar indicadores antiguos", () => {
  assert.deepEqual(sessionTitle({ ...codex, oscTitle: " ●   Proyecto listo " }), { label: "Proyecto listo", nativeIndicator: "●" });
  assert.deepEqual(sessionTitle({ ...codex, oscTitle: "Proyecto listo" }), { label: "Proyecto listo", nativeIndicator: null });
  assert.deepEqual(sessionTitle({ ...codex, oscTitle: "  " }), { label: "codex 1", nativeIndicator: null });
  assert.deepEqual(sessionTitle(codex), { label: "codex 1", nativeIndicator: null });
  assert.deepEqual(sessionTitle({ ...codex, oscTitle: "⠋" }), { label: "codex 1", nativeIndicator: "⠋" });
});

test("renombrar una sesión conserva su nombre y el único indicador original de Codex", () => {
  const tab = { ...codex, subtitle: "Mi tarea", oscTitle: "⠙ Actualiza el proyecto" };
  assert.deepEqual(sessionTitle(tab), { label: "Mi tarea", nativeIndicator: "⠙" });
  assert.equal(sessionLabel(tab), "Mi tarea");
});

test("los títulos de otros programas y los símbolos dentro del nombre se conservan", () => {
  for (const kind of ["claude", "shell"]) {
    assert.deepEqual(sessionTitle({ kind, subtitle: kind, oscTitle: "⠙ Mi proyecto" }), { label: "⠙ Mi proyecto", nativeIndicator: null });
  }
  for (const title of ["Aprender ⠋ braille", "⠋Proyecto", "⠿ Texto braille", "[ ! ] Action Required | project"]) {
    assert.deepEqual(sessionTitle({ ...codex, oscTitle: title }), { label: title, nativeIndicator: null });
  }
});
