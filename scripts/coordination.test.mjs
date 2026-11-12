import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const {
  editPaths, newEdits, withNotes, withoutNotes, notesFor, peersOf, isCoordinationTool, COORDINATION_TOOLS, PEER_INSTRUCTIONS,
  CoordinationHub, SYNC_MS, PEER_WAKE, WAKE_LIMIT, notesBlock, peerTurnNotes, peerNoteParts, peerNotice,
} = await load("coordination");
const { claudeInboxReply } = await load("inboxProtocol");
const { INBOX_SERVER } = await load("messageQueue");
const { initialChatState } = await load("chatState");
const { userInput, codexReducer } = await load("codexChat");
const { userMessageLine, chatReducer } = await load("claudeChat");
const { antigravityReducer } = await load("antigravityChat");
const { trexReducer } = await load("trexChat");

const tool = (id, name, input, status = "done") => ({ kind: "tool", id, name, input, status, output: null, patch: null });
const note = (id, to, at, kind = "conflict") => ({ id, to, from: "other", fromLabel: "Codex · API", kind, path: "src/a.ts", text: `aviso ${id}`, at });

test("only edit tools count as edits, and a move changes both paths", () => {
  assert.deepEqual(editPaths("Edit", { file_path: "src/a.ts" }), ["src/a.ts"]);
  assert.deepEqual(editPaths("NotebookEdit", { notebook_path: "notes.ipynb" }), ["notes.ipynb"]);
  assert.deepEqual(editPaths("Move", { path: "old.ts", destination: "new.ts" }), ["old.ts", "new.ts"]);
  assert.deepEqual(editPaths("Read", { file_path: "src/a.ts" }), []);
  assert.deepEqual(editPaths("Bash", { command: "rm -rf src" }), []);
  assert.deepEqual(editPaths("Write", { file_path: "   " }), []);
  // Trex CLI keeps its native names for these edits.
  assert.deepEqual(editPaths("edit_file", { path: "src/a.ts", oldText: "a", newText: "b" }), ["src/a.ts"]);
  assert.deepEqual(editPaths("rename_file", { path: "old.ts", destination: "new.ts" }), ["old.ts", "new.ts"]);
  assert.deepEqual(editPaths("remove_file", { path: "gone.ts" }), ["gone.ts"]);
  assert.deepEqual(editPaths("read_file", { path: "src/a.ts" }), []);
  assert.deepEqual(editPaths("TrexPatch", { patch: "{}", files: [{ file_path: "src/a.ts" }, null, { file_path: "src/b.ts" }] }), ["src/a.ts", "src/b.ts"]);
});

test("new edits are recorded once, after the tool finishes and only when it succeeded", () => {
  const seen = new Set();
  const running = tool("t1", "Edit", { file_path: "src/a.ts" }, "running");
  assert.deepEqual(newEdits([running], seen), [], "an edit in progress waits for its result");
  assert.equal(seen.has("t1"), false);
  const items = [{ ...running, status: "done" }, tool("t2", "Write", { file_path: "src/a.ts" }), tool("t3", "Edit", { file_path: "src/b.ts" }, "error"),
    tool("t4", "Read", { file_path: "src/c.ts" }), { kind: "user", id: "u1", text: "hola" }];
  assert.deepEqual(newEdits(items, seen), ["src/a.ts"], "duplicates collapse and failed edits do not count");
  assert.deepEqual(newEdits(items, seen), [], "the same tools are never recorded twice");
});

test("notes travel ahead of the user's message and can be stripped from history", () => {
  const notes = [note("n1", "me", 1), note("n2", "me", 2, "message")];
  const text = withNotes(notes, "Arregla el login");
  assert.match(text, /^\[Trex · otras sesiones de este proyecto\]\n- aviso n1\n- aviso n2\n\[\/Trex\]\n\nArregla el login$/);
  assert.equal(withoutNotes(text), "Arregla el login");
  assert.equal(withNotes([], "Arregla el login"), "Arregla el login");
  assert.equal(withoutNotes("[Trex · otras sesiones de este proyecto] sin cierre"), "[Trex · otras sesiones de este proyecto] sin cierre");
  assert.equal(withoutNotes("texto normal [/Trex]"), "texto normal [/Trex]");
});

