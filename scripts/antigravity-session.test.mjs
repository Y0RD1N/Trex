import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { load } from "./ts-loader.mjs";
const names = ["acpProtocol", "antigravityChat", "antigravityUsage", "chatState", "chatTimes", "browser", "integrations", "accessibility", "sharedFiles", "messageQueue", "coordination"];
const deps = Object.fromEntries(await Promise.all(names.map(async name => ["../" + name, await load(name)])));
const { AcpConnection } = deps["../acpProtocol"];
const { INBOX_WAKE } = deps["../messageQueue"];
const compiled = ts.transpileModule(await readFile(new URL("../src/hooks/useAntigravityChat.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const compile = new Function("require", "exports", compiled);
const tick = () => new Promise(resolve => setImmediate(resolve));
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const modelOptions = [{ id: "model", type: "select", category: "model", currentValue: "account-model", options: [{ value: "account-model", name: "Account model" }, { value: "other-model", name: "Other model" }] }];

function harness(t, extra = {}) {
  const slots = [], effects = [], writes = [], acks = [], connections = [], mcpQueries = [];
  let cursor = 0, serial = 0, session, queueId;
  let receipt = extra.receipt ?? null;
  const hooks = {
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useState(value) { const slot = slots[cursor++] ??= { value }; return [slot.value, next => { slot.value = typeof next === "function" ? next(slot.value) : next; }]; },
    useReducer(reducer, value, init) { const slot = slots[cursor++] ??= { value: init(value) }; return [slot.value, action => { slot.value = reducer(slot.value, action); if (action.type === "acpFinished") extra.onFinished?.(); }]; },
    useEffect(effect, dependencies) { const i = cursor++; if (!same(slots[i]?.dependencies, dependencies)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { dependencies, cleanup: effect() }; }); },
  };
  const queue = { ready: true, snapshot: { messages: [], receipt: null }, client: {
    read: async () => ({ messages: [], receipt }),
    ack: async (id, guard) => { if (!guard || guard()) { acks.push(id); receipt = null; } },
  } };
  const respond = (entry, request, result) => entry.rpc.accept(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  const open = async (_command, _configDir, _cwd, callbacks, signal) => {
    const entry = { callbacks, closed: false, index: connections.length };
    entry.rpc = new AcpConnection({ write: async line => {
      if (extra.failWrite && JSON.parse(line).method === "session/prompt") throw Error("native pipe failed");
      const request = JSON.parse(line); writes.push({ ...request, generation: entry.index });
      if (!request.method) return;
      if (request.method === "session/new" || request.method === "session/load") {
        if (extra.authRequired && !entry.authenticated) {
          entry.rpc.accept(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } })); return;
        }
        if (extra.holdNew) { entry.held = request; return; }
        // Al recuperar una sesión, Antigravity repite su historial (los mensajes del usuario incluidos).
        if (request.method === "session/load" && extra.replayText) callbacks.notification("session/update", { sessionId: "opaque-session", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: extra.replayText } } });
        if (extra.usageReport) {
          callbacks.notification("session/update", { sessionId: "opaque-session", update: { sessionUpdate: "usage_update", used: 0, size: 1048576 } });
          const announce = () => callbacks.notification("session/update", { sessionId: "opaque-session", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "usage" }] } });
          if (extra.delayedCommands) setImmediate(announce); else announce();
        }
        respond(entry, request, { sessionId: "opaque-session", configOptions: modelOptions, modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "plan", name: "Plan" }] } });
      }
      if (request.method === "authenticate") { entry.authenticated = true; respond(entry, request, {}); }
      if (request.method === "session/prompt" && extra.authOnPrompt && !entry.authenticated)
        entry.rpc.accept(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } }));
      if (request.method === "session/prompt" && request.params.prompt?.[0]?.text === "/usage" && extra.usageReport && !extra.holdUsage) {
        callbacks.notification("session/update", { sessionId: "opaque-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: extra.usageReport } } });
        respond(entry, request, { stopReason: "end_turn" });
      }
      if (request.method === "session/set_config_option") respond(entry, request, { configOptions: modelOptions.map(c => ({ ...c, currentValue: request.params.value })) });
      if (request.method === "session/set_mode") respond(entry, request, {});
      if (request.method === "session/cancel" && extra.autoCancel) { const prompt = writes.findLast(w => w.method === "session/prompt" && w.generation === entry.index); if (prompt) respond(entry, prompt, { stopReason: "cancelled" }); }
    } }, callbacks.notification, callbacks.request);
    entry.init = { agentInfo: { name: "antigravity-acp" }, agentCapabilities: { loadSession: true, promptCapabilities: { image: extra.imageSupported ?? true } }, authMethods: [{ id: "oauth-personal", name: "Google" }] };
    entry.close = async () => { entry.closed = true; entry.rpc.close(); };
    signal.addEventListener("abort", () => { void entry.close(); }, { once: true });
    connections.push(entry); return entry;
  };
  const api = { formatError: error => error.message ?? String(error), installAntigravity: async () => {},
    messageQueueMcpConfig: async (id, tasksOnly) => { mcpQueries.push({ id, tasksOnly }); return { "mcp_servers.trex_inbox.command": "C:/Trex/trex.exe", "mcp_servers.trex_inbox.args": ["--trex-inbox-mcp", "data", id, "--tasks-only"] }; },
    trexDesktopMcpConfig: async () => ({ command: "desktop", args: ["mcp"] }),
  };
  const exports = {};
  compile(name => name === "react" ? hooks : name === "../api" ? api : name === "../antigravityConnection" ? { openAntigravity: open }
    : name === "../browserConnection" ? { connectBrowser: async options => options?.enabled ? { command: "browser", args: ["--client", options.clientId, "--profile", options.profile] } : null }
      : name === "./chatSession" ? { localId: () => `local-${++serial}` } : name === "./useMessageQueue" ? { useMessageQueue: id => { queueId = id; return queue; } }
        : deps[name] ?? (() => { throw Error(`Unexpected hook import: ${name}`); })(), exports);
  const options = { sessionId: "tab-one", cwd: "C:/project", command: "antigravity-acp", args: "", shell: "", env: null, conversationId: null, mode: null, visible: false, onRunning() {}, onExit() {}, ...extra.options };
  const render = () => { cursor = 0; session = exports.useAntigravityChat(options); for (const effect of effects.splice(0)) effect(); return session; };
  const dispose = () => { for (const slot of slots) slot?.cleanup?.(); };
  t.after(dispose); render();
  return { writes, acks, connections, mcpQueries, options, dispose, render,
    get session() { return render(); }, get state() { return render().state; }, get queueId() { return queueId; },
    async start() { await render().start(); render(); },
    async complete(result = { stopReason: "end_turn" }) { const request = writes.findLast(w => w.method === "session/prompt"), entry = connections[request.generation]; respond(entry, request, result); await tick(); render(); },
    update(update, entry = connections.at(-1)) { entry.callbacks.notification("session/update", { sessionId: "opaque-session", update }); render(); },
    requestPermission(id, toolCall, permissionOptions) { connections.at(-1).callbacks.request(id, "session/request_permission", { sessionId: "opaque-session", toolCall, options: permissionOptions }); render(); },
  };
}
test("Antigravity starts without inference and binds only the selected chat's tools", async t => {
  const h = harness(t, { options: { browser: { enabled: true, clientId: "client-a", profile: "BROWSER4" }, desktopEnabled: true } }); await h.start();
  assert.equal(h.writes.some(w => w.method === "session/prompt"), false);
  const servers = h.writes.find(w => w.method === "session/new").params.mcpServers;
  assert.deepEqual(servers.map(s => s.name), ["trex_inbox", "trex_browser", "trex_desktop"]);
  assert.deepEqual(h.mcpQueries, [{ id: "t-tab-one", tasksOnly: true }]);
  assert.deepEqual(servers[1].args, ["--client", "client-a", "--profile", "BROWSER4"]);
  assert.deepEqual(h.session.modes.map(m => m.value), ["ask"]);
});

