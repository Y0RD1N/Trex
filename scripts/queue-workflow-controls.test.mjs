import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

// Run the actual components, workflow/provider hooks and reducers. Only React's
// scheduler/JSX, DOM surfaces, queue storage and native process IPC are mocked.
const names = ["agentPermissions", "agentTeam", "timeFormat", "agentRoom", "agentWorkflow", "handoff", "chatState", "chatTimes", "chatMessages", "chatCommands", "chatQuestions",
  "chatImages", "chatFiles", "sharedFiles", "imageReferences", "workSummary", "planUsage", "agentNotices",
  "visualDesign", "paste", "messageQueue", "trexChat", "browser", "chatTasks", "integrations", "accessibility"];
const dependencies = Object.fromEntries(await Promise.all(names.map(async name => [`../${name}`, await load(name)])));
const sources = {
  stable: "hooks/useStableCallback.ts", workflow: "hooks/useAgentWorkflow.ts", trex: "hooks/useTrexChat.ts",
  panel: "components/ChatView.tsx", room: "components/AgentRoomView.tsx", motion: "motion.ts",
};
const compiled = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, path]) => {
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } });
  return [name, new Function("require", "exports", "window", "document", "crypto", "setTimeout", "clearTimeout",
    "requestAnimationFrame", "cancelAnimationFrame", outputText)];
})));
const flush = () => new Promise(resolve => setImmediate(resolve));
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const forbidden = label => () => { throw new Error(`Unexpected external operation: ${label}`); };
const noop = () => undefined;
let currentHost;
const react = Object.fromEntries(["useRef", "useState", "useReducer", "useMemo", "useCallback", "useEffect", "useLayoutEffect"]
  .map(name => [name, (...args) => currentHost[name](...args)]));
react.memo = component => component;
// The offline host renders synchronously: the deferred value is the current one.
react.useDeferredValue = value => value;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };

function host(t) {
  const slots = [], layout = [], passive = [], actions = [];
  let cursor = 0, dirty = false, disposed = false;
  const effect = (list, callback, deps) => {
    const index = cursor++, previous = slots[index];
    if (!sameDeps(previous?.deps, deps)) list.push(() => {
      previous?.cleanup?.();
      slots[index] = { deps, cleanup: callback() };
    });
  };
  const result = {
    actions,
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useState(initial) {
      const index = cursor++, slot = slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      slot.set ??= value => {
        const next = typeof value === "function" ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      };
      return [slot.value, slot.set];
    },
    useReducer(reducer, initial, initialize) {
      const index = cursor++, slot = slots[index] ??= { value: initialize ? initialize(initial) : initial };
      slot.reducer = reducer;
      slot.dispatch ??= action => { actions.push(action); const next = slot.reducer(slot.value, action);
        if (next !== slot.value) { slot.value = next; dirty = true; } };
      return [slot.value, slot.dispatch];
    },
    useMemo(callback, deps) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { deps, value: callback() };
      return slots[index].value;
    },
    useCallback(callback, deps) { return result.useMemo(() => callback, deps); },
    useLayoutEffect(callback, deps) { effect(layout, callback, deps); },
    useEffect(callback, deps) { effect(passive, callback, deps); },
    render(callback) {
      assert.equal(disposed, false);
      let value;
      for (let count = 0; count < 30; count++) {
        dirty = false; cursor = 0;
        const previous = currentHost; currentHost = result;
        try { value = callback(); } finally { currentHost = previous; }
        for (const run of layout.splice(0)) run();
        for (const run of passive.splice(0)) run();
        if (!dirty) return value;
      }
      throw new Error("React mock did not settle");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const slot of slots) slot?.cleanup?.();
    },
  };
  t.after(result.dispose);
  return result;
}

const ui = new Map();
function uiModule(name) {
  if (!ui.has(name)) ui.set(name, new Proxy({}, { get: (_target, key) => {
    if (key === "SharedFilesContext") return { Provider: "SharedFilesProvider" };
    if (key === "useImageViewer") return () => ({ open: forbidden("image viewer") });
    if (key === "GIT_BRANCH_CHANGED") return "offline-branch-changed";
    return `${name}:${String(key)}`;
  } }));
  return ui.get(name);
}
const uiPaths = new Set(["./chat/BrowserMenu","./AgentIcon", "./AgentRoomToolbar", "./Select", "./Icons", "./chat/ChatItems", "./chat/ModelMenu",
  "./chat/ComposerSettings", "./chat/UsageMenu", "./chat/SharedFiles", "./ImageViewer", "./chat/QuestionPanel",
  "./chat/Suggestions", "./chat/WorkSummary", "./chat/BranchMenu", "./chat/GitPanel", "./chat/QueuedMessages", "./chat/ComposerPanel", "./chat/BackgroundTerminals", "./chat/TaskPanel", "./chat/AgentActivity", "./chat/ChatWelcome"]);