test("a session sees its own notes, oldest first, and every peer but itself", () => {
  const board = { sessions: [{ id: "me" }, { id: "a" }, { id: "b" }], claims: [], notes: [note("n2", "me", 20), note("x", "a", 5), note("n1", "me", 10)] };
  assert.deepEqual(notesFor(board, "me").map(item => item.id), ["n1", "n2"]);
  assert.deepEqual(peersOf(board, "me").map(peer => peer.id), ["a", "b"]);
  assert.deepEqual(notesFor(null, "me"), []);
  assert.deepEqual(peersOf(null, "me"), []);
});

test("coordination tools are recognized and the instructions stay a single CLI-safe line", () => {
  for (const name of COORDINATION_TOOLS) assert.equal(isCoordinationTool(name), true);
  assert.equal(isCoordinationTool("trex_read_messages"), false);
  assert.equal(isCoordinationTool(undefined), false);
  assert.doesNotMatch(PEER_INSTRUCTIONS, /["\n\r\\]/);
  for (const name of COORDINATION_TOOLS) assert.match(PEER_INSTRUCTIONS, new RegExp(name));
  assert.ok(Buffer.byteLength(PEER_INSTRUCTIONS) < 200, "Codex instructions have a byte budget");
});

function hub({ fail = false } = {}) {
  const syncs = [], leaves = [], timers = new Map();
  let next = 0, release = null;
  const sync = (project, sessions) => {
    syncs.push({ project, sessions: sessions.map(session => session.id) });
    if (fail) return Promise.reject(new Error("offline"));
    const board = { sessions, claims: [], notes: [] };
    return release ? new Promise(resolve => { const go = release; release = null; go(() => resolve(board)); }) : Promise.resolve(board);
  };
  const instance = new CoordinationHub(sync, async (project, session) => { leaves.push({ project, session }); },
    (run, ms) => { const id = ++next; timers.set(id, { run, ms }); return id; }, id => timers.delete(id));
  return { instance, syncs, leaves, timers, hold: fn => { release = fn; } };
}
const presence = (id, working = false) => () => ({ id, label: id, agent: "codex", task: null, working });
const settle = () => new Promise(resolve => setImmediate(resolve));

test("one heartbeat per project registers every live session and hands each the board", async () => {
  const h = hub();
  const boards = { a: [], b: [] };
  h.instance.join("D:/app", "a", { presence: presence("a"), listener: board => boards.a.push(board) });
  await settle();
  h.instance.join("D:/app", "b", { presence: presence("b", true), listener: board => boards.b.push(board) });
  await settle();
  assert.deepEqual(h.syncs.at(-1), { project: "D:/app", sessions: ["a", "b"] });
  assert.equal(boards.a.at(-1).sessions.length, 2, "the earlier session learns about the new one");
  assert.equal(boards.b.at(-1).sessions[1].working, true);
  assert.equal(h.timers.size, 1, "a single timer per project");
  assert.equal([...h.timers.values()][0].ms, SYNC_MS);
  const before = h.syncs.length;
  [...h.timers.values()][0].run();
  await settle();
  assert.equal(h.syncs.length, before + 1, "the timer beats again");
});

test("a refresh during a beat is coalesced into one more beat, not lost", async () => {
  const h = hub();
  let finish;
  h.hold(go => { finish = go; });
  h.instance.join("D:/app", "a", { presence: presence("a"), listener() {} });
  const first = h.instance.refresh("D:/app"), second = h.instance.refresh("D:/app");
  assert.equal(h.syncs.length, 1, "the heartbeat in flight is shared");
  finish();
  await Promise.all([first, second]);
  await settle();
  assert.equal(h.syncs.length, 2, "the edit made meanwhile is synced right after");
});

test("leaving removes the session from the registry and stops the timer with the last one", async () => {
  const h = hub();
  const leaveA = h.instance.join("D:/app", "a", { presence: presence("a"), listener() {} });
  const leaveB = h.instance.join("D:/app", "b", { presence: presence("b"), listener() {} });
  await settle();
  leaveA();
  leaveA();
  assert.deepEqual(h.leaves, [{ project: "D:/app", session: "a" }], "leaving twice is harmless");
  assert.equal(h.timers.size, 1);
  leaveB();
  await settle();
  assert.equal(h.timers.size, 0);
  const count = h.syncs.length;
  await h.instance.refresh("D:/app");
  assert.equal(h.syncs.length, count, "a project without sessions never beats");
});

test("sessions without presence are skipped and a failed beat retries on the timer", async () => {
  const h = hub({ fail: true });
  let heard = 0;
  h.instance.join("D:/app", "ghost", { presence: () => null, listener() { heard++; } });
  await settle();
  assert.equal(h.syncs.length, 0, "nobody to register, no native call");
  h.instance.join("D:/app", "a", { presence: presence("a"), listener() { heard++; } });
  await settle();
  assert.deepEqual(h.syncs.map(sync => sync.sessions), [["a"]]);
  assert.equal(heard, 0);
  assert.equal(h.timers.size, 1, "the failure does not stop the heartbeat");
});

const mcpRequest = (method, params = {}, id = 7) => ({ subtype: "mcp_message", server_name: INBOX_SERVER, message: { jsonrpc: "2.0", id, method, params } });
const mcpResult = reply => JSON.parse(reply.line).response.response.mcp_response.result;
const empty = async () => { throw new Error("coordination must not read the inbox"); };

test("Claude's in-process server lists and dispatches the coordination tools", async () => {
  const calls = [];
  const coordination = {
    tools: async () => [{ name: "trex_peers", description: "peers", inputSchema: { type: "object" } }],
    call: async (name, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: "Tus reservas: src/a.ts" }], isError: false }; },
  };
  const list = mcpResult(await claudeInboxReply("l", mcpRequest("tools/list"), empty, undefined, { coordination }));
  assert.deepEqual(list.tools.map(entry => entry.name).slice(-1), ["trex_peers"]);
  const call = mcpResult(await claudeInboxReply("c", mcpRequest("tools/call", { name: "trex_claim", arguments: { paths: ["src/a.ts"] } }), empty, undefined, { coordination }));
  assert.deepEqual(calls, [{ name: "trex_claim", args: { paths: ["src/a.ts"] } }]);
  assert.equal(call.content[0].text, "Tus reservas: src/a.ts");
  const init = mcpResult(await claudeInboxReply("i", mcpRequest("initialize"), empty, undefined, { coordination }));
  assert.match(init.instructions, /trex_peers/);
  const plain = mcpResult(await claudeInboxReply("p", mcpRequest("initialize"), empty));
  assert.doesNotMatch(plain.instructions, /trex_peers/, "without the registry nothing mentions it");
});

