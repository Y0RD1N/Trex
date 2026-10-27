import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";
const deps = Object.fromEntries(await Promise.all(["chatState", "messageQueue", "trexChat", "chatTasks"].map(async name => ["../" + name, await load(name)])));
const source = await readFile(new URL("../src/hooks/useTrexChat.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const compile = new Function("require", "exports", "crypto", compiled);
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function harness(t, extra = {}) {
  const slots = [], effects = [], writes = [], spawns = [], actions = [], acks = [];
  let cursor = 0, counter = 0, handlers, active, session, holdTurn = false, holdInit = false, holdSessionStart = false;
  let receipt = { id: "receipt-1", messages: [{ id: "queued-1", text: "Preserva los archivos", images: [], previews: [], createdAt: 1 }] };
  const spawnReady = deferred();
  const hooks = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useReducer(reducer, initial, init) { const i = cursor++, slot = slots[i] ??= { value: init(initial) }; slot.dispatch ??= action => { actions.push(action); slot.value = reducer(slot.value, action); }; return [slot.value, slot.dispatch]; },
    useEffect(effect, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; }); },
  };
  const line = (p, proc = active) => handlers.onLine(JSON.stringify(p), proc);
  const respond = (p, result) => line({ jsonrpc: "2.0", id: p.id, result });
  const nativeWrite = async (id, raw) => {
    const p = JSON.parse(raw); writes.push({ process: id, ...p });
    if (p.method === "initialize" && !holdInit) respond(p, { protocolVersion: 1 });
    if (p.method === "models/list") respond(p, { models: [{ id: "deepseek", name: "DeepSeek", efforts: ["high", "max"], contextWindow: 1_000_000 }, { id: "mini", efforts: ["low"], contextWindow: 32_000 }] });
    if (p.method === "session/start" && !holdSessionStart) respond(p, { sessionId: "session", mode: p.params.mode, model: p.params.model ?? "deepseek", effort: p.params.effort, items: [], recoveryRequired: extra.recovery });
    if (p.method === "turn/start" && !holdTurn) respond(p, { accepted: true });
    if (["turn/interrupt", "permission/respond", "session/recover"].includes(p.method)) respond(p, {});
  };
  const agent = { async spawn(request) { active = `process-${spawns.length + 1}`; spawns.push({ id: active, request }); if (extra.holdSpawn) await spawnReady.promise; return active; }, isCurrent: id => id === active };
  const queue = { ready: true, snapshot: { messages: [], receipt: null }, client: { read: async () => ({ messages: [], receipt }), ack: async (id, guard) => { if (!guard || guard()) acks.push(id); } } };
  const exports = {};
  compile(name => name === "react" ? hooks : name === "../api" ? { agentWrite: nativeWrite, formatError: e => e.message ?? String(e) }
    : name === "./chatSession" ? { useAgentProcess: (_, cb) => { handlers = cb; return agent; }, localId: () => `rpc-${++counter}` }
    : name === "./useMessageQueue" ? { useMessageQueue: () => queue } : deps[name], exports, { randomUUID: () => `message-${++counter}` });
  const options = { sessionId: "tab", cwd: "D:/project", command: "trex-agent", args: "--profile TREX1", shell: "wsl", env: null,
    conversationId: null, mode: "ask", model: "deepseek", effort: "high", visible: false, onExit() {}, onRunning() {}, ...extra };
  const render = () => { cursor = 0; session = exports.useTrexChat(options); for (const e of effects.splice(0)) e(); return session; };
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); active = null; });
  render();
  return { writes, spawns, actions, acks, options, line, render, spawnReady, respond, queue,
    get state() { return render().state; }, get session() { return render(); },
    holdInitialization() { holdInit = true; }, holdTurn() { holdTurn = true; }, holdSessionStart() { holdSessionStart = true; },
    async start() { const p = session.start(); await flush(); render(); await p; render(); },
    complete(id, status = "completed") { line({ method: "turn/completed", params: { sessionId: "session", messageId: id, status } }); render(); },
    get userWrites() { return writes.filter(w => w.method === "turn/start"); },
  };
}

test("Trex initializes without a model turn and forwards the exact profile, model and effort", async t => {
  const h = harness(t); await h.start();
  assert.deepEqual(h.writes.map(w => w.method), ["initialize", "models/list", "session/start"]);
  assert.equal(h.spawns[0].request.profileArgs, "--profile TREX1");
  assert.deepEqual(h.spawns[0].request.flags, ["app-server"]);
  assert.equal(await h.session.send("Implementa esto", [], []), true);
  assert.equal(h.userWrites[0].params.model, "deepseek"); assert.equal(h.userWrites[0].params.effort, "high");
  h.complete(h.userWrites[0].params.messageId); assert.equal(h.state.pendingTurns, 0);
});

test("Stopping before initialization settles an unsent message promptly and never delivers it later", async t => {
  const h = harness(t, { holdSpawn: true });
  const sent = h.session.send("Do not deliver", [], []); h.session.interrupt();
  assert.equal(await Promise.race([sent, flush().then(() => "waiting")]), false);
  assert.equal(h.state.pendingTurns, 0); assert.equal(h.state.lastCompletion.status, "interrupted");
  h.spawnReady.resolve(); await flush(); await flush();
  assert.equal(h.userWrites.length, 0);
});