function environment() {
  let counter = 0;
  const timers = new Map();
  const setTimeout = callback => { const id = ++counter; timers.set(id, callback); return id; };
  const clearTimeout = id => timers.delete(id);
  return { timers, setTimeout, clearTimeout,
    window: { setTimeout, clearTimeout, addEventListener: noop, removeEventListener: noop },
    document: { querySelector: () => null }, crypto: { randomUUID: () => `offline-message-${++counter}` },
    requestAnimationFrame: callback => { callback(); return ++counter; },
  };
}
function evaluate(name, env, overrides = {}) {
  const modules = { ...dependencies, react, "react/jsx-runtime": jsxRuntime,
    "@tauri-apps/plugin-dialog": { open: forbidden("file dialog") }, ...overrides };
  const exports = {};
  compiled[name](specifier => {
    if (Object.hasOwn(modules, specifier)) return modules[specifier];
    if (specifier.endsWith(".css")) return {};
    if (uiPaths.has(specifier)) return uiModule(specifier);
    throw new Error(`Unexpected ${name} dependency: ${specifier}`);
  }, exports, env.window, env.document, env.crypto, env.setTimeout, env.clearTimeout, env.requestAnimationFrame, noop);
  return exports;
}
function* elements(node) {
  if (Array.isArray(node)) { for (const child of node) yield* elements(child); }
  else if (node && typeof node === "object" && "props" in node) { yield node; yield* elements(node.props.children); }
}
const find = (tree, predicate) => {
  const matches = [...elements(tree)].filter(predicate);
  assert.equal(matches.length, 1, "expected exactly one matching UI element");
  return matches[0];
};
const baseProps = () => ({ sessionId: "offline-tab", projectId: "project", projectName: "Offline project", cwd: "D:/projects/trex",
  conversationId: null, command: null, args: null, shell: "powershell", env: null,
  settings: { fontSize: 13, motion: "reduced", pasteShortcut: "Ctrl+V" }, visible: false, focused: false,
  onActivity: noop, onNotice: noop, onConversation: noop, onTitle: noop, onMode: noop, onModel: noop, onEffort: noop,
  onMessage: noop, onOpenUsage: noop, onRunning: noop, onExit: noop });
const api = { formatError: error => error?.message ?? String(error),
  gitBranch: forbidden("git branch"), listProjectFiles: forbidden("project files"), readClipboard: forbidden("clipboard"),
  loadHandoff: forbidden("handoff read"), prepareHandoff: forbidden("handoff write") };
function panelModule(env, overrides = {}) {
  const stable = evaluate("stable", env);
  const workflow = evaluate("workflow", env, { "../api": api, "./useStableCallback": stable });
  return evaluate("panel", env, { "../api": api, "../motion": evaluate("motion", env), "../hooks/useStableCallback": stable, "../hooks/useAgentWorkflow": workflow,
    "../hooks/useHandoffDelivery": { useHandoffDelivery: () => ({ prepared: { content: "Original request" }, loading: false, sending: false }) },
    "../hooks/useClaudeChat": { useClaudeChat: forbidden("Claude hook") },
    "../hooks/useCodexChat": { useCodexChat: forbidden("Codex hook") },
    "../hooks/useAntigravityChat": { useAntigravityChat: forbidden("Antigravity hook outside its test host") },
    "../hooks/useTrexChat": { useTrexChat: forbidden("Trex hook outside its mock host") }, ...overrides });
}

function queueStore(messages = [], trace = []) {
  let snapshot = { messages: structuredClone(messages), receipt: null, outbox: [] };
  const mutate = (name, work) => async (...args) => { trace.push(name); work?.(...args); return structuredClone(snapshot); };
  const transport = { list: mutate("list"),
    claimDirect: mutate("claimDirect", (id, expected) => {
      const message = snapshot.messages.find(value => value.id === id);
      assert.deepEqual(message, expected);
      assert.equal(snapshot.outbox.length, 0);
      snapshot = { ...snapshot, messages: snapshot.messages.filter(value => value.id !== id),
        outbox: [{ id: "offline-dispatch", message, predecessors: [] }] };
    }),
    ackDirect: mutate("ackDirect", id => { snapshot.outbox = snapshot.outbox.filter(value => value.id !== id); }),
    read: forbidden("inbox read"), ack: forbidden("inbox ack"), enqueue: forbidden("queue enqueue"),
    update: forbidden("queue update"), remove: forbidden("queue remove"), restoreDirect: forbidden("queue restore"),
  };
  const queue = { ready: true, error: null, snapshot,
    client: new dependencies["../messageQueue"].MessageQueue(transport, value => { queue.snapshot = value; }),
    reload: () => queue.client.load() };
  return queue;
}