test("a coordination failure is a tool error, and a missing registry only hides those tools", async () => {
  const broken = { tools: () => { throw new Error("Unexpected native call"); }, call: async () => { throw new Error("disco lleno"); } };
  const list = mcpResult(await claudeInboxReply("l", mcpRequest("tools/list"), empty, undefined, { coordination: broken }));
  assert.ok(list.tools.length >= 2, "the inbox and task tools stay available");
  assert.ok(!list.tools.some(entry => isCoordinationTool(entry.name)));
  const call = mcpResult(await claudeInboxReply("c", mcpRequest("tools/call", { name: "trex_peers", arguments: {} }), empty, undefined, { coordination: broken }));
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /disco lleno/);
  const plain = JSON.parse((await claudeInboxReply("u", mcpRequest("tools/call", { name: "trex_peers", arguments: {} }), empty)).line);
  assert.equal(plain.response.response.mcp_response.error.code, -32602, "without coordination it is an unknown tool");
});

test("restored conversations show what the person wrote, without the notes sent to the model", () => {
  const typed = "Arregla el login";
  const sent = withNotes([note("n1", "me", 1)], typed);
  const codex = codexReducer(initialChatState(), { type: "history", turns: [{ id: "t", status: "completed", items: [
    { type: "userMessage", id: "u", content: userInput(sent, []) },
  ] }] });
  assert.equal(codex.items[0].text, typed);
  const claude = chatReducer(initialChatState(), { type: "history", entries: [JSON.parse(userMessageLine(sent, [], "u"))] });
  assert.equal(claude.items[0].text, typed);
  const trex = trexReducer(initialChatState("plan"), { type: "trexReady", models: [],
    result: { sessionId: "s", model: "m", mode: "plan", items: [{ kind: "user", id: "u", text: sent, images: 0, previews: [] }] } });
  assert.equal(trex.items[0].text, typed);
  // Antigravity replays each message in chunks, cut anywhere: it settles when the next update arrives.
  const wake = withNotes([note("n2", "me", 2, "message")], PEER_WAKE);
  let state = antigravityReducer(initialChatState(), { type: "acpReady", sessionId: "s", result: {} });
  const replay = (sessionUpdate, messageId, text) => {
    state = antigravityReducer(state, { type: "acpUpdate", sessionId: "s", turn: null, replay: true,
      update: { sessionUpdate, messageId, content: { type: "text", text } } });
  };
  const cut = sent.indexOf("[/Trex]") + 3, inside = wake.indexOf(PEER_WAKE) + 10;
  for (const chunk of [sent.slice(0, cut), sent.slice(cut)]) replay("user_message_chunk", "past", chunk);
  replay("agent_message_chunk", "answer", "Hecho.");
  for (const chunk of [wake.slice(0, inside), wake.slice(inside)]) replay("user_message_chunk", "woken", chunk);
  replay("agent_message_chunk", "reply", "Respondido.");
  const users = state.items.filter(item => item.kind === "user").map(item => item.text);
  assert.deepEqual(users, [typed, notesBlock([note("n2", "me", 2, "message")])]);
});

