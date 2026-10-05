import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/paste.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { normalizePasteShortcut, pasteShortcutError, shortcutFromEvent, matchesPasteShortcut, clipboardPasteAction } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const key = (overrides = {}) => ({ key: "v", code: "KeyV", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...overrides });

test("las instalaciones anteriores y los atajos inválidos conservan Ctrl+V como predeterminado", () => {
  for (const value of [undefined, null, "", "V", "Shift+V", "Ctrl+K", "Ctrl+Ctrl+V", "Ctrl+Unknown"]) assert.equal(normalizePasteShortcut(value), "Ctrl+V");
  assert.equal(normalizePasteShortcut("shift+ctrl+v"), "Ctrl+Shift+V");
  assert.equal(normalizePasteShortcut(" alt + ctrl + v "), "Ctrl+Alt+V");
  assert.equal(normalizePasteShortcut("Shift+Insert"), "Shift+Insert");
});

test("un atajo personalizado se reconoce con todos sus modificadores exactos", () => {
  assert.equal(matchesPasteShortcut(key(), "Ctrl+V"), true);
  assert.equal(matchesPasteShortcut(key({ altKey: true }), "Ctrl+V"), false);
  assert.equal(matchesPasteShortcut(key({ shiftKey: true }), "Ctrl+V"), false);
  assert.equal(matchesPasteShortcut(key({ altKey: true }), "Ctrl+Alt+V"), true);
  assert.equal(matchesPasteShortcut(key({ key: "Insert", code: "Insert", ctrlKey: false, shiftKey: true }), "Shift+Insert"), true);
  assert.equal(matchesPasteShortcut(key({ isComposing: true }), "Ctrl+V"), false);
});

test("grabar un atajo no convierte escritura normal o teclas modificadoras en pegado", () => {
  assert.equal(shortcutFromEvent(key({ ctrlKey: false })), null);
  assert.equal(shortcutFromEvent(key({ ctrlKey: false, shiftKey: true })), null);
  assert.equal(shortcutFromEvent(key({ key: "Control", code: "ControlLeft" })), null);
  assert.equal(shortcutFromEvent(key({ key: "V", shiftKey: true })), "Ctrl+Shift+V");
  assert.equal(shortcutFromEvent(key({ key: "F8", code: "F8", ctrlKey: false, altKey: true })), "Alt+F8");
});

test("las combinaciones que activarían controles de trex se rechazan", () => {
  for (const shortcut of ["Ctrl+K", "Ctrl+Alt+B", "Ctrl+T", "Ctrl+Shift+T", "Ctrl+W", "Ctrl+C", "Ctrl+D", "Ctrl+Shift+E", "Ctrl+Shift+L", "Ctrl+1", "Ctrl+F", "Ctrl+Alt+F", "Alt+F4"]) assert.ok(pasteShortcutError(shortcut), shortcut);
  for (const shortcut of ["Ctrl+V", "Ctrl+Alt+V", "Alt+V", "Ctrl+Shift+V", "Shift+Insert"]) assert.equal(pasteShortcutError(shortcut), null, shortcut);
});

test("el texto Unicode y multilínea no se interpreta como teclas ni pierde caracteres", () => {
  const content = { kind: "text", text: "á漢字🚀\nsegunda línea\r\n/path/with spaces.png" };
  for (const kind of ["claude", "codex", "shell"]) for (const windows of [true, false]) assert.deepEqual(clipboardPasteAction(content, kind, windows), content);
  assert.deepEqual(clipboardPasteAction({ kind: "text", text: "" }, "claude", true), { kind: "text", text: "" });
});

test("las capturas se adjuntan en ambos asistentes con su atajo de Windows o Linux", () => {
  assert.deepEqual(clipboardPasteAction({ kind: "image" }, "claude", true), { kind: "key", data: "\x1bv" });
  assert.deepEqual(clipboardPasteAction({ kind: "image" }, "claude", false), { kind: "key", data: "\x16" });
  for (const windows of [true, false]) assert.deepEqual(clipboardPasteAction({ kind: "image" }, "codex", windows), { kind: "key", data: "\x16" });
});

test("una imagen en un shell no inyecta Ctrl+V ni Alt+V como órdenes", () => {
  for (const windows of [true, false]) assert.deepEqual(clipboardPasteAction({ kind: "image" }, "shell", windows), { kind: "unsupported" });
});