function trexWorkflow(t, role = "executor", { holdInitialize = false } = {}) {
  const env = environment(), nativeHost = host(t), panelHost = host(t), trace = [], writes = [], statuses = [], plans = [];
  const correction = { id: "queued-correction", text: "Use the corrected request", images: [], previews: [], createdAt: 1 };
  const queue = queueStore([correction], trace);
  const participant = { provider: "trex", profileId: "offline-profile", profileName: "Offline Trex", model: null };
  let handlers, session, tree, workflow = { id: "workflow-one", role, status: role === "planner" ? "planning" : "executing",
    planner: participant, executor: participant };
  let sequence = 0;
  const line = event => handlers.onLine(JSON.stringify(event), "offline-process");
  const agentWrite = async (_process, raw) => {
    const request = JSON.parse(raw); writes.push(request); trace.push(request.method);
    const responses = {
      initialize: { protocolVersion: 1 }, "models/list": { models: [] },
      "session/start": { sessionId: "offline-conversation", mode: role === "planner" ? "plan" : "ask", model: "offline-model", items: [], instructionsApplied: true },
      "turn/start": { accepted: true }, "turn/interrupt": {},
    };
    assert.ok(Object.hasOwn(responses, request.method), `Unexpected native RPC: ${request.method}`);
    if (holdInitialize && request.method === "initialize") return;
    line({ jsonrpc: "2.0", id: request.id, result: responses[request.method] });
  };
  const trex = evaluate("trex", env, { "../api": { ...api, agentWrite },
    "./chatSession": { localId: () => `rpc-${++sequence}`, useAgentProcess: (_id, callbacks) => {
      handlers = callbacks; return { spawn: async () => "offline-process", isCurrent: id => id === "offline-process" };
    } }, "./useMessageQueue": { useMessageQueue: () => queue } });
  const { ChatPanel } = panelModule(env);
  const props = { ...baseProps(), provider: "trex", planningOnly: role === "planner",
    onWorkflowStatus: (_tab, _run, status, error) => {
      statuses.push({ status, error }); workflow = { ...workflow, status };
    }, onWorkflowPlan: (...args) => plans.push(args) };
  const render = () => {
    session = nativeHost.render(() => trex.useTrexChat(props));
    tree = panelHost.render(() => ChatPanel({ ...props, session, workflow }));
    return tree;
  };
  render();
  t.after(() => { env.timers.clear(); });
  return {
    render, queue, trace, writes, statuses, plans, correction, actions: nativeHost.actions,
    get tree() { return tree; }, get session() { return session; }, get workflow() { return workflow; },
    get starts() { return writes.filter(value => value.method === "turn/start"); },
    get interrupts() { return writes.filter(value => value.method === "turn/interrupt"); },
    async pump() { await flush(); render(); await flush(); render(); },
    async ready() { await session.start(); render(); },
    initialize(error) {
      const request = writes.findLast(value => value.method === "initialize");
      assert.ok(request, "the original send is waiting for its initialize reply");
      line({ jsonrpc: "2.0", id: request.id, ...(error
        ? { error: { code: -32000, message: error } } : { result: { protocolVersion: 1 } }) });
    },
    complete(id, status = "completed") { line({ method: "turn/completed", params: { sessionId: "offline-conversation", messageId: id, status } }); },
    answer(id, text) { line({ method: "message/delta", params: { sessionId: "offline-conversation", messageId: id, id: `${id}-answer`, text } }); },
    sendQueued() { return find(tree, node => node.type === uiModule("./chat/QueuedMessages").default).props.onSendNow(correction); },
    stop() { find(tree, node => node.type === "button" && node.props["aria-label"] === "Detener").props.onClick(); },
  };
}

for (const role of ["planner", "executor"]) {
  test(`legacy ${role}: queued Trex send now ignores its old interruption/late terminal and completes the replacement normally`, async t => {
    const h = trexWorkflow(t, role); await h.ready();
    assert.equal(await h.session.send("Old request", [], []), true); h.render();
    const oldId = h.starts[0].params.messageId;
    h.answer(oldId, "<trex_plan>Old plan must never transfer</trex_plan>"); h.render();
    const pending = h.sendQueued(); await h.pump();
    assert.equal(h.queue.snapshot.outbox.length, 1, "the correction is durably claimed while native cancellation is outstanding");
    assert.equal(h.session.state.lastCompletion.status, "interrupted", "actual sendNow produces the internal interruption");
    assert.deepEqual(h.session.state.lastCompletion.messageIds, [oldId]);
    assert.equal(h.starts.length, 1, "replacement waits for the native old terminal");
    assert.equal(h.interrupts.length, 1, "workflow must not issue an extra Stop that cancels the deferred correction");
    assert.deepEqual(h.statuses, []); assert.deepEqual(h.plans, []);

    h.complete(oldId, "interrupted"); await h.pump(); await pending; h.render();
    assert.equal(h.starts.length, 2, "the deferred replacement survives the workflow render");
    const newId = h.starts[1].params.messageId;
    assert.notEqual(newId, oldId);
    assert.equal(h.starts[1].params.text, h.correction.text);
    assert.equal(h.session.state.pendingTurns, 1);
    assert.deepEqual(h.session.state.pendingMessageIds, [newId]);
    assert.deepEqual(h.statuses, []); assert.deepEqual(h.plans, []);
    assert.deepEqual(h.queue.snapshot.outbox, []);
    assert.ok(h.trace.indexOf("claimDirect") < h.trace.indexOf("turn/interrupt"));
    assert.ok(h.trace.indexOf("turn/interrupt") < h.trace.lastIndexOf("turn/start"));
    assert.ok(h.trace.lastIndexOf("turn/start") < h.trace.indexOf("ackDirect"));

    const completion = h.session.state.lastCompletion;
    for (const status of ["completed", "interrupted", "failed"]) {
      h.complete(oldId, status); await h.pump();
      assert.equal(h.session.state.lastCompletion, completion, "late old terminals cannot replace the interruption or consume the replacement");
      assert.deepEqual(h.session.state.pendingMessageIds, [newId]);
      assert.deepEqual(h.statuses, []); assert.deepEqual(h.plans, []);
    }
    h.answer(newId, "<trex_plan>Implement only the corrected request</trex_plan>");
    h.complete(newId); await h.pump();
    assert.equal(h.session.state.lastCompletion.status, "completed");
    assert.deepEqual(h.session.state.lastCompletion.messageIds, [newId]);
    assert.equal(h.session.state.pendingTurns, 0);
    if (role === "planner") {
      assert.equal(h.plans.length, 1);
      assert.match(h.plans[0][2].content, /Implement only the corrected request/);
      assert.doesNotMatch(h.plans[0][2].content, /Old plan must never transfer/);
      assert.deepEqual(h.statuses, []);
    } else { assert.deepEqual(h.statuses.map(value => value.status), ["completed"]); assert.deepEqual(h.plans, []); }
    await h.pump();
    assert.equal(h.starts.length, 2, "no old request or queue wake is replayed");
  });
}

