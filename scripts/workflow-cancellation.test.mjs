import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

// Exercise the real hook and reducers; only React scheduling, timers and native IPC are fake.
const names = ["chatMessages", "chatCommands", "chatState", "claudeChat", "messageQueue", "inboxProtocol", "workflowSafety", "browser", "agentTeam"];
const dependencies = Object.fromEntries(await Promise.all(names.map(async name => ["../" + name, await load(name)])));
const source = await readFile(new URL("../src/hooks/useClaudeChat.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const compileHook = new Function("require", "exports", "window", "crypto", outputText);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const sameDeps = (before, after) => before && after && before.length === after.length && before.every((value, i) => Object.is(value, after[i]));

function harness(t, { planningOnly = true, conversationId = null } = {}) {
  const slots = [], effects = [], writes = [], spawns = [], actions = [];
  const rewind = deferred();
  const history = deferred();
  let cursor = 0, counter = 0, handlers, currentId, session, userWrite;
  const hooks = {
    useRef(value) {
      const index = cursor++;
      return slots[index] ??= { current: value };
    },
    useReducer(reducer, initial, initialize) {
      const index = cursor++;
      const slot = slots[index] ??= { value: initialize(initial) };
      slot.reducer = reducer;
      slot.dispatch ??= action => { actions.push(action); slot.value = slot.reducer(slot.value, action); };
      return [slot.value, slot.dispatch];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { callback, deps };
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
  const nativeWrite = async (procId, raw) => {
    const message = JSON.parse(raw);
    writes.push({ procId, ...message });
    if (message.type === "user") await userWrite?.promise;
  };
  const agent = {
    spawn() {
      const pending = deferred();
      const id = `process-${spawns.length + 1}`;
      currentId = id;
      const ready = pending.promise.then(() => currentId === id ? id : null);
      spawns.push({ id, ...pending, ready });
      return ready;
    },
    async write(raw) {
      const pending = spawns.at(-1);
      const id = await pending.ready;
      if (id) await nativeWrite(id, raw);
    },
    isCurrent: id => id === currentId,
  };
  const modules = {
    ...dependencies,
    react: hooks,
    "../browserConnection": { connectBrowser: () => assert.fail("Unexpected browser discovery in a browser-disabled session") },
    "../api": { agentWrite: nativeWrite, claudeRewindPoint: () => rewind.promise, formatError: error => error?.message ?? String(error) },
    "../conversations": { readConversation: () => history.promise },
    "./chatSession": { localId: () => `control-${++counter}`, useAgentProcess: (_id, callbacks) => { handlers = callbacks; return agent; } },
    "./useMessageQueue": { useMessageQueue: () => queue },
    "../platform": { IS_WINDOWS: true },
  };
  const queue = { client: { read: async () => ({}), ack: async () => undefined } };
  const exports = {};
  compileHook(name => {
    assert.ok(modules[name], `Unexpected dependency: ${name}`);
    return modules[name];
  }, exports, { setTimeout: () => ++counter, clearTimeout: () => undefined }, { randomUUID: () => `message-${++counter}` });
  const options = { sessionId: "tab", cwd: "D:/projects/trex", command: null, args: null, shell: "powershell",
    env: null, conversationId, mode: null, visible: true, planningOnly, onExit() {}, onRunning() {} };
  const render = () => {
    cursor = 0;
    session = exports.useClaudeChat(options);
    for (const effect of effects.splice(0)) effect();
    return session;
  };
  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    for (const slot of slots) slot?.cleanup?.();
    currentId = null;
  };
  t.after(unmount);
  render();
  const line = event => handlers.onLine(JSON.stringify(event), currentId);
  const initialize = (procId = currentId, error) => {
    const request = writes.findLast(write => write.procId === procId && write.request?.subtype === "initialize");
    assert.ok(request, `No initialize request for ${procId}`);
    line({ type: "control_response", response: { request_id: request.request_id,
      subtype: error ? "error" : "success", error,
      response: { current_permission_mode: planningOnly ? "plan" : "default" } } });
  };
  return {
    get session() { return session; }, render, writes, spawns, actions, rewind, history, initialize, line, unmount,
    get state() { return render().state; },
    get userWrites() { return writes.filter(write => write.type === "user"); },
    holdUserWrite() { userWrite = deferred(); return userWrite; },
    exit(code) { handlers.onExit(code); },
    async ready() { spawns.at(-1).resolve(); await flush(); initialize(); await flush(); render(); },
  };
}

const promptlyCancelled = async promise => assert.equal(await Promise.race([promise, flush().then(() => "still waiting")]), false);
const noSendFailure = h => assert.equal(h.actions.filter(action => action.type === "sendFailed").length, 0);

for (const initializationError of [undefined, "late initialization rejection"]) {
  test(`stop during initialized-but-unconfirmed planning blocks deferred USER_REQUEST (${initializationError ?? "success"})`, async t => {
    const h = harness(t);
    h.spawns[0].resolve();
    await flush();
    const pending = h.session.send("plan this task", [], []);
    h.session.interrupt(); // Same render: pendingTurns in the captured state is still zero.
    await promptlyCancelled(pending);
    const completion = h.state.lastCompletion;
    assert.equal(completion.status, "interrupted");
    assert.equal(h.state.pendingTurns, 0);
    h.initialize("process-1", initializationError);
    await flush();
    assert.equal(h.userWrites.length, 0);
    assert.equal(h.state.lastCompletion, completion);
    noSendFailure(h);
    assert.ok(h.writes.some(write => write.procId === "process-1" && write.request?.subtype === "interrupt"));
    if (!initializationError) assert.equal(h.state.items.filter(item => item.kind === "notice" && item.tone === "error").length, 0);
  });
}

test("stop before spawn completion remains interrupted after later initialization", async t => {
  const h = harness(t);
  const pending = h.session.send("deferred plan", [], []);
  h.session.interrupt();
  await promptlyCancelled(pending);
  const completion = h.state.lastCompletion;
  h.spawns[0].resolve();
  await flush();
  h.initialize();
  await flush();
  assert.equal(h.userWrites.length, 0);
  assert.equal(h.state.lastCompletion, completion);
  noSendFailure(h);
});

for (const lifecycle of ["reset", "start"]) {
  for (const obsoleteError of [undefined, "obsolete initialization rejected"]) {
    test(`${lifecycle} cancels old initialization and preserves the replacement send (${obsoleteError ?? "success"})`, async t => {
      const h = harness(t);
      h.spawns[0].resolve();
      await flush();
      const pending = h.session.send("obsolete request", [], []);
      void h.session[lifecycle]();
      await promptlyCancelled(pending);
      h.initialize("process-1", obsoleteError);
      await flush();
      h.spawns[1].resolve();
      await flush();
      h.initialize("process-2");
      await flush();
      assert.equal(await h.session.send("replacement request", [], []), true);
      assert.equal(h.userWrites.length, 1);
      assert.equal(h.userWrites[0].procId, "process-2");
      assert.equal(h.state.pendingTurns, 1);
      noSendFailure(h);
      assert.equal(h.actions.filter(action => action.type === "spawnFailed").length, 0);
      assert.ok(h.actions.some(action => action.type === "cancelSend"));
    });
  }
}

test("an obsolete spawn rejection cannot fail the replacement startup", async t => {
  const h = harness(t);
  const pending = h.session.send("old request", [], []);
  void h.session.start();
  await promptlyCancelled(pending);
  h.spawns[0].reject(new Error("old spawn failed"));
  await h.ready();
  assert.equal(await h.session.send("new request", [], []), true);
  assert.equal(h.userWrites.length, 1);
  assert.equal(h.actions.filter(action => action.type === "spawnFailed").length, 0);
  noSendFailure(h);
});

for (const lifecycle of ["reset", "start", "unmount"]) {
  test(`${lifecycle} prevents an obsolete deferred history read from restoring the old conversation`, async t => {
    const h = harness(t, { conversationId: "old-conversation" });
    await h.ready();
    if (lifecycle === "unmount") h.unmount();
    else void h.session[lifecycle]();
    h.history.resolve([{ type: "user", uuid: "old-user", message: { content: "obsolete history" } }]);
    await flush();
    assert.equal(h.actions.filter(action => action.type === "history").length, 0);
  });
}

test("unmount cancels pending initialization without a late write or failure", async t => {
  const h = harness(t);
  const pending = h.session.send("do not submit after unmount", [], []);
  h.unmount();
  await promptlyCancelled(pending);
  h.spawns[0].resolve();
  await flush();
  assert.equal(h.userWrites.length, 0);
  assert.equal(h.actions.filter(action => action.type === "spawnFailed").length, 0);
  noSendFailure(h);
});

for (const code of [0, 1]) {
  test(`exit ${code} invalidates deferred work and a later send starts a new process`, async t => {
    const h = harness(t);
    h.spawns[0].resolve();
    await flush();
    const pending = h.session.send("old request", [], []);
    h.exit(code);
    await promptlyCancelled(pending);
    assert.equal(h.state.lastCompletion.status, code ? "failed" : "interrupted");
    const next = h.session.send("new request", [], []);
    await h.ready();
    assert.equal(await next, true);
    assert.equal(h.userWrites.length, 1);
    assert.equal(h.userWrites[0].procId, "process-2");
    noSendFailure(h);
  });
}

test("cancellation while a user write is pending cannot return success or generic failure", async t => {
  const h = harness(t);
  await h.ready();
  const writing = h.holdUserWrite();
  const pending = h.session.send("already issued", [], []);
  await flush();
  assert.equal(h.userWrites.length, 1);
  h.session.interrupt();
  await promptlyCancelled(pending);
  writing.reject(new Error("late IPC failure"));
  await flush();
  assert.equal(h.state.lastCompletion.status, "interrupted");
  noSendFailure(h);
});

for (const heldIpc of [true, false]) {
  test(`an interrupted ${heldIpc ? "held" : "acknowledged"} write keeps its attribution and its legacy terminal cannot complete the replacement`, async t => {
    const h = harness(t);
    await h.ready();
    const writing = heldIpc ? h.holdUserWrite() : null;
    const old = h.session.send("old request", [], []);
    await flush();
    if (!heldIpc) assert.equal(await old, true);
    h.render();
    const oldId = h.userWrites[0].uuid;
    h.session.interrupt();
    if (heldIpc) await promptlyCancelled(old);
    const next = h.session.send("replacement request", [], []);
    await flush();
    assert.equal(h.userWrites.length, 1, "replacement must wait for the old provider terminal");
    assert.deepEqual(h.state.pendingMessageIds, [oldId], "issued attribution must survive local cancellation");
    assert.equal(h.actions.some(action => action.type === "cancelSend" && action.id === oldId), false);
    h.line({ type: "assistant", message: { id: "old-plan", content: [{ type: "text", text: "<trex_plan>old plan</trex_plan>" }] } });
    h.line({ type: "result", subtype: "success" }); // Legacy CLI: no message UUID or result identity.
    assert.equal(h.state.lastCompletion.status, "interrupted");
    assert.deepEqual(h.state.lastCompletion.messageIds, [oldId]);
    await flush();
    writing?.resolve();
    assert.equal(await next, true);
    const nextId = h.userWrites[1].uuid;
    assert.deepEqual(h.state.pendingMessageIds, [nextId]);
    assert.equal(h.state.lastCompletion.status, "interrupted", "the old plan must never authorize replacement execution");
    h.line({ type: "assistant", message: { id: "new-plan", content: [{ type: "text", text: "<trex_plan>new plan</trex_plan>" }] } });
    h.line({ type: "result", uuid: "new-result", subtype: "success", user_message_uuid: nextId });
    const done = h.state;
    assert.equal(done.lastCompletion.status, "completed");
    assert.deepEqual(done.lastCompletion.messageIds, [nextId]);
    assert.deepEqual(done.items.filter(item => done.lastCompletion.itemIds.includes(item.id) && item.kind === "text").map(item => item.text),
      ["<trex_plan>new plan</trex_plan>"]);
    noSendFailure(h);
  });
}

for (const planningOnly of [true, false]) {
  test(`ordinary ${planningOnly ? "planning" : "chat"} messages share startup and still write successfully after a stop`, async t => {
    const h = harness(t, { planningOnly });
    const old = h.session.send("cancel this", [], []);
    h.session.interrupt();
    await promptlyCancelled(old);
    const first = h.session.send("first normal message", [], []);
    const second = h.session.send("second normal message", [], []);
    const writing = h.holdUserWrite();
    h.render(); // React commits pendingTurns while initialization is unresolved.
    await h.ready();
    h.render(); // Another commit while both native user writes remain unresolved.
    assert.equal(h.userWrites.length, 2);
    writing.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(h.spawns.length, 1);
    assert.equal(h.userWrites.length, 2);
    assert.ok(h.userWrites.every(write => write.procId === "process-1"));
    const ids = h.userWrites.map(write => write.uuid);
    h.line({ type: "result", uuid: "normal-result", subtype: "success", user_message_uuids: ids });
    assert.equal(h.state.lastCompletion.status, "completed");
    assert.deepEqual(h.state.lastCompletion.messageIds, ids);
    noSendFailure(h);
  });
}

test("a same-tick send after cancelling rewind uses the original process readiness", async t => {
  const h = harness(t);
  await h.ready();
  await h.session.send("original", [], []);
  const id = h.userWrites[0].uuid;
  h.line({ type: "system", subtype: "init", session_id: "saved", permissionMode: "plan" });
  h.line({ type: "result", uuid: "original-result", subtype: "success", user_message_uuid: id });
  h.render();
  const editing = h.session.edit(id, "cancel this edit", [], []);
  h.session.interrupt();
  const next = h.session.send("continue normally", [], []);
  assert.equal(await next, true);
  await editing;
  assert.equal(h.spawns.length, 1);
  assert.equal(h.userWrites.length, 2);
  assert.equal(h.userWrites[1].procId, "process-1");
  noSendFailure(h);
});

for (const phase of ["rewind", "spawn", "initialize"]) {
  test(`an edit canceled during ${phase} cannot rewind state or send the replacement message`, async t => {
    const h = harness(t);
    await h.ready();
    await h.session.send("original message", [], []);
    const id = h.userWrites[0].uuid;
    h.line({ type: "system", subtype: "init", session_id: "saved-conversation", permissionMode: "plan" });
    h.line({ type: "result", uuid: "original-result", subtype: "success", user_message_uuid: id });
    h.render();
    const pending = h.session.edit(id, "replacement message", [], []);
    if (phase !== "rewind") { h.rewind.resolve("rewind-point"); await flush(); }
    if (phase === "initialize") { h.spawns[1].resolve(); await flush(); }
    h.session.interrupt();
    await pending;
    h.rewind.resolve("rewind-point");
    if (phase === "spawn") h.spawns[1].resolve();
    if (phase === "initialize") h.initialize("process-2");
    await flush();
    assert.equal(h.userWrites.length, 1);
    assert.equal(h.actions.filter(action => action.type === "rewind").length, 0);
    assert.equal(h.state.sessionId, "saved-conversation");
    noSendFailure(h);
  });
}

test("cancelSend is idempotent, affects only its message, and rejects a late success", () => {
  const { initialChatState } = dependencies["../chatState"];
  const { chatReducer } = dependencies["../claudeChat"];
  let state = chatReducer(initialChatState(), { type: "send", id: "cancelled", text: "old", now: 1 });
  state = chatReducer(state, { type: "cancelSend", id: "cancelled" });
  const cancelled = state;
  assert.equal(chatReducer(state, { type: "cancelSend", id: "cancelled" }), state);
  state = chatReducer(state, { type: "line", event: { type: "result", uuid: "late", subtype: "success", user_message_uuid: "cancelled" }, now: 2 });
  assert.equal(state.lastCompletion, cancelled.lastCompletion);
  state = chatReducer(state, { type: "send", id: "remaining", text: "keep", now: 3 });
  state = chatReducer(state, { type: "cancelSend", id: "cancelled" });
  assert.deepEqual(state.pendingMessageIds, ["remaining"]);
  assert.equal(state.pendingTurns, 1);
  assert.equal(state.lastCompletion.status, "interrupted");
});

test("each already-issued cancellation stays interrupted when separate legacy terminals arrive", () => {
  const { initialChatState } = dependencies["../chatState"];
  const { chatReducer } = dependencies["../claudeChat"];
  let state = initialChatState();
  for (const id of ["first", "second"]) state = chatReducer(state, { type: "send", id, text: id, now: 1 });
  for (const id of ["first", "second"]) state = chatReducer(state, { type: "interruptSend", id });
  assert.deepEqual(state.pendingMessageIds, ["first", "second"]);
  for (const id of ["first", "second"]) {
    state = chatReducer(state, { type: "line", event: { type: "result", uuid: `legacy-${id}`, subtype: "success" }, now: 2 });
    assert.equal(state.lastCompletion.status, "interrupted");
    assert.deepEqual(state.lastCompletion.messageIds, [id]);
  }
});
