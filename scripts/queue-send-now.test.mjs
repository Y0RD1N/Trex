import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

// These are the real provider hooks and reducers. React scheduling, the native
// process boundary and both kinds of browser timer are local, offline fakes.
const dependencies = Object.fromEntries(await Promise.all([
  "chatMessages", "chatCommands", "chatState", "claudeChat", "codexChat", "trexChat",
  "messageQueue", "inboxProtocol", "workflowSafety", "browser", "sharedFiles", "chatQuestions", "agentTeam", "chatTasks", "integrations",
].map(async name => [`../${name}`, await load(name)])));
const compiled = Object.fromEntries(await Promise.all(["Trex", "Claude", "Codex"].map(async provider => {
  const source = await readFile(new URL(`../src/hooks/use${provider}Chat.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  return [provider.toLowerCase(), new Function("require", "exports", "window", "crypto", "setTimeout", "clearTimeout", outputText)];
})));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const waiting = Symbol("still pending");
const { withAttachedFiles, splitAttachedFiles } = await load("imageReferences");
const attachedPaths = ["C:\\Users\\Ana\\Documentos\\informe final ñ.csv", "/home/ana/documentos/datos de prueba.json"];
const outcome = promise => Promise.race([promise, flush().then(() => waiting)]);
const cancelled = async promise => assert.equal(await outcome(promise), false, "cancellation must settle promptly with false");
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const payload = {
  text: withAttachedFiles("Complete request\nincluding its final paragraph and unicode: fotografía 🦖", attachedPaths),
  images: [{ mediaType: "image/png", data: "cG5nLWZpcnN0" }, { mediaType: "image/jpeg", data: "anBlZy1zZWNvbmQ=" }],
  previews: ["data:image/png;base64,preview-one", "data:image/jpeg;base64,preview-two"],
  display: "Readable queue entry",
};

function fakeClock() {
  let now = 0, counter = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay = 0, ...args) {
      const id = ++counter;
      timers.set(id, { at: now + Math.max(0, Number(delay)), callback: () => callback(...args) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      now = end;
      await flush();
    },
    get size() { return timers.size; },
    dispose() { timers.clear(); },
  };
}

function harness(t, provider, extra = {}) {
  const slots = [], effects = [], writes = [], spawns = [], actions = [], queueCalls = [];
  const clock = fakeClock(), held = new Set(extra.hold ?? []), ipcWaiters = [];
  let cursor = 0, counter = 0, handlers, active = null, session, unmounted = false, conversation = null, turn = null;
  let conversationCounter = 0, turnCounter = 0;
  const hooks = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useReducer(reducer, initial, initialize) {
      const index = cursor++, slot = slots[index] ??= { value: initialize ? initialize(initial) : initial };
      slot.reducer = reducer;
      slot.dispatch ??= action => { actions.push(action); slot.value = slot.reducer(slot.value, action); };
      return [slot.value, slot.dispatch];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
  };
  // useAgentProcess already filters obsolete native process events in production.
  const line = (event, process = active) => {
    if (!unmounted && process && process === active) handlers.onLine(JSON.stringify(event), process);
  };
  const respond = (request, result = {}, error) => line(error
    ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error } }
    : { jsonrpc: "2.0", id: request.id, result }, request.process);
  const controlResponse = (request, error) => line({ type: "control_response", response: {
    request_id: request.request_id, subtype: error ? "error" : "success", ...(error ? { error } : {}),
    response: { current_permission_mode: extra.planningOnly ? "plan" : "default", commands: [], skills: [] },
  } }, request.process);
  const nativeWrite = async (process, raw) => {
    const message = { process, ...JSON.parse(raw) };
    writes.push(message);
    if (extra.beforeWrite) await extra.beforeWrite(message);
    if (held.has("turn-steer-ipc") && message.method === "turn/steer") {
      const pending = deferred(); ipcWaiters.push(pending); await pending.promise;
    }
    const kind = message.method ?? message.request?.subtype ?? message.type;
    if ((held.has("initialize-ipc") && message.method === "initialize") || (held.has("turn-start-ipc") && message.method === "turn/start")) {
      const pending = deferred(); ipcWaiters.push(pending); await pending.promise;
    }
    if (held.has(kind)) return;
    if (provider === "claude") {
      if (message.type === "control_request") controlResponse(message);
      if (message.type === "user" && held.has("user-ipc")) {
        const pending = deferred(); ipcWaiters.push(pending); await pending.promise;
      }
      return;
    }
    // Opt-in realism for resume/history regressions; existing provider fakes keep
    // their original thread-counter behavior unless a test requests this mode.
    if (provider === "codex" && message.method === "thread/resume" && extra.resumeRequestedThread) {
      conversation = message.params.threadId;
      respond(message, { thread: { id: conversation }, model: "offline-model" });
      return;
    }
    if (provider === "codex" && message.method === "thread/turns/list" && extra.history) {
      respond(message, { data: extra.history });
      return;
    }
    switch (message.method) {
      case "initialize": respond(message, provider === "trex" ? { protocolVersion: 1 } : {}); break;
      case "models/list": respond(message, { models: [{ id: "offline-model", efforts: ["high", "max"] }] }); break;
      case "model/list": respond(message, { data: [] }); break;
      case "mcpServerStatus/list": respond(message, extra.mcpStatus ?? { data: [{ name: "trex_browser", runtimeStatus: "connected", toolsError: null,
        tools: Object.fromEntries(["browser_navigate", "browser_snapshot", "browser_status"].map(name => [name, { name, inputSchema: { type: "object", properties: {} } }])) }] }); break;
      case "skills/list": case "account/rateLimits/read": respond(message, { data: [] }); break;
      case "session/start":
        conversation = `conversation-${++conversationCounter}`;
        respond(message, { sessionId: conversation, mode: message.params.mode, model: "offline-model", items: [], recoveryRequired: !!extra.recovery, instructionsApplied: extra.instructionsAck !== false });
        break;
      case "thread/start": case "thread/resume":
        conversation = `thread-${++conversationCounter}`;
        respond(message, { thread: { id: conversation }, model: "offline-model" });
        break;
      case "thread/turns/list": respond(message, { data: [] }); break;
      case "turn/start":
        turn = `turn-${++turnCounter}`;
        respond(message, provider === "trex" ? { accepted: true } : { turn: { id: turn } });
        break;
      case "turn/steer": respond(message, { turnId: turn }); break;
      case "turn/interrupt": case "session/recover": case "permission/respond": respond(message); break;
    }
  };
  const agent = {
    spawn(request) {
      const pending = deferred(), id = `process-${spawns.length + 1}`;
      active = id;
      const ready = pending.promise.then(() => !unmounted && active === id ? id : null);
      spawns.push({ id, request, ...pending, ready });
      if (!held.has("spawn")) pending.resolve();
      return ready;
    },
    async write(raw) {
      const id = await spawns.at(-1)?.ready;
      if (id) await nativeWrite(id, raw);
    },
    isCurrent: id => !unmounted && id === active,
  };
  const queued = { id: "still-queued", text: "Do not automatically drain this message", images: payload.images, previews: payload.previews, createdAt: 1 };
  const snapshot = { messages: [queued], receipt: { id: "unconsumed-receipt", messages: [queued] } };
  const queue = { ready: true, error: null, snapshot, client: Object.fromEntries([
    "read", "load", "ack", "claimDirect", "ackDirect", "restoreDirect", "remove", "enqueue",
  ].map(name => [name, async (...args) => { queueCalls.push({ name, args }); return snapshot; }])) };
  const modules = {
    ...dependencies,
    react: hooks,
    "../browserConnection": { connectBrowser: () => assert.fail("Unexpected browser discovery in a browser-disabled session") },
    "../api": { agentWrite: nativeWrite, formatError: error => error?.message ?? String(error),
      agentTeamMcpConfig: async binding => { assert.ok(extra.teamConfig, "Unexpected team bridge discovery"); return typeof extra.teamConfig === "function" ? extra.teamConfig(binding) : extra.teamConfig; },
      codexContextWindows: async () => ({}), messageQueueMcpConfig: async () => ({}), claudeRewindPoint: async () => null },
    "../conversations": { readConversation: async () => [] },
    "../platform": { IS_WINDOWS: true },
    "./chatSession": { localId: () => `local-${++counter}`, useAgentProcess: (_id, callbacks) => { handlers = callbacks; return agent; } },
    "./useMessageQueue": { useMessageQueue: () => queue },
  };
  const exports = {};
  compiled[provider](name => {
    assert.ok(modules[name], `Unexpected ${provider} dependency: ${name}`);
    return modules[name];
  }, exports, clock, { randomUUID: () => `message-${++counter}` }, clock.setTimeout, clock.clearTimeout);
  const options = { sessionId: "tab", cwd: "D:/projects/trex", command: null, args: null, shell: "powershell", env: null,
    conversationId: null, mode: "ask", visible: false, onExit() {}, onRunning() {}, ...extra };
  const hook = exports[`use${provider[0].toUpperCase()}${provider.slice(1)}Chat`];
  const render = () => {
    assert.equal(unmounted, false, "do not render a disposed hook");
    cursor = 0; session = hook(options);
    for (const effect of effects.splice(0)) effect();
    return session;
  };
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    for (const slot of slots) slot?.cleanup?.();
    active = null;
  };
  t.after(async () => {
    // Close protocol waiters too, including intentionally withheld replies after
    // a simulated unmount. No native process or unresolved IPC survives a test.
    handlers.onExit(0);
    unmount();
    for (const spawn of spawns) spawn.resolve();
    for (const pending of ipcWaiters) pending.resolve();
    clock.dispose();
    await flush();
  });
  render();
  return {
    get session() { return session; }, get state() { return render().state; },
    get conversation() { return conversation; }, get turn() { return turn; },
    get userWrites() { return writes.filter(write => write.type === "user" || write.method === "turn/start" || write.method === "turn/steer"); },
    get interrupts() { return writes.filter(write => write.method === "turn/interrupt" || write.request?.subtype === "interrupt"); },
    writes, spawns, actions, queueCalls, queue, clock, line, respond, controlResponse, render, unmount,
    hold(kind) { held.add(kind); }, release(kind) { held.delete(kind); },
    async pump() { await flush(); if (!unmounted) render(); },
    async ready() { const pending = session.start(); await flush(); render(); await pending; render(); },
    exit(code = 1) { handlers.onExit(code); active = null; },
    resolveIpc(error) { for (const pending of ipcWaiters.splice(0)) error ? pending.reject(error) : pending.resolve(); },
    complete(messageId, status = "completed", overrides = {}) {
      if (provider === "trex") line({ method: "turn/completed", params: { sessionId: conversation, messageId, status, ...overrides } });
      else if (provider === "claude") line({ type: "result", uuid: `result-${++counter}`, subtype: status === "failed" ? "error_during_execution" : "success", user_message_uuid: messageId, ...overrides });
      else line({ method: "turn/completed", params: { threadId: conversation, turn: { id: messageId, status, items: [], error: null }, ...overrides } });
    },
  };
}

function sendNow(h, value = payload) {
  assert.equal(typeof h.session.sendNow, "function", "provider must expose ChatSession.sendNow");
  const result = h.session.sendNow(value.text, value.images, value.previews, value.display);
  assert.ok(result instanceof Promise, "sendNow returns Promise<boolean>");
  return result;
}
function assertPayload(h, write = h.userWrites.at(-1)) {
  assert.deepEqual(splitAttachedFiles(payload.text).files, attachedPaths);
  assert.ok(write, "a native user message was issued");
  if (write.method === "turn/start" && "text" in write.params) {
    assert.equal(write.params.text, payload.text);
    assert.equal(write.params.display, payload.display);
    assert.deepEqual(write.params.images, payload.images);
  } else if (write.type === "user") {
    const content = write.message.content;
    assert.deepEqual(content.filter(item => item.type === "image").map(item => item.source), payload.images.map(image => ({ type: "base64", media_type: image.mediaType, data: image.data })));
    assert.equal(content.at(-1).text, payload.text);
  } else {
    assert.deepEqual(write.params.input.filter(item => item.type === "image").map(item => item.url), payload.images.map(image => `data:${image.mediaType};base64,${image.data}`));
    assert.equal(write.params.input.at(-1).text, payload.text);
  }
  const user = h.state.items.findLast(item => item.kind === "user");
  assert.equal(user.text, payload.display);
  assert.equal(user.images, payload.images.length);
  assert.deepEqual(user.previews, payload.previews);
}
const assertQueueUntouched = h => assert.deepEqual(h.queueCalls, [], "sendNow must not read, claim, acknowledge or drain any durable queue entry");

test("Trex idle sendNow preserves full text, all images, previews and display", async t => {
  const h = harness(t, "trex");
  assert.equal(await sendNow(h), true);
  assert.equal(h.interrupts.length, 0);
  assertPayload(h);
  h.complete(h.userWrites[0].params.messageId);
  assertQueueUntouched(h);
  assert.equal(h.clock.size, 0);
});

test("Trex notifies the exact interrupted id synchronously immediately before marking it", async t => {
  const h = harness(t, "trex"); await h.ready();
  assert.equal(await h.session.send("old active request", [], []), true);
  const oldId = h.userWrites[0].params.messageId, calls = [];
  const before = h.actions.length;
  const pending = h.session.sendNow(payload.text, payload.images, payload.previews, payload.display, id => {
    calls.push(id);
    assert.equal(h.actions.length, before, "the notification precedes the interruption dispatch");
    assert.equal(h.interrupts.length, 0, "the notification precedes any asynchronous native work");
  });
  assert.deepEqual(calls, [oldId], "the callback runs before sendNow yields to its caller");
  assert.deepEqual(h.actions[before], { type: "interruptSend", id: oldId });
  await h.pump();
  assert.equal(await outcome(pending), waiting);
  h.complete(oldId, "interrupted");
  assert.equal(await outcome(pending), true);
  assertPayload(h);
  assert.deepEqual(calls, [oldId]);
  h.complete(h.userWrites[1].params.messageId);
  assertQueueUntouched(h);
});

test("Trex notifies the issued previous turn even while its start RPC is unacknowledged", async t => {
  const h = harness(t, "trex"); await h.ready(); h.hold("turn/start");
  const old = h.session.send("issued request awaiting acknowledgement", [], []); await h.pump();
  const oldId = h.userWrites[0].params.messageId, calls = [];
  const pending = h.session.sendNow(payload.text, payload.images, payload.previews, payload.display, id => calls.push(id));
  assert.deepEqual(calls, [oldId]);
  await cancelled(old);
  await h.pump();
  assert.equal(await outcome(pending), waiting);
  h.release("turn/start"); h.complete(oldId, "interrupted");
  assert.equal(await outcome(pending), true);
  h.complete(h.userWrites[1].params.messageId);
  assertQueueUntouched(h);
});

test("Trex idle sendNow never notifies an interruption", async t => {
  const h = harness(t, "trex"), calls = [];
  assert.equal(await h.session.sendNow(payload.text, payload.images, payload.previews, payload.display, id => calls.push(id)), true);
  assert.deepEqual(calls, []);
  assert.equal(h.actions.some(action => action.type === "interruptSend"), false);
  h.complete(h.userWrites[0].params.messageId);
  assertQueueUntouched(h);
});

for (const stage of ["spawn", "initialize", "session/start"]) {
  test(`Trex sendNow rejected while an unissued send awaits ${stage} never notifies or supersedes its real failure`, async t => {
    const h = harness(t, "trex", { hold: [stage] }), calls = [];
    const original = h.session.send("original send that will fail during startup", [], []); await h.pump();
    assert.equal(await h.session.sendNow(payload.text, payload.images, payload.previews, payload.display, id => calls.push(id)), false);
    assert.deepEqual(calls, []);
    assert.equal(h.actions.some(action => action.type === "interruptSend"), false);
    if (stage === "spawn") h.spawns[0].reject(new Error("original spawn failed"));
    else h.respond(h.writes.findLast(write => write.method === stage), {}, `original ${stage} failed`);
    await h.pump();
    assert.equal(await outcome(original), false);
    assert.equal(h.state.lastCompletion.status, "failed", "the real original failure must remain observable");
    assert.equal(h.userWrites.length, 0);
    assert.deepEqual(calls, []);
    assertQueueUntouched(h);
  });
}

test("Trex a concurrent deferred replacement rejects without a second interruption callback", async t => {
  const h = harness(t, "trex"); await h.ready(); await h.session.send("active turn", [], []);
  const oldId = h.userWrites[0].params.messageId, firstCalls = [], rejectedCalls = [];
  const first = h.session.sendNow("first replacement waiting for terminal", [], [], undefined, id => firstCalls.push(id));
  assert.deepEqual(firstCalls, [oldId]);
  assert.equal(await h.session.sendNow("concurrent replacement", [], [], undefined, id => rejectedCalls.push(id)), false);
  assert.deepEqual(rejectedCalls, []);
  h.session.interrupt(); await cancelled(first);
  h.complete(oldId, "interrupted"); await h.pump();
  assert.equal(h.userWrites.length, 1);
  assertQueueUntouched(h);
});

test("Trex a cached sendNow after unmount never calls its interruption callback", async t => {
  const h = harness(t, "trex"); await h.ready(); await h.session.send("old active turn", [], []);
  const callback = h.session.sendNow, calls = [];
  h.unmount();
  assert.equal(await callback(payload.text, payload.images, payload.previews, payload.display, id => calls.push(id)), false);
  assert.deepEqual(calls, []);
  assertQueueUntouched(h);
});

test("Trex a throwing interruption callback marks only the old turn and cleans up the pending attempt", async t => {
  const h = harness(t, "trex"); await h.ready(); await h.session.send("old active turn", [], []);
  const oldId = h.userWrites[0].params.messageId, calls = [];
  assert.equal(await h.session.sendNow("replacement whose callback throws", [], [], undefined, id => {
    calls.push(id); throw new Error("interruption observer failed");
  }), false);
  assert.deepEqual(calls, [oldId]);
  assert.ok(h.actions.some(action => action.type === "interruptSend" && action.id === oldId));
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.clock.size, 0);
  assert.ok(h.state.items.some(item => item.kind === "notice" && item.text.includes("interruption observer failed")));
  const retryCalls = [];
  const retry = h.session.sendNow(payload.text, payload.images, payload.previews, payload.display, id => retryCalls.push(id));
  assert.deepEqual(retryCalls, [oldId], "the failed observer cannot leave sending.current reserved");
  await h.pump();
  assert.equal(await outcome(retry), waiting);
  h.complete(oldId, "interrupted");
  assert.equal(await outcome(retry), true);
  assert.equal(h.userWrites.length, 2);
  h.complete(h.userWrites[1].params.messageId);
  assert.equal(h.clock.size, 0);
  assertQueueUntouched(h);
});

test("Trex busy sendNow sees a same-render send, interrupts, and requires an authenticated effective terminal", async t => {
  const h = harness(t, "trex"); await h.ready();
  assert.equal(await h.session.send("old request", [], []), true);
  const oldId = h.userWrites[0].params.messageId;
  // Intentionally no render between send and sendNow: stateRef must be current.
  const pending = sendNow(h);
  await h.pump();
  assert.equal(h.interrupts.length, 1);
  assert.equal(await outcome(pending), waiting, "interrupt RPC acknowledgement is not a provider terminal");
  assert.equal(h.userWrites.length, 1);
  for (const params of [
    { sessionId: "foreign-conversation", messageId: oldId, status: "completed" },
    { sessionId: h.conversation, messageId: "unknown-message", status: "completed" },
  ]) h.line({ method: "turn/completed", params });
  h.line({ method: "tool/result", params: { sessionId: h.conversation, messageId: oldId, id: "tool", output: "done" } });
  h.line({ method: "turn/started", params: { sessionId: h.conversation, messageId: oldId, turnId: "old-turn" } });
  await h.pump();
  assert.equal(await outcome(pending), waiting);
  assert.equal(h.userWrites.length, 1);
  h.complete(oldId); // A locally interrupted turn stays effectively interrupted.
  assert.equal(await outcome(pending), true, "a valid reduced terminal must release the waiter without requiring a render");
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.state.lastCompletion.status, "interrupted");
  assert.deepEqual(h.state.pendingMessageIds, [h.userWrites[1].params.messageId]);
  assertPayload(h);
  assertQueueUntouched(h);
  h.complete(h.userWrites[1].params.messageId);
  assert.equal(h.clock.size, 0);
});

test("Trex sendNow cancels an unacknowledged old submission but waits for its terminal, then ignores its late rejection", async t => {
  const h = harness(t, "trex"); await h.ready(); h.hold("turn/start");
  const old = h.session.send("old pending IPC", [], []);
  await h.pump();
  const request = h.userWrites[0], pending = sendNow(h);
  await cancelled(old);
  assert.equal(await outcome(pending), waiting);
  h.release("turn/start");
  h.complete(request.params.messageId, "interrupted");
  assert.equal(await outcome(pending), true);
  h.respond(request, {}, "late failure of obsolete RPC");
  await h.pump();
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.state.pendingTurns, 1);
  assert.equal(h.actions.filter(action => action.type === "trexFailed").length, 0);
  assertQueueUntouched(h);
  h.complete(h.userWrites[1].params.messageId);
});

test("Trex Stop during sendNow settlement cancels it; a late terminal cannot resurrect it", async t => {
  const h = harness(t, "trex"); await h.ready();
  await h.session.send("old request", [], []); h.render();
  const oldId = h.userWrites[0].params.messageId, pending = sendNow(h);
  await h.pump();
  h.session.interrupt();
  await cancelled(pending);
  h.complete(oldId, "interrupted");
  await h.pump();
  assert.equal(h.userWrites.length, 1);
  assertQueueUntouched(h);
  assert.equal(await sendNow(h), true, "a deliberate later attempt can still send");
  assertPayload(h);
  h.complete(h.userWrites[1].params.messageId);
});

for (const stage of ["spawn", "initialize", "session/start"]) {
  test(`Trex Stop during sendNow ${stage} settles promptly and never writes after startup resumes`, async t => {
    const h = harness(t, "trex", { hold: [stage] });
    const pending = sendNow(h);
    await h.pump();
    const request = h.writes.findLast(write => write.method === stage);
    h.session.interrupt();
    await cancelled(pending);
    h.release(stage);
    if (stage === "spawn") h.spawns[0].resolve();
    else h.respond(request, stage === "initialize" ? { protocolVersion: 1 } : { sessionId: "conversation-late", mode: "ask", items: [] });
    await h.pump();
    assert.equal(h.userWrites.length, 0);
    assert.equal(h.state.pendingTurns, 0);
    assert.equal(h.actions.filter(action => action.type === "trexFailed").length, 0);
    assertQueueUntouched(h);
  });
}

for (const lifecycle of ["restart", "exit", "unmount"]) {
  for (const phase of ["settlement", "initialization"]) {
    test(`Trex ${lifecycle} invalidates sendNow during ${phase}, including any late native success`, async t => {
      const h = harness(t, "trex", phase === "initialization" ? { hold: ["initialize"] } : {});
      let oldId;
      if (phase === "settlement") { await h.ready(); await h.session.send("old", [], []); oldId = h.userWrites[0].params.messageId; h.render(); }
      const pending = sendNow(h);
      await h.pump();
      const init = h.writes.findLast(write => write.method === "initialize");
      const issuedBefore = h.userWrites.length;
      if (lifecycle === "restart") void h.session.start().catch(() => undefined);
      else if (lifecycle === "exit") h.exit();
      else h.unmount();
      await cancelled(pending);
      h.release("initialize");
      if (phase === "initialization") h.respond(init, { protocolVersion: 1 });
      else h.complete(oldId);
      await flush();
      assert.equal(h.userWrites.length, issuedBefore);
      assertQueueUntouched(h);
    });
  }
}

test("Trex sendNow settlement is bounded to 30 seconds and a terminal after timeout cannot send", async t => {
  const h = harness(t, "trex"); await h.ready();
  await h.session.send("old", [], []); h.render();
  const oldId = h.userWrites[0].params.messageId, pending = sendNow(h);
  await h.pump();
  await h.clock.advance(29_999);
  assert.equal(await outcome(pending), waiting);
  assert.equal(h.userWrites.length, 1);
  await h.clock.advance(1);
  assert.equal(await outcome(pending), false);
  assert.equal(h.clock.size, 0, "timeout must remove its waiter and timer");
  h.complete(oldId, "interrupted"); await h.pump();
  assert.equal(h.userWrites.length, 1);
  assertQueueUntouched(h);
});

for (const failure of ["RPC rejection", "failed terminal"]) {
  test(`Trex ${failure} never automatically drains the queue or retries a rejected direct sendNow`, async t => {
    const h = harness(t, "trex", { hold: ["turn/start"] }); await h.ready();
    const pending = sendNow(h); await h.pump();
    const request = h.userWrites[0];
    if (failure === "RPC rejection") { h.respond(request, {}, "provider rejected request"); assert.equal(await outcome(pending), false); }
    else { h.respond(request, { accepted: true }); assert.equal(await outcome(pending), true); h.complete(request.params.messageId, "failed"); }
    await h.pump();
    assert.equal(h.state.lastCompletion.status, "failed");
    assert.equal(h.state.pendingTurns, 0);
    assert.equal(h.userWrites.length, 1);
    assertQueueUntouched(h);
    await h.clock.advance(60_000);
    assert.equal(h.userWrites.length, 1);
  });
}

test("Trex recoveryRequired blocks sendNow and never acknowledges recovery or queue receipts automatically", async t => {
  const h = harness(t, "trex", { recovery: true });
  assert.equal(await sendNow(h), false);
  assert.equal(h.userWrites.length, 0);
  assert.equal(h.writes.some(write => write.method === "session/recover"), false);
  assertQueueUntouched(h);
  assert.equal(await sendNow(h), false, "a repeat click is not a recovery acknowledgement");
  assert.equal(h.writes.some(write => write.method === "session/recover"), false);
});

test("Trex a settling terminal that requires recovery blocks the reserved sendNow without autoack", async t => {
  const h = harness(t, "trex"); await h.ready();
  await h.session.send("old uncertain operation", [], []); h.render();
  const pending = sendNow(h); await h.pump();
  h.complete(h.userWrites[0].params.messageId, "interrupted", { recoveryRequired: true });
  assert.equal(await outcome(pending), false);
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.state.pendingTurns, 0);
  assert.equal(h.writes.some(write => write.method === "session/recover"), false);
  assertQueueUntouched(h);
});

test("Trex a rejected interrupt cancels its settlement timer and never sends after a later terminal", async t => {
  const h = harness(t, "trex"); await h.ready();
  await h.session.send("old request", [], []); h.render(); h.hold("turn/interrupt");
  const pending = sendNow(h); await h.pump();
  const interrupt = h.interrupts.at(-1);
  assert.ok(interrupt);
  h.respond(interrupt, {}, "native interrupt rejected");
  assert.equal(await outcome(pending), false);
  await h.pump(); // The aborted sibling waiter runs its finally on the next microtask.
  assert.equal(h.clock.size, 0);
  h.complete(h.userWrites[0].params.messageId, "interrupted"); await h.pump();
  assert.equal(h.userWrites.length, 1);
  assertQueueUntouched(h);
});

test("Trex Stop during an issued sendNow returns false and its late RPC/terminal cannot repeat it", async t => {
  const h = harness(t, "trex"); await h.ready(); h.hold("turn/start");
  const pending = sendNow(h); await h.pump();
  const request = h.userWrites[0];
  h.session.interrupt();
  await cancelled(pending);
  h.respond(request, { accepted: true });
  h.complete(request.params.messageId);
  await h.pump();
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.state.lastCompletion.status, "interrupted");
  assert.equal(h.actions.some(action => action.type === "trexFailed"), false);
  assertQueueUntouched(h);
});

test("Trex cached sendNow callback after unmount returns false without starting or writing", async t => {
  const h = harness(t, "trex"); await h.ready();
  const before = h.writes.length, spawnsBefore = h.spawns.length;
  h.unmount();
  assert.equal(await outcome(sendNow(h)), false);
  assert.equal(h.spawns.length, spawnsBefore);
  assert.equal(h.writes.length, before);
  assertQueueUntouched(h);
});

test("Claude active inputstream sendNow uses ordinary send with full images/display and no interrupt", async t => {
  const h = harness(t, "claude"); await h.ready();
  assert.equal(await h.session.send("existing inputstream turn", [], []), true); h.render();
  assert.equal(await sendNow(h), true);
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.interrupts.length, 0);
  assertPayload(h);
  assertQueueUntouched(h);
  h.complete(h.userWrites[0].uuid);
  h.complete(h.userWrites[1].uuid);
});

test("Codex sendNow starts an idle turn and steers the active turn with full images/display", async t => {
  const h = harness(t, "codex"); await h.ready();
  assert.equal(await h.session.sendNow("first turn", [], []), true); h.render();
  const turnId = h.turn;
  assert.equal(h.userWrites[0].method, "turn/start");
  assert.equal(await sendNow(h), true);
  assert.equal(h.userWrites[1].method, "turn/steer");
  assert.equal(h.userWrites[1].params.expectedTurnId, turnId);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.interrupts.length, 0);
  assertPayload(h);
  assertQueueUntouched(h);
  h.complete(turnId);
});

for (const provider of ["claude", "codex"]) {
  for (const lifecycle of ["stop", "restart", "reset", "exit", "unmount"]) {
    test(`${provider} ${lifecycle} cancels sendNow waiting for initialization and a late reply cannot deliver it`, async t => {
      const h = harness(t, provider, { planningOnly: provider === "claude", hold: ["initialize"] });
      // Start first so Codex is in its normal mounted/starting render.
      const startup = h.session.start(); await h.pump();
      const init = h.writes.findLast(write => write.method === "initialize" || write.request?.subtype === "initialize");
      assert.ok(init);
      const pending = sendNow(h); await h.pump();
      if (lifecycle === "stop") h.session.interrupt();
      else if (lifecycle === "restart") void h.session.start();
      else if (lifecycle === "reset") h.session.reset();
      else if (lifecycle === "exit") h.exit();
      else h.unmount();
      await cancelled(pending);
      if (provider === "claude") h.controlResponse(init);
      else h.respond(init);
      await flush();
      // Restart/reset may prepare a replacement process, but never an old message.
      assert.equal(h.userWrites.length, 0);
      assert.equal(h.actions.some(action => action.type === "sendFailed" || action.type === "turnFailed"), false);
      assertQueueUntouched(h);
      void startup.catch(() => undefined);
    });
  }
  test(`${provider} cached sendNow callback after unmount returns false without starting or writing`, async t => {
    const h = harness(t, provider); await h.ready();
    const before = h.writes.length, spawnsBefore = h.spawns.length;
    h.unmount();
    assert.equal(await outcome(sendNow(h)), false);
    assert.equal(h.spawns.length, spawnsBefore);
    assert.equal(h.writes.length, before);
    assertQueueUntouched(h);
  });
}

for (const lifecycle of ["stop", "restart", "reset", "exit", "unmount"]) {
  test(`Codex ${lifecycle} invalidates the delivery epoch so a queued sendNow cannot steer after a late turn acknowledgement`, async t => {
    const h = harness(t, "codex"); await h.ready(); h.hold("turn/start");
    const old = h.session.send("issued but not acknowledged", [], []); await h.pump();
    const request = h.userWrites[0];
    assert.equal(request.method, "turn/start");
    const pending = sendNow(h); await h.pump();
    assert.equal(h.userWrites.length, 1, "Codex serializes turn delivery while its first request is outstanding");
    if (lifecycle === "stop") h.session.interrupt();
    else if (lifecycle === "restart") void h.session.start();
    else if (lifecycle === "reset") h.session.reset();
    else if (lifecycle === "exit") h.exit();
    else h.unmount();
    await cancelled(pending);
    h.respond(request, { turn: { id: "obsolete-turn" } });
    await flush();
    assert.equal(h.userWrites.length, 1);
    assertQueueUntouched(h);
    // Issued work can await the native reply, but cannot report success afterward.
    assert.notEqual(await outcome(old), true);
  });
}

test("Codex an obsolete initialize IPC failure cannot remove a replacement RPC with a reused id", async t => {
  const h = harness(t, "codex", { hold: ["initialize-ipc"] });
  const oldStartup = h.session.start(); await h.pump();
  const old = h.writes.findLast(write => write.method === "initialize");
  assert.ok(old);
  h.release("initialize-ipc"); h.hold("initialize");
  const replacementStartup = h.session.start(); await h.pump();
  const replacement = h.writes.findLast(write => write.method === "initialize");
  assert.notEqual(replacement.process, old.process);
  assert.equal(replacement.id, old.id, "startup RPC identifiers are reused per process");
  h.resolveIpc(new Error("obsolete initialize IPC failure")); await h.pump();
  h.release("initialize"); h.respond(replacement);
  assert.notEqual(await outcome(replacementStartup), waiting, "old IPC cannot orphan the current initialize waiter");
  await oldStartup;
  assert.equal(await sendNow(h), true);
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.userWrites[0].process, replacement.process);
  assertQueueUntouched(h);
});

test("Claude Stop cancels an issued sendNow Promise and a late IPC rejection cannot become a send failure", async t => {
  const h = harness(t, "claude"); await h.ready(); h.hold("user-ipc");
  const pending = sendNow(h); await h.pump();
  assert.equal(h.userWrites.length, 1);
  h.session.interrupt();
  await cancelled(pending);
  h.resolveIpc(new Error("obsolete IPC rejection"));
  h.complete(h.userWrites[0].uuid);
  await h.pump();
  assert.equal(h.actions.filter(action => action.type === "sendFailed").length, 0);
  assert.equal(h.state.lastCompletion.status, "interrupted");
  assertQueueUntouched(h);
});

test("Codex Stop invalidates a pending active-turn steer so its late acknowledgement cannot succeed or retry", async t => {
  const h = harness(t, "codex"); await h.ready();
  assert.equal(await h.session.send("active turn", [], []), true); h.render();
  const turnId = h.turn;
  h.hold("turn/steer");
  const pending = sendNow(h); await h.pump();
  const request = h.userWrites.at(-1);
  assert.equal(request.method, "turn/steer");
  h.session.interrupt();
  h.respond(request, { turnId });
  assert.equal(await outcome(pending), false);
  h.complete(turnId, "interrupted"); await h.pump();
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.actions.some(action => action.type === "turnFailed"), false);
  assertQueueUntouched(h);
});

const codexUser = (h, value) => {
  const user = h.state.items.findLast(item => item.kind === "user" && item.text === value);
  assert.ok(user, `the submitted user message is visible: ${value}`);
  return user;
};
const reduceCodexTerminal = (state, turnId, status = "completed") => dependencies["../codexChat"].codexReducer(state, {
  type: "rpc", scope: "offline-process", now: 1_000,
  message: { method: "turn/completed", params: { threadId: state.sessionId, turn: { id: turnId, status, items: [], error: null } } },
});

test("Codex a late A start acknowledgement after reset cannot steer C on the replacement thread", async t => {
  const h = harness(t, "codex"); await h.ready(); h.hold("turn/start");
  const first = h.session.sendNow("A on the old thread", [], []); await h.pump();
  const requestA = h.userWrites[0];
  h.session.reset(); await h.pump();
  h.release("turn/start");
  const third = h.session.sendNow("C on the replacement thread", [], []); await h.pump();
  assert.equal(h.userWrites.length, 1, "C waits for the outstanding delivery chain");
  h.respond(requestA, { turn: { id: "obsolete-A" } }); await h.pump();
  assert.equal(await outcome(first), false);
  assert.equal(await outcome(third), true);
  const requestC = h.userWrites[1];
  assert.equal(requestC.method, "turn/start");
  assert.notEqual(requestC.params.threadId, requestA.params.threadId);
  assert.equal("expectedTurnId" in requestC.params, false);
  assert.equal(h.state.turnId, h.turn);
  assert.notEqual(h.state.turnId, "obsolete-A");
  h.complete(h.turn); await h.pump();
  assertQueueUntouched(h);
});

test("Codex a definitively rejected stopped start settles A and permits a deliberate later B", async t => {
  const h = harness(t, "codex"); await h.ready(); h.hold("turn/start");
  const first = h.session.sendNow("A rejected before acquiring a turn identity", [], []); await h.pump();
  const requestA = h.userWrites[0];
  h.session.interrupt();
  assert.equal(await h.session.sendNow("B before rejection must stay blocked", [], []), false);
  h.respond(requestA, {}, "start definitively rejected"); await h.pump();
  assert.equal(await outcome(first), false);
  assert.deepEqual(h.state.pendingMessageIds, []);
  assert.equal(h.state.pendingTurns, 0);
  assert.equal(h.state.completedTurnIds.length, 0);
  h.release("turn/start");
  assert.equal(await h.session.sendNow("deliberate B after A rejection", [], []), true);
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.userWrites[1].method, "turn/start");
  assert.equal(h.interrupts.length, 0);
  h.complete(h.turn); await h.pump();
  assertQueueUntouched(h);
});

test("Codex reset ignores old thread start notifications while the replacement thread is opening", async t => {
  const h = harness(t, "codex"); await h.ready(); h.hold("turn/start");
  const first = h.session.sendNow("A held on the old thread", [], []); await h.pump();
  const requestA = h.userWrites[0];
  h.hold("thread/start"); h.session.reset(); await h.pump();
  const opening = h.writes.findLast(write => write.method === "thread/start");
  h.line({ method: "turn/started", params: { threadId: requestA.params.threadId, turn: { id: "obsolete-notification-A" } } });
  assert.equal(h.state.turnId, null);
  const third = h.session.sendNow("C waits for its replacement thread", [], []);
  h.respond(opening, { thread: { id: "replacement-thread" }, model: "offline-model" });
  h.release("turn/start"); h.respond(requestA, { turn: { id: "obsolete-notification-A" } }); await h.pump();
  assert.equal(await outcome(first), false);
  assert.equal(await outcome(third), true);
  assert.equal(h.userWrites[1].method, "turn/start");
  assert.equal(h.userWrites[1].params.threadId, "replacement-thread");
  assert.equal("expectedTurnId" in h.userWrites[1].params, false);
  h.line({ method: "turn/completed", params: { threadId: "replacement-thread", turn: { id: h.turn, status: "completed" } } });
  assertQueueUntouched(h);
});

test("Codex an IPC failure of a stopped start remains uncertain and never unlocks an automatic replacement", async t => {
  const h = harness(t, "codex"); await h.ready(); h.hold("turn-start-ipc");
  const first = h.session.sendNow("A with uncertain native delivery", [], []); await h.pump();
  h.session.interrupt();
  h.resolveIpc(new Error("uncertain IPC transport failure")); await h.pump();
  assert.equal(await outcome(first), false);
  assert.equal(await h.session.sendNow("B must not join an unidentified stopped turn", [], []), false);
  await h.clock.advance(60_000);
  assert.equal(h.userWrites.length, 1);
  assertQueueUntouched(h);
});

test("Codex Stop before any issued turn cancels initialization without blocking a deliberate later send", async t => {
  const h = harness(t, "codex", { hold: ["initialize"] });
  const first = h.session.sendNow("cancelled during initialization", [], []); await h.pump();
  const init = h.writes.find(write => write.method === "initialize");
  h.session.interrupt(); await cancelled(first);
  h.release("initialize"); h.respond(init); await h.pump();
  assert.equal(await h.session.sendNow("deliberate send after initialization", [], []), true);
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.userWrites[0].method, "turn/start");
  h.complete(h.turn); await h.pump();
  assertQueueUntouched(h);
});

test("Codex Stop without a render suppresses a racing successful old terminal and queue wake marker", async t => {
  const h = harness(t, "codex"); await h.ready();
  assert.equal(await h.session.sendNow("issued turn stopped immediately", [], []), true);
  const turnId = h.turn, userId = h.userWrites[0].params.clientUserMessageId;
  h.session.interrupt();
  assert.equal(await h.session.sendNow("must reject until the stopped turn settles", [], []), false);
  h.complete(turnId, "completed"); await h.pump();
  assert.equal(h.state.lastCompletion.status, "interrupted");
  assert.deepEqual(h.state.lastCompletion.messageIds, [userId]);
  assert.equal(h.state.items.some(item => item.kind === "turn"), false);
  assert.equal(h.userWrites.length, 1);
  assertQueueUntouched(h);
});

for (const timing of ["known turn", "notification before acknowledgement", "acknowledgement before notification"]) {
  test(`Codex Stop remains scoped to A when B is sent after Stop (${timing})`, async t => {
    const h = harness(t, "codex"); await h.ready();
    if (timing !== "known turn") h.hold("turn/start");
    const first = h.session.send("A must remain stopped", [], []); await h.pump();
    const request = h.userWrites[0], turnId = timing === "known turn" ? h.turn : "stopped-before-ack";
    assert.equal(request.method, "turn/start");
    if (timing === "known turn") assert.equal(await outcome(first), true);

    h.session.interrupt();
    const second = h.session.sendNow("B attempted after Stop", [], []); await h.pump();
    assert.equal(h.userWrites.length, 1, "B must not issue against the stopped turn, including when its id is already known");
    assert.notEqual(await outcome(second), true, "B may reject or wait for A's terminal, but cannot succeed before it");

    if (timing !== "known turn") {
      const started = () => h.line({ method: "turn/started", params: { threadId: h.conversation, turn: { id: turnId } } });
      if (timing === "notification before acknowledgement") { started(); await h.pump(); }
      h.respond(request, { turn: { id: turnId } }); await h.pump();
      if (timing === "acknowledgement before notification") { started(); await h.pump(); }
      assert.equal(await outcome(first), false, "the stopped submission cannot report success after its late acknowledgement");
    }
    assert.ok(h.interrupts.some(write => write.params.turnId === turnId), "A must be interrupted as soon as its id becomes known");
    assert.ok(h.interrupts.every(write => write.params.turnId === turnId), "Stop must keep targeting the issued A");
    assert.equal(h.userWrites.length, 1, "neither a late start notification nor its RPC acknowledgement may let B steer A");
    assert.notEqual(await outcome(second), true);
    assertQueueUntouched(h);

    h.release("turn/start");
    h.complete(turnId, "interrupted"); await h.pump();
    const result = await outcome(second);
    assert.notEqual(result, waiting, "a waiting B must settle once A's terminal permits delivery");
    if (result === true) {
      assert.equal(h.userWrites.length, 2);
      assert.equal(h.userWrites[1].method, "turn/start", "a waiting B must start a fresh turn after A settles");
      assert.notEqual(h.turn, turnId);
      h.complete(h.turn); await h.pump();
    } else assert.equal(h.userWrites.length, 1, "a rejected B must not be retried automatically");

    const beforeLaterSend = h.userWrites.length;
    assert.equal(await h.session.send("deliberate later send after A terminal", [], []), true);
    assert.equal(h.userWrites.length, beforeLaterSend + 1);
    assert.equal(h.userWrites.at(-1).method, "turn/start");
    assert.notEqual(h.turn, turnId);
    h.complete(h.turn); await h.pump();
    await h.clock.advance(60_000);
    assert.equal(h.userWrites.length, beforeLaterSend + 1);
    assertQueueUntouched(h);
  });
}

test("Codex A terminal completes issued A/B while unissued C survives to its own later turn terminal", async t => {
  const h = harness(t, "codex"); await h.ready();
  assert.equal(await h.session.send("A active before held steer", [], []), true);
  const turnA = h.turn, idA = h.userWrites[0].params.clientUserMessageId;
  h.hold("turn/steer");
  const second = h.session.sendNow("B issued steer awaiting acknowledgement", [], []); await h.pump();
  const requestB = h.userWrites[1], idB = requestB.params.clientUserMessageId;
  assert.equal(requestB.method, "turn/steer");
  assert.equal(requestB.params.expectedTurnId, turnA);
  const third = h.session.sendNow("C waiting behind B without a native write", [], []); await h.pump();
  const idC = codexUser(h, "C waiting behind B without a native write").id;
  assert.equal(h.userWrites.length, 2, "C has not been issued while B's RPC is outstanding");
  assert.deepEqual(h.state.pendingMessageIds, [idA, idB, idC]);
  assert.equal(await outcome(third), waiting);

  // Exercise the reducer independently with the real hook's state. In
  // particular, B belongs to A before its acknowledgement; C does not.
  const reduced = reduceCodexTerminal(h.state, turnA);
  assert.deepEqual(reduced.lastCompletion.messageIds, [idA, idB], "A's terminal must consume only messages issued for A");
  assert.deepEqual(reduced.pendingMessageIds, [idC], "an unissued submission must survive another turn's terminal");
  assert.equal(reduced.pendingTurns, 1);
  h.complete(turnA); await h.pump();
  assert.deepEqual(h.state.lastCompletion.messageIds, [idA, idB]);
  assert.deepEqual(h.state.pendingMessageIds, [idC]);
  assert.equal(h.userWrites.length, 2);
  assert.equal(await outcome(third), waiting);

  h.respond(requestB, { turnId: turnA }); await h.pump();
  assert.equal(await outcome(second), true);
  assert.equal(await outcome(third), true);
  assert.equal(h.userWrites.length, 3);
  assert.equal(h.userWrites[2].method, "turn/start", "C must open a new turn after A completed");
  assert.equal(h.userWrites[2].params.clientUserMessageId, idC);
  const turnC = h.turn;
  assert.notEqual(turnC, turnA);
  assert.equal(codexUser(h, "C waiting behind B without a native write").providerTurnId, turnC);
  assert.deepEqual(h.state.pendingMessageIds, [idC]);
  assert.equal(h.state.pendingTurns, 1);
  assert.equal(h.state.turnId, turnC);
  assert.deepEqual(h.state.lastCompletion.messageIds, [idA, idB], "C's successful delivery is not its completion");
  h.complete(turnA); await h.pump();
  assert.deepEqual(h.state.pendingMessageIds, [idC], "a replayed A terminal cannot consume C either");
  h.complete(turnC); await h.pump();
  assert.deepEqual(h.state.lastCompletion.messageIds, [idC]);
  assert.equal(h.state.lastCompletion.status, "completed");
  assert.deepEqual(h.state.pendingMessageIds, []);
  assert.equal(h.state.pendingTurns, 0);
  await h.clock.advance(60_000);
  assert.equal(h.userWrites.length, 3);
  assertQueueUntouched(h);
});

for (const queuedC of [false, true]) {
  test(`Codex rejected steer fails only B and A remains live for C (${queuedC ? "C already waiting" : "C sent after rejection"})`, async t => {
    const h = harness(t, "codex"); await h.ready();
    assert.equal(await h.session.send("A survives B rejection", [], []), true);
    const turnA = h.turn, idA = h.userWrites[0].params.clientUserMessageId;
    h.line({ method: "item/agentMessage/delta", params: { threadId: h.conversation, turnId: turnA, itemId: "a-live-answer", delta: "A is still responding" } });
    h.hold("turn/steer");
    const rejected = h.session.sendNow("B rejected once", [], []); await h.pump();
    const requestB = h.userWrites[1], idB = requestB.params.clientUserMessageId;
    assert.equal(requestB.method, "turn/steer");
    assert.equal(requestB.params.expectedTurnId, turnA);
    let third;
    if (queuedC) {
      third = h.session.sendNow("C accepted into the still-live A", [], []); await h.pump();
      assert.equal(h.userWrites.length, 2);
    }
    h.respond(requestB, {}, "B steer was rejected; A is still running"); await h.pump();
    assert.equal(await outcome(rejected), false);
    assert.equal(h.state.turnId, turnA, "a failed steer must not clear the active turn");
    assert.equal(h.state.pendingTurns, 1);
    assert.ok(h.state.pendingMessageIds.includes(idA), "A remains pending after only B's RPC fails");
    assert.equal(h.state.pendingMessageIds.includes(idB), false);
    assert.equal(h.state.completedTurnIds.includes(`codex:${turnA}`), false, "B's failure must not mark A terminal");
    assert.equal(h.state.lastCompletion.status, "failed");
    assert.deepEqual(h.state.lastCompletion.messageIds, [idB], "failure attribution must contain only the rejected submission");
    assert.equal(h.state.items.find(item => item.id === "a-live-answer").final, false, "A's streaming output must remain live");
    assertQueueUntouched(h);

    if (!queuedC) { third = h.session.sendNow("C accepted into the still-live A", [], []); await h.pump(); }
    const requestC = h.userWrites[2], idC = requestC?.params.clientUserMessageId;
    assert.ok(requestC, "C must be delivered after B's rejection releases the delivery chain");
    assert.equal(requestC.method, "turn/steer", "C must join the surviving A instead of opening a new turn");
    assert.equal(requestC.params.expectedTurnId, turnA);
    h.respond(requestC, { turnId: turnA }); await h.pump();
    assert.equal(await outcome(third), true);
    assert.equal(codexUser(h, "C accepted into the still-live A").providerTurnId, turnA);
    assert.deepEqual(h.state.pendingMessageIds, [idA, idC]);
    assert.equal(h.state.turnId, turnA);
    assert.deepEqual(h.state.lastCompletion.messageIds, [idB], "accepting C must not erase B's failure or complete A");
    h.line({ method: "item/agentMessage/delta", params: { threadId: h.conversation, turnId: turnA, itemId: "a-live-answer", delta: "; C was accepted" } });
    assert.equal(h.state.items.find(item => item.id === "a-live-answer").text, "A is still responding; C was accepted");

    const reduced = reduceCodexTerminal(h.state, turnA);
    assert.deepEqual(reduced.lastCompletion.messageIds, [idA, idC]);
    assert.equal(reduced.lastCompletion.status, "completed");
    assert.deepEqual(reduced.pendingMessageIds, []);
    h.complete(turnA); await h.pump();
    assert.deepEqual(h.state.lastCompletion.messageIds, [idA, idC], "the real A terminal completes A and its accepted C, excluding rejected B");
    assert.equal(h.state.lastCompletion.status, "completed");
    assert.deepEqual(h.state.pendingMessageIds, []);
    assert.equal(h.state.pendingTurns, 0);
    assert.equal(h.state.items.find(item => item.id === "a-live-answer").final, true);
    await h.clock.advance(60_000);
    assert.equal(h.userWrites.length, 3, "B must never retry and no queued entry may auto-drain");
    assert.equal(h.userWrites.filter(write => write.params.clientUserMessageId === idB).length, 1);
    assert.equal(h.interrupts.length, 0);
    assertQueueUntouched(h);
  });
}

for (const queuedC of [false, true]) {
  test(`Codex a steer rejection after A's terminal corrects only B (${queuedC ? "C still deferred" : "no replacement yet"})`, async t => {
    const h = harness(t, "codex"); await h.ready();
    assert.equal(await h.session.sendNow("A finishes before B acknowledgement", [], []), true);
    const turnA = h.turn;
    h.hold("turn/steer");
    const second = h.session.sendNow("B rejected after A terminal", [], []); await h.pump();
    const requestB = h.userWrites[1], idB = requestB.params.clientUserMessageId;
    let third;
    if (queuedC) { third = h.session.sendNow("C reserved while B waits", [], []); await h.pump(); }
    h.complete(turnA); await h.pump();
    assert.equal(h.state.lastCompletion.status, "completed");
    assert.ok(h.state.lastCompletion.messageIds.includes(idB));
    h.respond(requestB, {}, "B was rejected despite A already terminating"); await h.pump();
    assert.equal(await outcome(second), false);
    assert.equal(h.state.lastCompletion.status, "failed");
    assert.deepEqual(h.state.lastCompletion.messageIds, [idB]);
    assert.deepEqual(h.state.lastCompletion.itemIds, [], "B's rejection cannot claim A's response");
    assert.equal(codexUser(h, "B rejected after A terminal").providerTurnId, undefined);
    assert.ok(h.state.completedTurnIds.includes(`codex:${turnA}`));
    if (queuedC) {
      assert.equal(await outcome(third), true);
      const requestC = h.userWrites[2], idC = requestC.params.clientUserMessageId;
      assert.equal(requestC.method, "turn/start");
      assert.deepEqual(h.state.pendingMessageIds, [idC]);
      const turnC = h.turn;
      h.complete(turnA); await h.pump();
      assert.deepEqual(h.state.pendingMessageIds, [idC]);
      h.complete(turnC); await h.pump();
      assert.equal(h.state.lastCompletion.status, "completed");
      assert.deepEqual(h.state.lastCompletion.messageIds, [idC]);
    } else assert.deepEqual(h.state.pendingMessageIds, []);
    await h.clock.advance(60_000);
    assert.equal(h.userWrites.length, queuedC ? 3 : 2);
    assert.equal(h.userWrites.filter(write => write.params.clientUserMessageId === idB).length, 1);
    assertQueueUntouched(h);
  });
}

// Keep this race independent of React's next render: the terminal clears the
// synchronous turn ref, while Stop still sees B's issued, unacknowledged steer.
for (const reply of ["definitive RPC rejection", "successful acknowledgement", "uncertain IPC failure"]) {
  test(`Codex Stop after A terminal before render scopes B's late ${reply}`, async t => {
    const h = harness(t, "codex"); await h.ready();
    assert.equal(await h.session.sendNow("A accepted before the Stop race", [], []), true);
    const turnA = h.turn, idA = h.userWrites[0].params.clientUserMessageId;
    h.hold("turn/steer");
    if (reply === "uncertain IPC failure") h.hold("turn-steer-ipc");
    const second = h.session.sendNow("B issued before A terminal and Stop", [], []); await h.pump();
    const requestB = h.userWrites[1], idB = requestB.params.clientUserMessageId;
    assert.equal(requestB.method, "turn/steer");
    assert.equal(requestB.params.expectedTurnId, turnA);
    assert.deepEqual(h.state.pendingMessageIds, [idA, idB]);

    const beforeTerminal = h.actions.length;
    h.complete(turnA);
    h.session.interrupt();
    // Do not read h.state, pump, or render between those two calls.
    assert.deepEqual(h.actions.slice(beforeTerminal).map(action => action.type), ["rpc", "interruptIssued"]);
    assert.equal(await h.session.sendNow("C attempted before B's outcome", [], []), false);
    assert.equal(h.userWrites.length, 2);
    assert.equal(h.state.turnId, null);
    assert.equal(h.state.pendingTurns, 0);
    assert.deepEqual(h.state.pendingMessageIds, []);
    assert.deepEqual(h.state.lastCompletion.messageIds, [idA, idB]);

    if (reply === "definitive RPC rejection") h.respond(requestB, {}, "B definitively rejected after its known A terminal");
    else if (reply === "successful acknowledgement") h.respond(requestB, { turnId: turnA });
    else h.resolveIpc(new Error("B delivery uncertain after its native IPC failed"));
    await h.pump();
    assert.equal(await outcome(second), false, "Stop prevents the old issued B from reporting success");
    assert.equal(h.state.pendingTurns, 0);
    assert.deepEqual(h.state.pendingMessageIds, []);
    assert.equal(h.state.turnId, null);
    assert.equal(h.interrupts.length, 0, "the already-terminal A must not be interrupted or resurrected");
    assert.equal(h.userWrites.length, 2, "settling B must not retry or automatically replace it");
    assertQueueUntouched(h);

    if (reply === "uncertain IPC failure") {
      assert.equal(await h.session.sendNow("C remains blocked while native B delivery is uncertain", [], []), false);
      await h.clock.advance(60_000);
      assert.equal(await h.session.sendNow("elapsed time does not settle uncertain delivery", [], []), false);
      assert.equal(h.userWrites.length, 2);
      assertQueueUntouched(h);
      return;
    }

    if (reply === "definitive RPC rejection") {
      assert.equal(h.state.lastCompletion.status, "failed");
      assert.deepEqual(h.state.lastCompletion.messageIds, [idB], "a definitive B rejection must not fail A");
      assert.deepEqual(h.state.lastCompletion.itemIds, []);
      assert.equal(codexUser(h, "B issued before A terminal and Stop").providerTurnId, undefined);
    } else {
      assert.equal(h.state.lastCompletion.status, "completed");
      assert.deepEqual(h.state.lastCompletion.messageIds, [idA, idB]);
    }

    h.release("turn/steer");
    const third = sendNow(h); await h.pump();
    assert.equal(await outcome(third), true, "B's definitive outcome releases Stop for a deliberate fresh C");
    assert.equal(h.userWrites.length, 3);
    const requestC = h.userWrites[2], idC = requestC.params.clientUserMessageId, turnC = h.turn;
    assert.equal(requestC.method, "turn/start");
    assert.equal(requestC.params.threadId, requestB.params.threadId);
    assert.equal("expectedTurnId" in requestC.params, false);
    assert.notEqual(turnC, turnA);
    assertPayload(h, requestC);
    assert.equal(codexUser(h, payload.display).providerTurnId, turnC);
    assert.deepEqual(h.state.pendingMessageIds, [idC]);
    assert.equal(h.state.pendingTurns, 1);
    h.complete(turnA); await h.pump();
    assert.deepEqual(h.state.pendingMessageIds, [idC], "an old terminal cannot consume the deliberate fresh C");
    h.complete(turnC); await h.pump();
    assert.equal(h.state.lastCompletion.status, "completed");
    assert.deepEqual(h.state.lastCompletion.messageIds, [idC]);
    assert.deepEqual(h.state.pendingMessageIds, []);
    assert.equal(h.state.pendingTurns, 0);
    assert.equal(h.state.turnId, null);
    await h.clock.advance(60_000);
    assert.equal(h.userWrites.length, 3);
    assert.equal(h.userWrites.filter(write => write.params.clientUserMessageId === idB).length, 1);
    assertQueueUntouched(h);
  });
}

for (const replyOrder of ["second reset then first reset", "first reset then second reset"]) {
  test(`Codex successive reset intents keep the latest thread when replies arrive ${replyOrder}`, async t => {
    const h = harness(t, "codex"); await h.ready();
    const initialThread = h.state.sessionId;
    h.hold("thread/start");
    h.session.reset(); await h.pump();
    const firstOpening = h.writes.findLast(write => write.method === "thread/start");
    h.session.reset(); await h.pump();
    const secondOpening = h.writes.findLast(write => write.method === "thread/start");
    assert.notEqual(firstOpening.id, secondOpening.id);
    assert.equal(firstOpening.process, secondOpening.process, "both resets race on the same native process");
    assert.equal(h.spawns.length, 1);
    assert.equal(h.writes.filter(write => write.method === "thread/start").length, 3);
    assert.equal(h.state.sessionId, null);
    assert.equal(h.userWrites.length, 0);

    const latestThread = "latest-reset-thread", staleThread = "obsolete-reset-thread";
    const replyFirst = () => h.respond(firstOpening, { thread: { id: staleThread }, model: "obsolete-reset-model" });
    const replySecond = () => h.respond(secondOpening, { thread: { id: latestThread }, model: "latest-reset-model" });
    if (replyOrder === "second reset then first reset") {
      replySecond(); await h.pump();
      assert.equal(h.state.sessionId, latestThread);
      assert.equal(h.state.model, "latest-reset-model");
      replyFirst(); await h.pump();
    } else {
      replyFirst(); await h.pump();
      assert.equal(h.state.sessionId, null, "the first reset is obsolete even before the latest RPC responds");
      assert.equal(h.actions.some(action => action.type === "thread" && action.response?.thread?.id === staleThread), false);
      replySecond(); await h.pump();
    }
    assert.notEqual(latestThread, initialThread);
    assert.equal(h.state.sessionId, latestThread, "an obsolete reply must never overwrite the displayed latest thread");
    assert.equal(h.state.model, "latest-reset-model", "the latest thread's confirmed model also wins");
    assert.equal(h.actions.filter(action => action.type === "thread" && action.response?.thread?.id === latestThread).length, 1);
    assert.equal(h.actions.some(action => action.type === "thread" && action.response?.thread?.id === staleThread), false);
    assert.equal(h.state.items.some(item => item.kind === "notice" && item.tone === "error"), false, "ignoring an obsolete opening is not a visible startup failure");
    assertQueueUntouched(h);

    const third = sendNow(h); await h.pump();
    assert.equal(await outcome(third), true, "C must be delivered successfully on the latest reset's thread");
    assert.equal(h.userWrites.length, 1);
    const requestC = h.userWrites[0], idC = requestC.params.clientUserMessageId, turnC = h.turn;
    assert.equal(requestC.method, "turn/start");
    assert.equal(requestC.params.threadId, latestThread);
    assert.equal("expectedTurnId" in requestC.params, false);
    assertPayload(h, requestC);
    assert.equal(codexUser(h, payload.display).providerTurnId, turnC);
    assert.equal(h.state.sessionId, latestThread);
    assert.equal(h.state.model, "latest-reset-model");
    assert.equal(h.state.turnId, turnC);
    assert.deepEqual(h.state.pendingMessageIds, [idC]);
    assert.equal(h.state.pendingTurns, 1);

    h.line({ method: "turn/completed", params: { threadId: staleThread, turn: { id: turnC, status: "completed" } } });
    await h.pump();
    assert.deepEqual(h.state.pendingMessageIds, [idC], "the obsolete thread cannot complete C");
    assert.equal(h.state.turnId, turnC);
    h.line({ method: "item/agentMessage/delta", params: { threadId: latestThread, turnId: turnC, itemId: "latest-C-answer", delta: "C responds on the latest thread" } });
    assert.equal(h.state.items.find(item => item.id === "latest-C-answer")?.text, "C responds on the latest thread", "native events must be accepted for the same thread receiving C");
    h.complete(turnC, "completed", { threadId: latestThread }); await h.pump();
    assert.equal(h.state.lastCompletion.status, "completed", "the latest thread's own terminal must finish C");
    assert.deepEqual(h.state.lastCompletion.messageIds, [idC]);
    assert.deepEqual(h.state.pendingMessageIds, []);
    assert.equal(h.state.pendingTurns, 0);
    assert.equal(h.state.turnId, null);
    assert.equal(h.state.items.find(item => item.id === "latest-C-answer").final, true);
    await h.clock.advance(60_000);
    assert.equal(h.userWrites.length, 1, "no reset reply, terminal, or elapsed timer may retry C or drain the queue");
    assert.equal(h.writes.filter(write => write.method === "thread/start").length, 3);
    assert.equal(h.interrupts.length, 0);
    assertQueueUntouched(h);
  });
}

for (const obsoleteA of ["rejects after Stop", "settles before Stop", "no obsolete A"]) {
  test(`Codex Stop of unissued replacement C permits deliberate D when A ${obsoleteA}`, async t => {
    const h = harness(t, "codex"); await h.ready();
    const initialThread = h.state.sessionId;
    let first, requestA;
    if (obsoleteA !== "no obsolete A") {
      h.hold("turn/start");
      first = h.session.sendNow("A issued on the obsolete thread", [], []); await h.pump();
      requestA = h.userWrites[0];
      assert.equal(requestA.method, "turn/start");
      assert.equal(requestA.params.threadId, initialThread);
    }

    // The regression has an already-open replacement and C waiting on A's
    // delivery tail. Controls hold the replacement opening so C stays unissued
    // even when A has settled or never existed.
    if (obsoleteA !== "rejects after Stop") h.hold("thread/start");
    h.session.reset(); await h.pump();
    const opening = h.writes.findLast(write => write.method === "thread/start");
    if (obsoleteA === "settles before Stop") {
      h.respond(requestA, {}, "obsolete A definitively rejected before Stop"); await h.pump();
      assert.equal(await outcome(first), false);
    }
    h.release("turn/start");
    const third = h.session.sendNow("C cancelled before native issue", [], []); await h.pump();
    const writesBeforeStop = requestA ? 1 : 0;
    assert.equal(h.userWrites.length, writesBeforeStop, "C must be waiting without a native turn request");
    const idC = codexUser(h, "C cancelled before native issue").id;
    const actionsBeforeStop = h.actions.length;
    h.session.interrupt();
    await cancelled(third);

    if (obsoleteA === "rejects after Stop") {
      h.respond(requestA, {}, "obsolete A definitively rejected after Stop"); await h.pump();
      assert.equal(await outcome(first), false);
    } else {
      h.release("thread/start");
      h.respond(opening, { thread: { id: "replacement-after-unissued-Stop" }, model: "offline-model" });
      await h.pump();
    }
    const replacementThread = h.state.sessionId;
    assert.notEqual(replacementThread, initialThread);
    assert.equal(h.userWrites.length, writesBeforeStop, "neither A's rejection nor opening the thread may resurrect C");
    assert.equal(h.state.pendingMessageIds.includes(idC), false);

    const fourth = h.session.sendNow("D deliberately sent after cancelled C", [], []); await h.pump();
    assert.equal(await outcome(fourth), true, "an obsolete issued A must not latch Stop on C's current thread generation");
    const requestD = h.userWrites.at(-1), turnD = h.turn;
    assert.equal(h.userWrites.length, writesBeforeStop + 1);
    assert.equal(requestD.method, "turn/start");
    assert.equal(requestD.params.threadId, replacementThread);
    assert.equal("expectedTurnId" in requestD.params, false);
    assert.equal(h.actions.slice(actionsBeforeStop).some(action => action.type === "interruptIssued"), false, "Stop had no issued current-generation submission");
    assert.equal(h.interrupts.length, 0);
    assert.deepEqual(h.state.pendingMessageIds, [requestD.params.clientUserMessageId]);
    assert.equal(h.state.pendingTurns, 1);
    h.complete(turnD, "completed", { threadId: replacementThread }); await h.pump();
    assert.equal(h.state.lastCompletion.status, "completed");
    assert.deepEqual(h.state.lastCompletion.messageIds, [requestD.params.clientUserMessageId]);
    assert.deepEqual(h.state.pendingMessageIds, []);
    await h.clock.advance(60_000);
    assert.equal(h.userWrites.length, writesBeforeStop + 1);
    assert.equal(h.actions.some(action => action.type === "sendFailed"), false);
    assertQueueUntouched(h);
  });
}

const codexThreadWrites = h => h.writes.filter(write => write.method === "thread/start" || write.method === "thread/resume");
const restoredCodexHistory = [{
  id: "restored-old-turn", status: "completed", error: null,
  items: [{ type: "userMessage", id: "restored-old-user", content: [{ type: "text", text: "History from the old saved thread" }] }],
}];

test("Codex fresh reset before render wins over a ready old session during restart initialization", async t => {
  const h = harness(t, "codex", { resumeRequestedThread: true }); await h.ready();
  const initialThread = h.state.sessionId;
  h.hold("initialize");
  const restarting = h.session.start(); await h.pump();
  const initialize = h.writes.findLast(write => write.method === "initialize");
  assert.notEqual(initialize.process, h.spawns[0].id);
  h.release("initialize");
  h.respond(initialize);
  const writesBeforeReset = h.writes.length;
  h.session.reset();
  // No pump, state access, render, or await may separate initialize and reset.
  await h.pump();
  assert.notEqual(await outcome(restarting), waiting);
  const opening = codexThreadWrites(h).at(-1);
  assert.equal(opening.method, "thread/start", "fresh intent must take priority over stateRef's pre-reset sessionId");
  assert.equal(h.writes.slice(writesBeforeReset).some(write => write.method === "thread/resume" && write.params.threadId === initialThread), false);
  const replacementThread = h.state.sessionId;
  assert.ok(replacementThread);
  assert.notEqual(replacementThread, initialThread);
  assert.equal(await h.session.sendNow("C belongs to the fresh reset", [], []), true);
  assert.equal(h.userWrites[0].params.threadId, replacementThread);
  const turnC = h.turn;
  h.complete(turnC, "completed", { threadId: initialThread }); await h.pump();
  assert.equal(h.state.turnId, turnC, "the abandoned old thread cannot finish C");
  h.complete(turnC, "completed", { threadId: replacementThread }); await h.pump();
  assert.equal(h.state.lastCompletion.status, "completed");
  assert.equal(h.userWrites.length, 1);
  assertQueueUntouched(h);
});

for (const renderTiming of ["before render", "after render"]) {
  test(`Codex normal restart resumes the current fresh thread after reset success ${renderTiming}`, async t => {
    const h = harness(t, "codex", {
      conversationId: "saved-old-thread", resumeRequestedThread: true, history: restoredCodexHistory,
    });
    await h.ready();
    assert.equal(h.state.sessionId, "saved-old-thread");
    assert.ok(h.state.items.some(item => item.id === "restored-old-user"), "the configured old history was really restored");
    h.session.reset();
    await flush();
    // Read the accepted RPC action without refreshing stateRef via render.
    const freshThread = h.actions.findLast(action => action.type === "thread").response.thread.id;
    assert.notEqual(freshThread, "saved-old-thread");
    if (renderTiming === "after render") h.render();
    const writesBeforeRestart = h.writes.length;
    const restarting = h.session.start(); await h.pump();
    assert.notEqual(await outcome(restarting), waiting);
    const opening = codexThreadWrites(h).at(-1);
    assert.equal(opening.method, "thread/resume", "a completed fresh reset must not force every later restart to create another thread");
    assert.equal(opening.params.threadId, freshThread, "the most recently accepted thread wins even before React renders it");
    assert.equal(h.state.sessionId, freshThread);
    assert.equal(h.writes.filter(write => write.method === "thread/start").length, 1);
    assert.equal(h.writes.slice(writesBeforeRestart).some(write => write.method === "thread/resume" && write.params.threadId === "saved-old-thread"), false);
    assert.equal(h.state.items.some(item => item.id === "restored-old-user"), false);
    assert.equal(h.writes.filter(write => write.method === "thread/turns/list").length, 1, "restart must not restore the old history into the fresh thread");
    assert.equal(await h.session.sendNow("C after a normal restart of the fresh thread", [], []), true);
    assert.equal(h.userWrites[0].params.threadId, freshThread);
    h.complete(h.turn); await h.pump();
    assert.equal(h.state.lastCompletion.status, "completed");
    assertQueueUntouched(h);
  });
}

test("Codex reset during initial initialization cannot resume the configured saved thread or its history", async t => {
  const h = harness(t, "codex", {
    conversationId: "saved-old-thread", resumeRequestedThread: true, history: restoredCodexHistory, hold: ["initialize"],
  });
  const startup = h.session.start(); await h.pump();
  const initialize = h.writes.findLast(write => write.method === "initialize");
  h.release("initialize");
  h.respond(initialize);
  h.session.reset();
  await h.pump();
  assert.notEqual(await outcome(startup), waiting);
  assert.deepEqual(codexThreadWrites(h).map(write => write.method), ["thread/start"]);
  assert.notEqual(h.state.sessionId, "saved-old-thread");
  assert.ok(h.state.sessionId);
  assert.equal(h.writes.some(write => write.method === "thread/turns/list"), false);
  assert.equal(h.state.items.some(item => item.id === "restored-old-user"), false);
  assert.equal(h.actions.some(action => action.type === "history"), false);
  assert.equal(h.userWrites.length, 0);
  assertQueueUntouched(h);
});

test("Codex reset before render while saved history is loading cannot resume or restore the old thread", async t => {
  const h = harness(t, "codex", {
    conversationId: "saved-old-thread", resumeRequestedThread: true, history: restoredCodexHistory, hold: ["thread/turns/list"],
  });
  const startup = h.session.start(); await h.pump();
  const historyRequest = h.writes.findLast(write => write.method === "thread/turns/list");
  assert.ok(historyRequest);
  assert.equal(historyRequest.params.threadId, "saved-old-thread");
  assert.equal(h.state.sessionId, "saved-old-thread");
  assert.equal(h.actions.some(action => action.type === "history"), false);
  const writesBeforeReset = h.writes.length, actionsBeforeReset = h.actions.length;
  h.session.reset();
  h.release("thread/turns/list");
  h.respond(historyRequest, { data: restoredCodexHistory });
  await h.pump();
  assert.notEqual(await outcome(startup), waiting);
  assert.equal(codexThreadWrites(h).at(-1).method, "thread/start", "the old resumed sessionId cannot override fresh intent while history was in flight");
  assert.equal(h.writes.slice(writesBeforeReset).some(write => write.method === "thread/resume"), false);
  assert.ok(h.state.sessionId);
  assert.notEqual(h.state.sessionId, "saved-old-thread");
  assert.equal(h.state.items.some(item => item.id === "restored-old-user"), false);
  assert.equal(h.actions.slice(actionsBeforeReset).some(action => action.type === "history"), false, "late old history cannot repaint the reset conversation");
  assert.equal(h.userWrites.length, 0);
  assertQueueUntouched(h);
});

test("Codex first send binds its issued generation after startup so Stop still targets it", async t => {
  const h = harness(t, "codex", { hold: ["turn/start"] });
  // No ready()/start() first: submit registers before startup advances the generation.
  const first = h.session.sendNow("first request starts the process", [], []); await h.pump();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.userWrites.length, 1);
  const request = h.userWrites[0], turnId = "first-started-turn";
  h.session.interrupt();
  assert.equal(await h.session.sendNow("B cannot bypass Stop of the first issued request", [], []), false);
  h.respond(request, { turn: { id: turnId } }); await h.pump();
  assert.equal(await outcome(first), false);
  assert.ok(h.interrupts.some(write => write.params.turnId === turnId));
  assert.equal(h.userWrites.length, 1);
  h.complete(turnId, "interrupted"); await h.pump();
  h.release("turn/start");
  assert.equal(await h.session.sendNow("deliberate C after the first stopped turn settles", [], []), true);
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.userWrites[1].method, "turn/start");
  h.complete(h.turn); await h.pump();
  assert.equal(h.state.pendingTurns, 0);
  assertQueueUntouched(h);
});

function inboxRequest(provider, h) {
  if (provider === "claude") return { type: "control_request", request_id: "queue-read", request: {
    subtype: "mcp_message", server_name: "trex_inbox", message: { jsonrpc: "2.0", id: "inner-read", method: "tools/call", params: { name: "trex_read_messages", arguments: {} } },
  } };
  if (provider === "codex") return { jsonrpc: "2.0", id: "queue-read", method: "item/tool/call", params: { threadId: h.conversation, tool: "trex_read_messages", arguments: {} } };
  return { jsonrpc: "2.0", id: "queue-read", method: "inbox/read", params: { sessionId: h.conversation, messageId: h.userWrites.at(-1).params.messageId } };
}
const deliveryReply = (provider, value) => provider === "claude" ? value.response?.request_id === "queue-read" : value.id === "queue-read" && !value.method;
const deliveryResult = (provider, value) => provider === "claude" ? value.response.response.mcp_response.result : value.result;
const fixtureReceipt = () => ({ id: "r-delivery-test", messages: [{ id: "queued-attachments", text: payload.text, images: payload.images, previews: payload.previews, createdAt: 1 }] });

for (const provider of ["claude", "codex", "trex"]) {
  test(`${provider}: queued text, file paths and images survive a pending delivery, receipt retry and later arrivals`, async t => {
    const gate = deferred();
    const h = harness(t, provider, { beforeWrite: message => deliveryReply(provider, message) ? gate.promise : undefined });
    await h.ready(); await h.session.send("Original work", [], []); h.render();
    const receipt = fixtureReceipt(); let reads = 0, stored = { messages: [], receipt };
    h.queue.client.read = async () => { reads++; return stored; };
    const request = inboxRequest(provider, h); h.line(request); await h.pump();
    assert.ok(h.writes.some(value => deliveryReply(provider, value)));
    assert.ok(!h.queueCalls.some(call => call.name === "ack"), "a pending IPC write cannot confirm delivery");
    assert.ok(!h.state.items.some(item => item.id === "queued-attachments"));
    gate.resolve(); await h.pump(); await h.pump();
    const result = deliveryResult(provider, h.writes.find(value => deliveryReply(provider, value)));
    if (provider === "trex") {
      assert.deepEqual(result.messages, receipt.messages);
      assert.ok(!h.queueCalls.some(call => call.name === "ack"));
      h.line({ method: "inbox/consumed", params: { sessionId: h.conversation, messageId: h.userWrites.at(-1).params.messageId, receiptId: receipt.id } });
      await h.pump();
    } else {
      const content = provider === "claude" ? result.content : result.contentItems;
      const text = content.filter(part => ["text", "inputText"].includes(part.type)).map(part => part.text).join("\n");
      assert.ok(text.includes(payload.text));
      assert.deepEqual(splitAttachedFiles(text).files, attachedPaths);
      assert.equal(content.filter(part => ["image", "inputImage"].includes(part.type)).length, payload.images.length);
      assert.ok(!JSON.stringify(content).includes("preview-one"));
      assert.equal(result.structuredContent, undefined);
    }
    assert.ok(h.queueCalls.some(call => call.name === "ack" && call.args[0] === receipt.id));
    const shown = h.state.items.filter(item => item.id === "queued-attachments");
    assert.equal(shown.length, 1); assert.equal(shown[0].text, payload.text); assert.deepEqual(shown[0].previews, payload.previews);
    stored = { messages: [], receipt: { id: "r-later", messages: [{ ...receipt.messages[0], id: "later-message" }] } };
    h.line(request); await h.pump(); await h.pump();
    assert.equal(reads, 1, "replaying the same request must not read later arrivals");
    assert.equal(h.state.items.filter(item => item.id === "queued-attachments").length, 1);
    assert.ok(!h.state.items.some(item => item.id === "later-message"));
    assert.ok(!h.queueCalls.some(call => call.name === "ack" && call.args[0] === "r-later"));
  });

  test(`${provider}: a failed queue reply leaves the receipt unacknowledged and can retry the original attachments`, async t => {
    let rejectWrite = true;
    const h = harness(t, provider, { beforeWrite: message => {
      if (rejectWrite && deliveryReply(provider, message)) throw new Error("offline pipe failure");
    } });
    await h.ready(); await h.session.send("Original work", [], []); h.render();
    const receipt = fixtureReceipt(); let reads = 0;
    h.queue.client.read = async () => { reads++; return { messages: [], receipt }; };
    const request = inboxRequest(provider, h); h.line(request); await h.pump(); await h.pump();
    assert.ok(!h.queueCalls.some(call => call.name === "ack"));
    assert.ok(!h.state.items.some(item => item.id === "queued-attachments"));
    rejectWrite = false; h.line(request); await h.pump(); await h.pump();
    assert.equal(reads, 1, "a pipe failure must retry its original durable receipt");
    const reply = h.writes.findLast(value => deliveryReply(provider, value));
    assert.ok(JSON.stringify(deliveryResult(provider, reply)).includes("informe final ñ.csv"));
    if (provider === "trex") {
      h.line({ method: "inbox/consumed", params: { sessionId: h.conversation, messageId: h.userWrites.at(-1).params.messageId, receiptId: receipt.id } }); await h.pump();
    }
    assert.ok(h.queueCalls.some(call => call.name === "ack" && call.args[0] === receipt.id));
    assert.equal(h.state.items.filter(item => item.id === "queued-attachments").length, 1);
  });
}

test("Codex native MCP confirms model-visible text/images and never a structured receipt that hides the payload", async t => {
  const h = harness(t, "codex"); await h.ready();
  const receipt = fixtureReceipt();
  h.queue.client.load = async () => ({ messages: [], receipt });
  const item = { type: "mcpToolCall", id: "native-read", server: "trex_inbox", tool: "trex_read_messages", status: "completed",
    result: { content: dependencies["../messageQueue"].inboxContent(receipt), _meta: { "trex/receiptId": receipt.id } } };
  h.line({ method: "item/completed", params: { threadId: h.conversation, item: { ...item, result: { ...item.result, structuredContent: { receiptId: receipt.id } } } } }); await h.pump();
  assert.ok(!h.queueCalls.some(call => call.name === "ack"));
  assert.ok(!h.state.items.some(entry => entry.id === "queued-attachments"));
  h.line({ method: "item/completed", params: { threadId: h.conversation, item } }); await h.pump(); await h.pump();
  assert.ok(h.queueCalls.some(call => call.name === "ack" && call.args[0] === receipt.id));
  const shown = h.state.items.find(entry => entry.id === "queued-attachments");
  assert.equal(shown.text, payload.text); assert.equal(shown.images, payload.images.length);
});