for (const role of ["planner", "executor"]) {
  for (const originalOutcome of ["initialization failure", "normal completion"]) {
    test(`legacy ${role}: rejected queued send now during initialization preserves the original ${originalOutcome}`, async t => {
      const h = trexWorkflow(t, role, { holdInitialize: true });
      const original = h.session.send("Original request still initializing", [], []);
      await h.pump();
      const [originalId] = h.session.state.pendingMessageIds;
      assert.ok(originalId);
      assert.equal(h.writes.filter(value => value.method === "initialize").length, 1);
      assert.equal(h.starts.length, 0, "the original message has not been issued to Trex");

      const direct = h.sendQueued().then(() => null, error => error);
      await h.pump();
      const rejected = await Promise.race([direct, flush().then(() => "still pending")]);
      assert.ok(rejected instanceof Error, "the real component promptly reports sendNow's preflight rejection");
      assert.match(rejected.message, /No se confirmó el envío directo/);
      assert.equal(h.interrupts.length, 0);
      assert.equal(h.actions.some(action => action.type === "interruptSend" || action.type === "cancelSend"), false,
        "rejecting the correction cannot mark the unissued original interrupted");
      assert.deepEqual(h.session.state.pendingMessageIds, [originalId]);
      assert.equal(h.session.state.lastCompletion, null);
      assert.deepEqual(h.statuses, []); assert.deepEqual(h.plans, []);
      const retained = structuredClone(h.queue.snapshot.outbox);
      assert.equal(retained.length, 1);
      assert.deepEqual(retained[0].message, h.correction);
      assert.deepEqual(h.queue.snapshot.messages, []);
      assert.equal(h.trace.includes("ackDirect"), false);

      if (originalOutcome === "initialization failure") {
        h.initialize("Original initialize was rejected");
        assert.equal(await original, false); await h.pump();
        assert.equal(h.session.state.lastCompletion.status, "failed");
        assert.deepEqual(h.session.state.lastCompletion.messageIds, [originalId]);
        assert.equal(h.session.state.pendingTurns, 0);
        assert.deepEqual(h.statuses.map(value => value.status), ["failed"],
          "a rejected correction must not suppress the original's real failure callback, even with the outbox retained");
        assert.equal(h.workflow.status, "failed");
        assert.deepEqual(h.plans, []);
        assert.equal(h.starts.length, 0);
      } else {
        h.initialize();
        assert.equal(await original, true); await h.pump();
        assert.equal(h.starts.length, 1);
        assert.equal(h.starts[0].params.messageId, originalId);
        h.answer(originalId, "<trex_plan>Original plan remains valid after the rejected correction</trex_plan>");
        h.complete(originalId); await h.pump();
        assert.equal(h.session.state.lastCompletion.status, "completed");
        assert.deepEqual(h.session.state.lastCompletion.messageIds, [originalId]);
        assert.equal(h.session.state.pendingTurns, 0);
        assert.deepEqual(h.statuses, []); assert.deepEqual(h.plans, []);
        assert.equal(h.workflow.status, role === "planner" ? "planning" : "executing",
          "successful completion waits for explicit review of the uncertain direct dispatch");
        // Resolve the durable uncertainty through the real queue client. This
        // proves success was deferred by busy, rather than consumed as superseded.
        await h.queue.client.ackDirect(retained[0].id); await h.pump();
        if (role === "planner") {
          assert.equal(h.plans.length, 1);
          assert.match(h.plans[0][2].content, /Original plan remains valid after the rejected correction/);
          assert.deepEqual(h.statuses, []);
        } else {
          assert.deepEqual(h.statuses.map(value => value.status), ["completed"]);
          assert.equal(h.workflow.status, "completed");
          assert.deepEqual(h.plans, []);
        }
      }
      if (originalOutcome === "initialization failure") assert.deepEqual(h.queue.snapshot.outbox, retained);
      assert.equal(h.interrupts.length, 0);
      assert.equal(h.starts.length, originalOutcome === "initialization failure" ? 0 : 1,
        "neither rejection nor later settlement replays the queued correction");
    });
  }
}

