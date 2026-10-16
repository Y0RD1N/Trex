import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { baseReducer, initialChatState } = await load("chatState");
const { messageAttachments, withoutConversationArgs } = await load("chatMessages");
const { summarizeWork, completedWork, changeTree, filesFromDiff } = await load("workSummary");
const { codexReducer, splitProfileArgs } = await load("codexChat");
const { userMessageLine } = await load("claudeChat");
const user = (id, text = "mensaje", previews = []) => ({ kind: "user", id, text, images: previews.length, previews });
const edit = (id, path, old = "a", value = "b", extra = {}) => ({ kind: "tool", id, name: "Edit", input: { file_path: path, old_string: old, new_string: value }, status: "done", patch: null, output: null, ...extra });
const turn = id => ({ kind: "turn", id, durationMs: 1000 });

test("editar conserva el prefijo, descarta las respuestas posteriores y conserva las elecciones", () => {
  let state = { ...initialChatState(), process: "ready", sessionId: "old", modelChoice: "modelo", modeChoice: "full", fastChoice: true,
    items: [user("a"), edit("t1", "/app/uno.ts"), turn("done1"), user("b"), edit("t2", "/app/dos.ts"), turn("done2"), user("c")],
    historyCount: 7, usage: { used: 100, window: 200 }, turnDiff: "old diff" };
  const unknown = baseReducer(state, { type: "rewind", id: "missing", sessionId: "new" });
  assert.equal(unknown, state);
  state = baseReducer(state, { type: "rewind", id: "b", sessionId: "new" });
  assert.deepEqual(state.items.map(item => item.id), ["a", "t1", "done1"]);
  assert.equal(state.sessionId, "new");
  assert.equal(state.historyCount, 3);
  assert.equal(state.usage, null);
  assert.equal(state.turnDiff, null);
  assert.deepEqual([state.modelChoice, state.modeChoice, state.fastChoice], ["modelo", "full", true]);
  state = baseReducer(state, { type: "send", id: "edited", text: "corregido", now: 2000 });
  assert.equal(state.items.at(-1).text, "corregido");
  assert.equal(state.pendingTurns, 1);
  const first = baseReducer(state, { type: "rewind", id: "a", sessionId: "fresh" });
  assert.deepEqual(first.items, []);
});

test("reenviar conserva exactamente las imágenes y rechaza un historial incompleto", () => {
  const preview = "data:image/png;base64,AAAA";
  const images = messageAttachments(user("u1", "á\n漢字", [preview]));
  assert.deepEqual(images.map(({ mediaType, data, preview }) => ({ mediaType, data, preview })), [{ mediaType: "image/png", data: "AAAA", preview }]);
  assert.throws(() => messageAttachments({ ...user("u1"), images: 1 }), /no están disponibles/);
  assert.throws(() => messageAttachments(user("u1", "", ["https://example.com/image.png"])), /recuperar/);
  const wire = JSON.parse(userMessageLine("corregido", images, "11111111-1111-4111-8111-111111111111"));
  assert.equal(wire.uuid, "11111111-1111-4111-8111-111111111111");
  assert.equal(wire.message.content.find(part => part.type === "image").source.data, "AAAA");
});

test("la regeneración reemplaza la selección de conversación sin perder modelo o rutas", () => {
  const args = withoutConversationArgs('--resume=old --fork-session --resume-session-at x --session-id abc --continue --model opus --settings "C:\\Mi cuenta\\config.json" --effort high');
  assert.deepEqual(splitProfileArgs(args), ["--model", "opus", "--settings", "C:\\Mi cuenta\\config.json", "--effort", "high"]);
  assert.equal(withoutConversationArgs("--resume old"), null);
  assert.throws(() => withoutConversationArgs('--model "abierto'), /interpretar/);
});