test("Stopping an issued write preserves attribution, returns promptly and blocks replacements until its terminal", async t => {
  const h = harness(t); await h.start(); h.holdTurn();
  const sent = h.session.send("Old request", [], []); await flush(); h.render(); h.session.interrupt();
  assert.equal(await Promise.race([sent, flush().then(() => "waiting")]), false);
  assert.equal(await h.session.send("Replacement", [], []), false);
  const old = h.userWrites[0]; h.complete(old.params.messageId, "completed");
  assert.equal(h.state.lastCompletion.status, "interrupted");
  h.respond(old, { accepted: true });
});

test("Read-only planning is immutable and its actual session mode is confirmed", async t => {
  const h = harness(t, { planningOnly: true, mode: "full" }); await h.start();
  assert.equal(h.writes.find(w => w.method === "session/start").params.mode, "plan");
  h.session.setMode("full"); assert.equal(h.state.modeChoice, "plan");
});

test("Model and effort changes are capability-checked and propagate on the very next send", async t => {
  const h = harness(t); await h.start(); h.session.setModel("mini"); h.session.setEffort("max"); h.session.setEffort("low");
  assert.equal(await h.session.send("Test", [], []), true);
  assert.equal(h.userWrites[0].params.model, "mini"); assert.equal(h.userWrites[0].params.effort, "low");
  h.complete(h.userWrites[0].params.messageId);
});

test("A durable inbox receipt is acknowledged only after the native consumption notification", async t => {
  const h = harness(t); await h.start(); await h.session.send("Test", [], []); h.render();
  const id = h.userWrites[0].params.messageId;
  h.line({ jsonrpc: "2.0", id: "inbox-1", method: "inbox/read", params: { sessionId: "session", messageId: id } }); await flush();
  assert.deepEqual(h.acks, []);
  assert.equal(h.writes.find(w => w.id === "inbox-1").result.receiptId, "receipt-1");
  h.line({ method: "inbox/consumed", params: { sessionId: "session", messageId: "unrelated-turn", receiptId: "receipt-1" } }); await flush();
  assert.deepEqual(h.acks, [], "another message must not acknowledge the current receipt");
  h.line({ method: "inbox/consumed", params: { sessionId: "session", messageId: id, receiptId: "receipt-1" } }); await flush();
  assert.deepEqual(h.acks, ["receipt-1"]);
  assert.ok(h.state.items.some(i => i.id === "queued-1" && i.fromQueue));
  h.complete(id);
});

test("Uncertain restored tools require explicit review acknowledgement before any new model turn", async t => {
  const h = harness(t, { recovery: true }); await h.start();
  assert.equal(await h.session.send("Continue", [], []), false);
  assert.equal(h.userWrites.length, 0);
  h.session.runCommand("recover", ""); await flush();
  assert.equal(await h.session.send("Continue after review", [], []), true);
  h.complete(h.userWrites[0].params.messageId);
});

test("a delayed A startup followed by B and then A uses the capacity of each effective selection", async t => {
  const h = harness(t); await h.start();
  h.session.setMode("full"); h.holdSessionStart();
  const sending = h.session.send("Use B after startup", [], []); await flush();
  const start = h.writes.filter(w => w.method === "session/start").at(-1);
  assert.equal(start.params.model, "deepseek");
  h.session.setModel("mini");
  h.respond(start, { sessionId: "session", mode: "full", model: "deepseek", contextWindow: 1_000_000, items: [] });
  assert.equal(await sending, true);
  assert.equal(h.userWrites[0].params.model, "mini");
  h.line({ method: "turn/completed", params: { sessionId: "session", messageId: h.userWrites[0].params.messageId,
    status: "completed", usage: { contextModel: "mini", contextTokens: 1_000, inputTokens: 800, outputTokens: 200 } } });
  assert.equal(h.state.usage.window, 32_000);
  h.session.setModel("deepseek");
  assert.equal(h.state.usage.window, 1_000_000);
  assert.equal(h.state.usage.measured, false);
  assert.equal(await h.session.send("Return to A", [], []), true);
  h.line({ method: "turn/completed", params: { sessionId: "session", messageId: h.userWrites[1].params.messageId,
    status: "completed", usage: { contextModel: "deepseek", contextTokens: 2_000, inputTokens: 1_800, outputTokens: 200 } } });
  assert.equal(h.state.usage.window, 1_000_000);
  assert.equal(h.state.usage.used, 2_000);
});

test("same-session restart without an optional usage summary preserves the known processed total", async t => {
  const h = harness(t); await h.start();
  assert.equal(await h.session.send("First turn", [], []), true);
  h.line({ method: "turn/completed", params: { sessionId: "session", messageId: h.userWrites[0].params.messageId,
    status: "completed", usage: { contextModel: "deepseek", contextTokens: 1_000, inputTokens: 800, outputTokens: 200 } } });
  assert.equal(h.state.usage.total, 1_000);
  h.session.setMode("full"); h.holdSessionStart();
  const startup = h.session.start(); await flush();
  const start = h.writes.filter(w => w.method === "session/start").at(-1);
  h.respond(start, { sessionId: "session", mode: "full", model: "deepseek", contextWindow: 1_000_000,
    items: [{ kind: "user", id: "old", text: "First turn", images: 0, previews: [] }] });
  await startup;
  assert.equal(h.state.usage.total, 1_000);
  assert.equal(h.state.usage.measured, false);
  assert.equal(await h.session.send("Second turn", [], []), true);
  h.line({ method: "turn/completed", params: { sessionId: "session", messageId: h.userWrites[1].params.messageId,
    status: "completed", usage: { contextModel: "deepseek", contextTokens: 2_000, inputTokens: 1_800, outputTokens: 200 } } });
  assert.equal(h.state.usage.total, 3_000);
});