for (const boundary of ["waiting for old terminal", "replacement active"]) {
  test(`explicit Stop still pauses the legacy workflow (${boundary})`, async t => {
    const h = trexWorkflow(t); await h.ready();
    await h.session.send("Old request", [], []); h.render();
    const oldId = h.starts[0].params.messageId;
    const pending = h.sendQueued();
    const result = pending.then(() => null, error => error);
    await h.pump();
    if (boundary === "replacement active") { h.complete(oldId, "interrupted"); await h.pump(); await pending; h.render(); }
    h.stop(); await h.pump();
    assert.equal(h.workflow.status, "paused");
    assert.ok(h.statuses.some(value => value.status === "paused" && value.error === "Flujo detenido por ti."));
    assert.equal(h.plans.length, 0);
    if (boundary === "waiting for old terminal") {
      const outcome = await Promise.race([result, flush().then(() => "still pending")]);
      assert.ok(outcome instanceof Error, "explicit Stop promptly rejects the uncertain queue delivery");
      assert.equal(h.queue.snapshot.outbox.length, 1, "the unaccepted correction remains available for review");
      h.complete(oldId); await h.pump();
      assert.equal(h.starts.length, 1, "a late old success cannot release a stopped deferred replacement");
    } else {
      const newId = h.starts[1].params.messageId;
      h.complete(newId); await h.pump();
      assert.equal(h.session.state.lastCompletion.status, "interrupted");
      assert.equal(h.statuses.some(value => value.status === "completed"), false);
      assert.equal(h.starts.length, 2);
    }
    assert.equal(h.workflow.status, "paused");
  });
}

function roomHarness(t, scenario = {}) {
  const env = environment(), roomHost = host(t), panelHost = host(t), messages = [], calls = [];
  const { ChatPanel } = panelModule(env);
  const roomModule = evaluate("room", env, { "../api": {...api,...scenario.api}, "./ChatView": { ChatPanel },
    "../hooks/useClaudeChat": { useClaudeChat: forbidden("Claude runtime") },
    "../hooks/useCodexChat": { useCodexChat: forbidden("Codex runtime") },
    "../hooks/useAntigravityChat": { useAntigravityChat: forbidden("Antigravity hook outside its test host") },
    "../hooks/useTrexChat": { useTrexChat: forbidden("Trex runtime") } });
  const participant = role => ({ agent: { provider: "codex", profileId: `offline-${role}`, profileName: role,
    model: null, effort: null, launch: { command: null, args: null, shell: "powershell", env: null } }, conversationId: null, mode: "plan" });
  let room = { id: "offline-room", active: "planner", phase: "idle", cycle: 1, order: [],
    planner: participant("planner"), executor: participant("executor"), ...scenario.room };
  const sessions = Object.fromEntries(["planner", "executor"].map(role => {
    const queue = queueStore();
    Object.assign(queue.snapshot, scenario.queues?.[role]);
    return [role, { provider: "codex", state: { ...dependencies["../chatState"].initialChatState(), process: "ready",
      models: [{ value: "offline-next", displayName: "Offline next", efforts: [] }], ...scenario.states?.[role] }, queue,
      runCommand: (name, args) => { calls.push({ role, method: "runCommand", name, args }); return true; },
      setModel: value => calls.push({ role, method: "setModel", value }), interrupt: noop,
      send: async (...args) => { calls.push({ role, method: "send", args }); return true; },
      sendNow: forbidden("room sendNow"), edit: forbidden("room edit"), reset: forbidden("room reset"),
      notice: forbidden("room notice"), refreshSkills: forbidden("skills refresh") }];
  }));
  const props = { ...baseProps(), provider: "codex", onMessage: message => messages.push(message), onRoomChange: value => { room = value; } };
  let tree, panelProps;
  const renderRoom = () => { tree = roomHost.render(() => roomModule.default({ ...props, room })); };
  renderRoom();
  const runtimeQueueIds = ["planner", "executor"].map(role => find(tree, node => node.props?.role === role && !!node.props?.options).props.options.queueId);
  // Invoke the exact Runtime publish callback, without mounting any provider.
  for (const role of ["planner", "executor"]) {
    find(tree, node => typeof node.type === "function" && node.props.role === role && !!node.props.publish).props.publish(role, sessions[role]);
  }
  renderRoom();
  panelProps = find(tree, node => node.type === ChatPanel).props;
  const renderPanel = () => { tree = panelHost.render(() => ChatPanel(panelProps)); return tree; };
  renderPanel();
  return { calls, messages, sessions, runtimeQueueIds, get panelProps(){return panelProps;}, get room(){return room;}, renderPanel,
    publish(role, state) {
      sessions[role] = { ...sessions[role], state };
      renderRoom();
      find(tree, node => typeof node.type === "function" && node.props.role === role && !!node.props.publish).props.publish(role, sessions[role]);
      renderRoom(); panelProps = find(tree, node => node.type === ChatPanel).props; renderPanel();
    },
    async pump(){for(let i=0;i<6;i++){await flush();renderRoom();panelProps=find(tree,node=>node.type===ChatPanel).props;renderPanel();}},
    type(value) { find(tree, node => node.type === "textarea").props.onChange({ target: { value, selectionStart: value.length } }); renderPanel(); },
    submit() { find(tree, node => node.type === "form").props.onSubmit({ preventDefault: noop }); renderPanel(); },
    get draft() { return find(tree, node => node.type === "textarea").props.value; },
  };
}