test("an automatic turn is remembered as the other session's message, not as the person's", () => {
  const notes = [note("n1", "me", 1, "message"), note("c1", "me", 2)];
  const wake = withNotes(notes, PEER_WAKE);
  assert.equal(withoutNotes(wake), notesBlock(notes), "history keeps the notes, drops the instructions");
  assert.deepEqual(peerTurnNotes(withoutNotes(wake)), ["aviso n1", "aviso c1"]);
  assert.equal(peerTurnNotes(withNotes(notes, "Arregla el login")), null, "a person's message is never a peer turn");
  assert.equal(peerTurnNotes("Hola"), null);
  const multiline = notesBlock([{ ...note("n3", "me", 3, "message"), text: "Hace 1 min · mensaje de «Codex · API»: Primera línea\nSegunda línea" }]);
  assert.deepEqual(peerTurnNotes(multiline), ["Hace 1 min · mensaje de «Codex · API»: Primera línea\nSegunda línea"]);
  assert.deepEqual(peerNoteParts("Hace 1 min · mensaje de «Codex · API (2)»: ¿Puedo?\nGracias"),
    { age: "Hace 1 min", from: "Codex · API (2)", text: "¿Puedo?\nGracias" });
  assert.deepEqual(peerNoteParts("Hace un momento · «Codex» editó src/a.ts"), { age: "Hace un momento", from: null, text: "«Codex» editó src/a.ts" });
  assert.deepEqual(peerNoteParts("texto libre"), { age: "", from: null, text: "texto libre" });
});