test("los resúmenes son independientes, ignoran permisos, lecturas y ediciones fallidas", () => {
  const items = [user("u1"), edit("one", "C:\\app\\src\\Uno.ts", "a\nb", "c\nd\ne"),
    edit("two", "C:\\app\\src\\uno.ts", "x", "y"), edit("failed", "C:\\app\\bad.ts", "a", "b", { status: "error" }),
    edit("reading", "C:\\app\\other.ts", "a", "b", { name: "Read" }), turn("done1"), user("u2"), edit("next", "C:\\app\\README.md"), turn("done2")];
  const summaries = completedWork(items, "C:\\app");
  assert.equal(summaries.get("done1").files.length, 1);
  assert.deepEqual([summaries.get("done1").added, summaries.get("done1").removed], [4, 3]);
  assert.deepEqual(summaries.get("done2").files.map(file => file.path), ["README.md"]);
  const isolated = completedWork([edit("history", "/app/old.ts"), user("live"), edit("current", "/app/new.ts"), turn("done")], "/app", 1);
  assert.deepEqual(isolated.get("done").files.map(file => file.path), ["new.ts"]);
});

test("el diff neto de Codex sustituye las ediciones intermedias y se reinicia para el siguiente turno", () => {
  const diff = "diff --git a/src/one.ts b/src/one.ts\n--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const summary = summarizeWork([edit("one", "/app/src/one.ts", "a\nb\nc", "d\ne\nf")], "/app", diff);
  assert.deepEqual([summary.added, summary.removed], [1, 1]);
  assert.equal(summarizeWork([edit("one", "/app/src/one.ts")], "/app", "").files.length, 0, "un diff neto vacío no anuncia ediciones que se deshicieron");
  let state = baseReducer(initialChatState(), { type: "send", id: "u1", text: "edita", now: 0 });
  state = baseReducer(state, { type: "bindTurn", id: "u1", turnId: "provider-turn" });
  assert.equal(state.items[0].providerTurnId, "provider-turn");
  state = codexReducer(state, { type: "rpc", scope: "p", now: 1000, message: { method: "turn/diff/updated", params: { diff } } });
  state = codexReducer(state, { type: "rpc", scope: "p", now: 1000, message: { method: "turn/completed", params: { turn: { id: "provider-turn", status: "completed", durationMs: 1000 } } } });
  assert.equal(state.items.at(-1).diff, diff);
  assert.equal(state.turnDiff, null);
});

test("el historial de Claude recupera los resúmenes y las estadísticas completas no dependen de la vista previa", async () => {
  const { chatReducer } = await load("claudeChat");
  const state = chatReducer(initialChatState(), { type: "history", entries: [
    { type: "user", uuid: "u1", timestamp: "2026-10-14T12:00:00Z", message: { content: "edita" } },
    { type: "assistant", uuid: "a1", timestamp: "2026-10-14T12:00:05Z", message: { id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: "Listo." }] } },
  ] });
  assert.equal(state.items.at(-1).kind, "turn");
  assert.equal(state.items.at(-1).durationMs, 5000);
  const summary = summarizeWork([edit("full", "/app/big.ts", "a", "b", { changeStats: { added: 12000, removed: 50 } })], "/app");
  assert.deepEqual([summary.added, summary.removed], [12000, 50]);
});

test("las carpetas acumulan sus archivos y los nombres con espacios, renombrados y Unicode se leen bien", () => {
  const diff = 'diff --git a/src/mi archivo.ts b/src/mi archivo.ts\n@@ -1 +1 @@\n-a\n+b\n'
    + 'diff --git "a/\\303\\241.md" "b/\\303\\241.md"\nnew file mode 100644\n@@ -0,0 +1 @@\n+hola\n'
    + 'diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\n';
  const files = filesFromDiff(diff, "/app");
  assert.deepEqual(files.map(file => file.path), ["src/mi archivo.ts", "á.md", "new.md"]);
  assert.equal(files[2].kind, "renamed");
  const tree = changeTree([...files, { ...files[0], path: "src/nested/two.ts" }]);
  assert.equal(tree[0].name, "src");
  assert.equal(tree[0].files, 2);
  assert.equal(tree[0].added, 2);
  assert.equal(tree[0].children[0].name, "nested");
});