test("planning room participants bind distinct queues accepted by the native inbox", t => {
  const h = roomHarness(t);
  assert.deepEqual(h.runtimeQueueIds, ["t-offline-room-planner", "t-offline-room-executor"]);
});

test("newly configured room stays idle until a normal chat message starts its first planning cycle",async t=>{
  const contexts=[];const prepared=context=>({id:"first-chat-idea",content:context.content,sourceLabel:"planner",sourceProvider:"codex",sourceSessionId:"planner",createdAt:1,cwd:"D:/test",truncated:false});
  let saved;
  const h=roomHarness(t,{room:{phase:"idle",cycle:0},api:{prepareHandoff:async context=>{contexts.push(context);saved=prepared(context);return saved;},loadHandoff:async()=>saved}});
  await h.pump();assert.equal(h.calls.filter(call=>call.method==="send").length,0);assert.equal(contexts.length,0);
  h.type("Build my idea and prepare a plan");h.submit();await h.pump();
  assert.equal(contexts.length,1);assert.match(contexts[0].content,/Build my idea/);assert.equal(h.room.cycle,1);assert.equal(h.room.phase,"planning");
  const sends=h.calls.filter(call=>call.method==="send");assert.equal(sends.length,1);assert.equal(sends[0].role,"planner");assert.match(sends[0].args[0],/trex_plan/);assert.equal(sends[0].args[3],"Build my idea and prepare a plan");assert.equal(h.draft,"");
});
test("a completed planner transfers confirmed tasks and the executor receives instructions to maintain its own list", async t => {
  const contexts = [], saved = new Map();
  const h = roomHarness(t, { room: { phase: "idle", cycle: 0 }, api: {
    prepareHandoff: async context => { const value = { id: `handoff-${contexts.length}`, ...context, sourceLabel: "planner", sourceProvider: "codex", sourceSessionId: "planner", cwd: "D:/test" }; contexts.push(context); saved.set(value.id, value); return value; },
    loadHandoff: async id => saved.get(id),
  } });
  h.type("Implement the feature"); h.submit(); await h.pump();
  const user = { kind: "user", id: "request", text: "Implement the feature", images: 0, previews: [] };
  const tasks = { kind: "tool", id: "tasks", name: "TodoWrite", status: "done", input: { todos: [{ content: "Implement", status: "pending" }, { content: "Validate", status: "pending" }] }, output: null, patch: null };
  const final = { kind: "text", id: "plan", messageId: "answer", text: "<trex_plan>Implement and validate.</trex_plan>", final: true };
  const state = { ...h.sessions.planner.state, items: [user, tasks, final], lastCompletion: { id: "complete", status: "completed", messageIds: ["request"], itemIds: ["tasks", "plan"] } };
  h.publish("planner", state); await h.pump();
  assert.equal(contexts.length, 2);
  assert.match(contexts[1].content, /\[pending\] Implement/);
  assert.match(contexts[1].content, /\[pending\] Validate/);
  const send = h.calls.find(call => call.role === "executor" && call.method === "send");
  assert.ok(send); assert.match(send.args[0], /publica en tus herramientas de tareas/);
  assert.deepEqual(h.panelProps.taskPlan.map(task => [task.title, task.owner]), [["Implement", "planner"], ["Validate", "planner"]]);
});
test("first chat preparation failure preserves the idea and inherited context without provider delivery",async t=>{
  const h=roomHarness(t,{room:{phase:"idle",cycle:0,setupContext:{id:"prior",pending:false,sourceLabel:"Earlier"}},api:{loadHandoff:async()=>({content:"Retained earlier discussion"}),prepareHandoff:async()=>{throw new Error("Preparation unavailable");}}});
  h.type("Keep my idea");h.submit();await h.pump();assert.equal(h.draft,"Keep my idea");assert.equal(h.calls.filter(call=>call.method==="send").length,0);assert.equal(h.room.setupContext.id,"prior");
});
const queued = { id: "pending-message", text: "Must remain pending", images: [], previews: [], createdAt: 1 };
const guards = [
  ["paused room", { room: { phase: "paused" } }],
  ["failed room", { room: { phase: "failed" } }],
  ["active-agent outbox", { queues: { planner: { outbox: [{ id: "uncertain", message: queued, predecessors: [] }] } } }],
  ["peer outbox", { queues: { executor: { outbox: [{ id: "uncertain", message: queued, predecessors: [] }] } } }],
  ["queued clarification", { queues: { planner: { messages: [queued] } } }],
  ["peer inbox receipt", { queues: { executor: { receipt: { id: "receipt", messages: [queued] } } } }],
  ["busy active agent", { states: { planner: { pendingTurns: 1, pendingMessageIds: ["active"] } } }],
  ["busy peer", { states: { executor: { pendingTurns: 1, pendingMessageIds: ["active"] } } }],
  ["pending transfer", { room: { phase: "paused", pending: { id: "handoff", role: "planner", reference: { id: "handoff", pending: true } } } }],
];
for (const [label, scenario] of guards) {
  test(`room ${label}: /init keeps its exact draft without any provider call; direct runCommand also refuses it`, t => {
    const h = roomHarness(t, scenario), before = structuredClone(Object.fromEntries(Object.entries(h.sessions).map(([role, session]) => [role, session.queue.snapshot])));
    const draft = "  /init  ";
    h.type(draft); h.submit();
    assert.equal(h.draft, draft);
    assert.deepEqual(h.calls, [], "the composer must guard before runLocal can call the provider");
    assert.equal(h.panelProps.session.runCommand("init", ""), true, "blocked local commands are consumed defensively");
    assert.deepEqual(h.calls, [], "direct aggregate callers must not bypass the same guard");
    assert.ok(h.messages.some(value => /pendientes|sala/.test(value)));
    assert.deepEqual(Object.fromEntries(Object.entries(h.sessions).map(([role, session]) => [role, session.queue.snapshot])), before);
  });
}