// The four conflict sentences are written by `coordination.rs`; the chat takes them apart to draw a card.
test("a peer notice is split into what the chat shows: file, who, why and what to do", () => {
  const advice = "Revisa su cambio antes de seguir y, si os vais a pisar, poneos de acuerdo con trex_message.";
  assert.deepEqual(peerNotice(`Hace un momento · «Claude Code · oye una investigacion que deseo que hagas si actualmente se...» editó native/src/generative.rs, que tienes reservado (Evaluar optimización de MRT2 Base tras la comparación de calidad del usuario). ${advice}`), {
    kind: "conflict", age: "Hace un momento", path: "native/src/generative.rs", label: "Claude Code · oye una investigacion que deseo que hagas si actualmente se...",
    youEdited: false, claimed: true, since: null, reason: "Evaluar optimización de MRT2 Base tras la comparación de calidad del usuario", advice,
  });
  const check = "Comprueba que no has deshecho su trabajo y poneos de acuerdo con trex_message.";
  assert.deepEqual(peerNotice(`Hace 3 min · Editaste src/a.ts, que «Codex · API (2)» tiene reservado (Rediseñar (avisos)). ${check}`), {
    kind: "conflict", age: "Hace 3 min", path: "src/a.ts", label: "Codex · API (2)", youEdited: true, claimed: true, since: null, reason: "Rediseñar (avisos)", advice: check,
  }, "a reason may contain parentheses");
  assert.equal(peerNotice(`Hace 3 min · Editaste src/a.ts, que «Codex» tiene reservado. ${check}`).reason, null, "the reservation may have no reason");
  const reread = "Vuelve a leerlo antes de seguir editándolo y, si os vais a pisar, poneos de acuerdo con trex_message.";
  assert.deepEqual(peerNotice(`Hace un momento · «Codex» editó src/api.ts, que tú también cambiaste hace poco. ${reread}`), {
    kind: "conflict", age: "Hace un momento", path: "src/api.ts", label: "Codex", youEdited: false, claimed: false, since: null, reason: null, advice: reread,
  });
  const lastCheck = "Comprueba que no has deshecho su trabajo y poneos de acuerdo con trex_message si hace falta.";
  assert.deepEqual(peerNotice(`Hace un momento · Editaste C:\\app\\src\\api.ts, que «Codex» cambió hace 2 min. ${lastCheck}`), {
    kind: "conflict", age: "Hace un momento", path: "C:\\app\\src\\api.ts", label: "Codex", youEdited: true, claimed: false, since: "hace 2 min", reason: null, advice: lastCheck,
  });
  assert.deepEqual(peerNotice("Hace 2 min · mensaje de «Codex · API (2)»: ¿Puedo tocar src/api.ts?\nGracias"),
    { kind: "message", age: "Hace 2 min", from: "Codex · API (2)", text: "¿Puedo tocar src/api.ts?\nGracias" });
  for (const other of ["texto libre", "Modo cambiado a planificación.", "Hace un momento · otra cosa que no es un choque", ""]) {
    assert.equal(peerNotice(other), null, other);
  }
});

test("the conflict sentences the chat understands are still the ones the backend writes", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src-tauri/src/coordination.rs", import.meta.url), "utf8");
  for (const phrase of [
    "editó {path}, que tienes reservado{why}. Revisa su cambio antes de seguir",
    "Editaste {path}, que «{label}» tiene reservado{why}. Comprueba que no has deshecho su trabajo",
    "editó {path}, que tú también cambiaste hace poco. Vuelve a leerlo antes de seguir editándolo",
    "Editaste {path}, que «{label}» cambió {}. Comprueba que no has deshecho su trabajo",
  ]) assert.ok(source.includes(phrase), `coordination.rs no longer says: ${phrase} (update peerNotice in src/coordination.ts and PeerNotice.tsx)`);
});

test("the agents' budget pauses after the limit and a person's message resumes it", async () => {
  const h = hub();
  h.instance.join("D:/app", "a", { presence: presence("a"), listener() {} });
  await settle();
  for (let turn = 0; turn < WAKE_LIMIT; turn++) assert.equal(h.instance.spendWake("D:/app"), true);
  assert.equal(h.instance.spendWake("D:/app"), false);
  assert.equal(h.instance.paused("D:/app"), true);
  assert.equal(h.instance.paused("D:/other"), false, "each project counts its own conversation");
  const before = h.syncs.length;
  h.instance.resetWakes("D:/app");
  await settle();
  assert.equal(h.instance.paused("D:/app"), false);
  assert.equal(h.syncs.length, before + 1, "resuming hands every chat a fresh board at once");
  h.instance.spendWake("D:/app");
  h.instance.resetWakes("D:/app");
  await settle();
  assert.equal(h.syncs.length, before + 1, "an ordinary message only restarts the count");
});