const usageReport = "### Session Usage\n- **Session total:** data not available yet\n\n### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 95% remaining (resets Nov 01, 2026, 16:02 UTC)";
test("early context and commands survive startup and native usage never enters the chat", async t => {
  const h = harness(t, { usageReport }); await h.start(); await tick();
  assert.equal(h.state.usage.window,1048576); assert.equal(h.state.usage.used,0);
  assert.equal(h.state.plan.windows[0].percent,5);
  assert.equal(h.state.items.length,0); assert.equal(h.state.lastCompletion,null);
  assert.deepEqual(h.writes.filter(w=>w.method==="session/prompt").map(w=>w.params.prompt),[[{type:"text",text:"/usage"}]]);
});
test("commands announced after session/new still trigger the initial quota read", async t => {
  const h = harness(t, { usageReport, delayedCommands: true }); await h.start(); await tick(); h.render(); await tick();
  assert.equal(h.state.plan.windows[0].percent,5);
  assert.equal(h.writes.filter(w=>w.method==="session/prompt").length,1);
  assert.equal(h.state.items.length,0);
});
test("a user turn waits for metadata and never overlaps the session's usage command", async t => {
  const h = harness(t,{usageReport,holdUsage:true}); await h.start(); await tick();
  const send = h.session.send("Real message",[],[]); await tick();
  assert.equal(h.writes.filter(w=>w.method==="session/prompt").length,1);
  h.update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:usageReport}});
  await h.complete(); assert.equal(await send,true);
  assert.equal(h.writes.filter(w=>w.method==="session/prompt").length,2);
  assert.deepEqual(h.state.items.filter(i=>i.kind==="user").map(i=>i.text),["Real message"]);
  await h.complete();
});
test("Direct messages deliver text, files and real image blocks and finish only on the terminal reply", async t => {
  const h = harness(t); await h.start();
  assert.equal(await h.session.send("Mira [Imagen 1]\nArchivos adjuntos:\n[Archivo 1]: C:/test.txt", [{ mediaType: "image/png", data: "aGVsbG8=" }], ["data:image/png;base64,aGVsbG8="]), true);
  const prompt = h.writes.find(w => w.method === "session/prompt").params.prompt;
  assert.ok(prompt.some(p => p.type === "image" && p.data === "aGVsbG8="));
  assert.ok(prompt.some(p => p.type === "text" && p.text.includes("C:/test.txt")));
  h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Revisado" } });
  assert.equal(h.state.pendingTurns, 1); await h.complete(); assert.equal(h.state.lastCompletion.status, "completed");
});
test("Queued messages keep their image association, file references, order and receipt until delivery completes", async t => {
  const receipt = { id: "receipt-a", messages: [
    { id: "q1", text: "Primera [Imagen 1]", images: [{ mediaType: "image/png", data: "b25l" }], previews: ["image-one"] },
    { id: "q2", text: "Segunda [Imagen 1]\n[Archivo 1]: C:/second.txt", images: [{ mediaType: "image/png", data: "dHdv" }], previews: ["image-two"] },
  ] };
  const h = harness(t, { receipt }); await h.start(); assert.equal(await h.session.send(INBOX_WAKE, [], []), true);
  const prompt = h.writes.find(w => w.method === "session/prompt").params.prompt;
  const first = prompt.findIndex(p => p.text?.includes("Mensaje 1")), second = prompt.findIndex(p => p.text?.includes("Mensaje 2"));
  assert.equal(prompt[first + 1].data, "b25l"); assert.equal(prompt[second + 1].data, "dHdv"); assert.ok(prompt[second].text.includes("C:/second.txt"));
  assert.equal(h.acks.length, 0); await h.complete(); assert.deepEqual(h.acks, ["receipt-a"]);
  assert.deepEqual(h.state.items.filter(i => i.kind === "user").map(i => [i.id, i.fromQueue]), [["q1", true], ["q2", true]]);
});
test("Stop cancels the owned turn, retains uncertain queued delivery and never auto-approves a question", async t => {
  const h = harness(t, { receipt: { id: "retained", messages: [{ id: "q", text: "Keep", images: [], previews: [] }] } }); await h.start(); await h.session.send(INBOX_WAKE, [], []);
  h.requestPermission(80, { toolCallId: "interaction_1", title: "Elige un color" }, [{ optionId: "blue", name: "Azul", kind: "allow_once" }, { optionId: "red", name: "Rojo", kind: "allow_once" }]);
  assert.equal(h.state.items.find(i => i.kind === "permission").toolName, "AskUserQuestion");
  h.session.interrupt(); await tick(); assert.ok(h.writes.some(w => w.method === "session/cancel"));
  assert.ok(h.writes.some(w => w.id === 80 && w.result?.outcome.outcome === "cancelled"));
  await h.complete({ stopReason: "cancelled" }); assert.equal(h.state.lastCompletion.status, "interrupted"); assert.deepEqual(h.acks, []);
});
test("Permission answers preserve the server option IDs and cannot approve another session's request", async t => {
  const h = harness(t); await h.start(); await h.session.send("Run tests", [], []);
  h.requestPermission("p", { toolCallId: "run", title: "npm test", rawInput: { command: "npm test" } }, [{ optionId: "server-allow", name: "Allow", kind: "allow_once" }, { optionId: "server-deny", name: "Deny", kind: "reject_once" }]);
  const item = h.state.items.find(i => i.kind === "permission"); h.session.answer(item, true, false); await tick();
  assert.ok(h.writes.some(w => w.id === "p" && w.result?.outcome.optionId === "server-allow")); await h.complete();
});
test("Explicit Google authentication initializes the session without sending a model prompt", async t => {
  const h = harness(t, { authRequired: true }); await assert.rejects(h.start(), /Authentication/);
  const actions = h.session.setup.actions; assert.equal(actions[0].label, "Iniciar sesión con Google"); await actions[0].run();
  assert.equal(h.state.process, "ready"); assert.equal(h.writes.filter(w => w.method === "authenticate").length, 1); assert.equal(h.writes.filter(w => w.method === "session/prompt").length, 0);
});
test("Authentication deferred until the first prompt still exposes Google's sign-in action", async t => {
  const h = harness(t, { authOnPrompt: true }); await h.start(); await h.session.send("Preserve this request", [], []); await tick();
  assert.equal(h.state.lastCompletion.status, "failed"); assert.equal(h.session.setup.actions[0].label, "Iniciar sesión con Google");
  await h.session.setup.actions[0].run(); assert.equal(h.state.process, "ready");
});
test("Unverified planning roles fail before starting a native process", async t => {
  const h = harness(t, { options: { planningOnly: true } }); await assert.rejects(h.start(), /solo lectura/); assert.equal(h.connections.length, 0);
});
test("A native write failure leaves the message unsent and does not confirm a receipt", async t => {
  const h = harness(t, { failWrite: true }); await h.start(); assert.equal(await h.session.send("Keep draft", [], []), false); await tick();
  assert.equal(h.state.lastCompletion.status, "failed"); assert.deepEqual(h.acks, []);
});
test("Unmounted or replaced processes cannot confirm a receipt through late responses", async t => {
  const h = harness(t, { receipt: { id: "r", messages: [{ id: "q", text: "Keep", images: [], previews: [] }] } }); await h.start(); await h.session.send(INBOX_WAKE, [], []);
  h.dispose(); await tick(); assert.deepEqual(h.acks, []); assert.equal(h.connections[0].closed, true);
});
test("Send-now waits for the cancelled turn before issuing its replacement", async t => {
  const h = harness(t, { autoCancel: true }); await h.start(); await h.session.send("Old", [], []); assert.equal(await h.session.sendNow("Replacement", [], []), true);
  assert.deepEqual(h.writes.filter(w => w.method === "session/prompt").map(w => w.params.prompt.at(-1).text), ["Old", "Replacement"]);
  await h.complete(); assert.equal(h.state.lastCompletion.status, "completed");
});
test("Two simultaneous chats isolate their browser bindings, queues, updates and cancellation", async t => {
  const a = harness(t, { options: { sessionId: "one", browser: { enabled: true, clientId: "client-one", profile: "BROWSER5" } } });
  const b = harness(t, { options: { sessionId: "two", browser: { enabled: true, clientId: "client-two", profile: "BROWSER6" } } });
  await Promise.all([a.start(), b.start()]); await Promise.all([a.session.send("One", [], []), b.session.send("Two", [], [])]);
  assert.notEqual(a.queueId, b.queueId);
  assert.notDeepEqual(a.writes.find(w => w.method === "session/new").params.mcpServers[1].args, b.writes.find(w => w.method === "session/new").params.mcpServers[1].args);
  a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Only one" } });
  assert.equal(b.state.items.some(i => i.text === "Only one"), false);
  a.session.interrupt(); await tick(); assert.equal(b.writes.some(w => w.method === "session/cancel"), false);
  await Promise.all([a.complete({ stopReason: "cancelled" }), b.complete()]);
});
test("Stop while session initialization is pending cannot send that message later", async t => {
  const h = harness(t, { holdNew: true });
  const pending = h.session.send("Do not deliver", [], []); await tick();
  h.session.interrupt(); assert.equal(await pending, false);
  assert.equal(h.writes.some(w => w.method === "session/prompt"), false);
});
test("Unsupported images and invalid terminal replies preserve durable queue receipts", async t => {
  const receipt = { id: "never-drop", messages: [{ id: "q", text: "Image", images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], previews: ["preview"] }] };
  const unsupported = harness(t, { imageSupported: false, receipt }); await unsupported.start();
  assert.equal(await unsupported.session.send(INBOX_WAKE, [], []), false); assert.equal(unsupported.writes.some(w => w.method === "session/prompt"), false); assert.deepEqual(unsupported.acks, []);
  const invalid = harness(t, { receipt }); await invalid.start(); await invalid.session.send(INBOX_WAKE, [], []); await invalid.complete({});
  assert.equal(invalid.state.lastCompletion.status, "failed"); assert.deepEqual(invalid.acks, []);
});
test("Late callbacks from a replaced generation do not mutate its recovered history", async t => {
  const h = harness(t); await h.start(); const old = h.connections[0];
  await h.session.start(); old.callbacks.notification("session/update", { sessionId: "opaque-session", update: { sessionUpdate: "current_mode_update", currentModeId: "WRONG" } });
  assert.notEqual(h.state.permissionMode, "WRONG"); assert.equal(old.closed, true);
});
test("A completed turn releases its busy state before the composer wakes the next queued turn", async t => {
  let h, followup;
  h = harness(t, { onFinished: () => { followup = h.session.send("Next queued message", [], []); } });
  await h.start(); await h.session.send("First", [], []); await h.complete();
  assert.equal(await followup, true); assert.equal(h.writes.filter(w => w.method === "session/prompt").length, 2);
});