for (const [label, scenario] of guards.slice(0, 8)) {
  test(`room ${label}: safe /model still changes the selection and clears its draft`, t => {
    const h = roomHarness(t, scenario);
    assert.equal(h.panelProps.localCommandReason("model", "offline-next"), null);
    h.type("/model offline-next"); h.submit();
    assert.equal(h.draft, "");
    assert.deepEqual(h.calls, [{ role: "planner", method: "setModel", value: "offline-next" }]);
    assert.deepEqual(h.messages, []);
  });
}

test("ready room without pending work still permits /init through the real composer and aggregate", t => {
  const h = roomHarness(t);
  assert.equal(h.panelProps.localCommandReason("init", ""), null);
  h.type("/init"); h.submit();
  assert.equal(h.draft, "");
  assert.deepEqual(h.calls, [{ role: "planner", method: "runCommand", name: "init", args: "" }]);
  assert.deepEqual(h.messages, []);
});

// --- Token-efficient room deliveries ---
function recordingApi(extra = {}) {
  const contexts = [], gits = [], loads = [], saved = new Map(Object.entries(extra));
  return { contexts, gits, loads, api: {
    prepareHandoff: async (context, options) => {
      const value = { id: `handoff-${contexts.length}`, ...context, sourceLabel: "room", sourceProvider: "codex", sourceSessionId: "room", cwd: "D:/test" };
      contexts.push(context); gits.push(options?.git ?? "full"); saved.set(value.id, value); return value;
    },
    loadHandoff: async id => { loads.push(id); return saved.get(id); },
  } };
}
const roomUser = (id, text) => ({ kind: "user", id, text, images: 0, previews: [] });
const roomText = (id, text) => ({ kind: "text", id, messageId: id, text, final: true });
const roomTool = id => ({ kind: "tool", id, name: "Bash", input: { command: "npm test" }, output: "42 passing", status: "done", patch: null });