const contextPrompts = h => h.writes.filter(w => w.method === "session/prompt").map(w => w.params.prompt.some(part => part.text?.startsWith("<trex_context>")));
test("the trex context is sent with the first prompt of each ACP session, not with every prompt", async t => {
  const h = harness(t); await h.start();
  await h.session.send("Primero", [], []); await h.complete();
  await h.session.send("Segundo", [], []); await h.complete();
  assert.deepEqual(contextPrompts(h), [true, false]);
  await h.session.start(); await h.session.send("Tras reconectar", [], []); await h.complete();
  assert.deepEqual(contextPrompts(h), [true, false, true], "a reloaded session receives it again");
});
test("a reloaded session whose history already carries the same context does not get it again", async t => {
  const extra = {};
  const h = harness(t, extra); await h.start();
  await h.session.send("Primero", [], []); await h.complete();
  const sent = h.writes.find(w => w.method === "session/prompt").params.prompt[0].text;
  extra.replayText = `${sent}Primero`;
  await h.session.start(); await h.session.send("Tras reconectar", [], []); await h.complete();
  assert.deepEqual(contextPrompts(h), [true, false], "the replayed history already has it");
  // Si el contexto cambió (otras integraciones), se envía el nuevo.
  extra.replayText = "<trex_context>\nanterior\n</trex_context>Hola";
  await h.session.start(); await h.session.send("Con otro contexto", [], []); await h.complete();
  assert.deepEqual(contextPrompts(h), [true, false, true]);
});
test("a failed first prompt carries the context again on the next one", async t => {
  const h = harness(t); await h.start();
  await h.session.send("Falla", [], []); await h.complete({});
  assert.equal(h.state.lastCompletion.status, "failed");
  await h.session.send("Reintento", [], []); await h.complete();
  assert.deepEqual(contextPrompts(h), [true, true]);
});
test("browser guidance enters the context only when a browser is attached", async t => {
  const plain = harness(t); await plain.start(); await plain.session.send("Hola", [], []);
  const text = plain.writes.find(w => w.method === "session/prompt").params.prompt[0].text;
  assert.doesNotMatch(text, /Trex Browser|browser_navigate/);
  assert.ok(Buffer.byteLength(text) < 2_000, `compact context (${Buffer.byteLength(text)} B)`);
  await plain.complete();
  const attached = harness(t, { options: { browser: { enabled: true, clientId: "client-b", profile: "BROWSER2" } } }); await attached.start(); await attached.session.send("Hola", [], []);
  assert.match(attached.writes.find(w => w.method === "session/prompt").params.prompt[0].text, /browser_navigate/);
  await attached.complete();
});