test("a later message to the same agent carries only the other agent's new entries, without the full history", async t => {
  const rec = recordingApi();
  const plannerItems = [roomUser("p-user", "Planifica el login"), roomText("p-reply", "PLANNER_OWN_REASONING")];
  const executorItems = [roomUser("e-user", "Implementa"), roomTool("e-tool"), roomText("e-reply", "EXECUTOR_RESULT: login listo")];
  const h = roomHarness(t, { room: { phase: "completed", cycle: 1, active: "planner", delivered: { planner: "planner::p-reply" } }, api: rec.api,
    states: { planner: { items: plannerItems }, executor: { items: executorItems } } });
  await h.pump();
  h.type("Revisa el resultado"); h.submit(); await h.pump();
  assert.equal(rec.contexts.length, 1);
  const content = rec.contexts[0].content;
  assert.match(content, /^# Solicitud actual del usuario\n\nRevisa el resultado/);
  assert.match(content, /## Novedades de Ejecutor · executor desde tu última entrega/);
  assert.match(content, /EXECUTOR_RESULT/); assert.match(content, /npm test/);
  assert.doesNotMatch(content, /PLANNER_OWN_REASONING|# Continuidad del proyecto/, "its own conversation already has them");
  assert.equal(rec.gits[0], "status", "the other agent worked: branch and status, no diffs");
  const send = h.calls.find(call => call.role === "planner" && call.method === "send");
  assert.ok(send); assert.equal(send.args[3], "Revisa el resultado");
  assert.equal(h.room.delivered.planner, "executor::e-reply", "the accepted delivery advances the cursor");
});

test("a planning follow-up without new work sends no Git snapshot and only a short stage reminder", async t => {
  const rec = recordingApi();
  const h = roomHarness(t, { room: { phase: "waiting", cycle: 1, active: "planner", delivered: { planner: "planner::p-reply" } }, api: rec.api,
    states: { planner: { items: [roomUser("p-user", "Planifica"), roomText("p-reply", "¿Opción A o B?")] } } });
  await h.pump();
  h.type("Usa la opción B"); h.submit(); await h.pump();
  assert.equal(rec.gits[0], "none");
  assert.doesNotMatch(rec.contexts[0].content, /Novedades de/);
  const send = h.calls.find(call => call.role === "planner" && call.method === "send");
  assert.match(send.args[0], /Sigues en la etapa de planificación/);
  assert.doesNotMatch(send.args[0], /Tu única etapa es planificar/);
  assert.match(send.args[0], /trex_plan/);
});

test("the executor receives the request, plan and tasks with a Git status, never the planner's transferred history", async t => {
  const rec = recordingApi();
  const prior = [roomUser("old-user", "Tarea anterior"), roomText("old-reply", "PRIOR_EXECUTOR_HISTORY ".repeat(40))];
  const h = roomHarness(t, { room: { phase: "idle", cycle: 0 }, api: rec.api, states: { executor: { items: prior } } });
  h.type("Implement the feature"); h.submit(); await h.pump();
  assert.match(rec.contexts[0].content, /PRIOR_EXECUTOR_HISTORY/, "the planner's first delivery carries the context it lacks");
  assert.equal(rec.gits[0], "full");
  const user = { kind: "user", id: "request", text: "Implement the feature", images: 0, previews: [] };
  const tasks = { kind: "tool", id: "tasks", name: "TodoWrite", status: "done", input: { todos: [{ content: "Implement", status: "pending" }] }, output: null, patch: null };
  const final = { kind: "text", id: "plan", messageId: "answer", text: "<trex_plan>Implement and validate.</trex_plan>", final: true };
  h.publish("planner", { ...h.sessions.planner.state, items: [user, tasks, final], lastCompletion: { id: "complete", status: "completed", messageIds: ["request"], itemIds: ["tasks", "plan"] } });
  await h.pump();
  assert.equal(rec.contexts.length, 2);
  const executor = rec.contexts[1].content;
  assert.match(executor, /# Plan definitivo para implementar\n\nImplement and validate\./);
  assert.match(executor, /## Solicitud original del usuario\n\nImplement the feature/);
  assert.match(executor, /\[pending\] Implement/);
  assert.doesNotMatch(executor, /PRIOR_EXECUTOR_HISTORY|# Continuidad del proyecto|# Solicitud actual del usuario/);
  assert.equal(rec.gits[1], "status");
  assert.ok(h.calls.some(call => call.role === "executor" && call.method === "send"));
  assert.equal(typeof h.room.delivered.executor, "string", "later messages to the executor are incremental");
});

test("an inherited chat is delivered only to the role that does not resume it", async t => {
  const rec = recordingApi({ prior: { id: "prior", content: "INHERITED_CHAT\n\n---\n## Estado del proyecto capturado por TREX\nSTALE_GIT", sourceLabel: "Earlier" } });
  const h = roomHarness(t, { room: { phase: "idle", cycle: 0, active: "executor", setupContext: { id: "prior", pending: false, sourceLabel: "Earlier" }, setupRole: "planner" },
    api: rec.api, states: { executor: { items: [roomUser("source-user", "Conversación original"), roomText("source-reply", "Respuesta original")] } } });
  h.type("@ejecutor Continúa con los tests"); h.submit(); await h.pump();
  assert.ok(!rec.loads.includes("prior"), "the resumed source conversation does not receive its own history again");
  assert.doesNotMatch(rec.contexts[0].content, /INHERITED_CHAT|Respuesta original/);
  assert.equal(h.room.setupContext?.id, "prior", "the setup waits for the other role");
  h.publish("executor", { ...h.sessions.executor.state, items: [...h.sessions.executor.state.items, roomUser("e-new", "Continúa con los tests"), roomText("e-done", "Tests listos")],
    lastCompletion: { id: "done", status: "completed", messageIds: ["e-new"], itemIds: ["e-done"] } });
  await h.pump();
  h.type("@planificador Revisa la cobertura"); h.submit(); await h.pump();
  const planner = rec.contexts.at(-1).content;
  assert.match(planner, /## Contexto anterior del chat\n\nINHERITED_CHAT/);
  assert.doesNotMatch(planner, /STALE_GIT/, "the delivery attaches its own current snapshot");
  assert.equal(h.room.setupContext, null);
});
