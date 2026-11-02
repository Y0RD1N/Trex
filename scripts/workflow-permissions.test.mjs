import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

// Run the actual hooks, protocol encoders and reducers. No process or model is started.
const modules = ["chatMessages", "chatCommands", "chatState", "chatTimes", "claudeChat", "codexChat", "messageQueue", "inboxProtocol", "workflowSafety", "browser", "sharedFiles", "chatQuestions", "agentTeam", "chatTasks", "integrations"];
const dependencies = Object.fromEntries(await Promise.all(modules.map(async name => ["../" + name, await load(name)])));
const compiled = Object.fromEntries(await Promise.all(["Claude", "Codex"].map(async provider => {
  const source = await readFile(new URL(`../src/hooks/use${provider}Chat.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  return [provider, new Function("require", "exports", "window", "crypto", outputText)];
})));
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(t, provider, { planningOnly = true, mode = "full" } = {}) {
  const slots = [], effects = [], writes = [];
  let cursor = 0, counter = 0, handlers, session;
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useReducer(reducer, initial, initialize) {
      const i = cursor++, slot = slots[i] ??= { value: initialize(initial) };
      slot.reducer = reducer;
      slot.dispatch ??= action => { slot.value = slot.reducer(slot.value, action); };
      return [slot.value, slot.dispatch];
    },
    useCallback(callback, deps) {
      const i = cursor++;
      if (!sameDeps(slots[i]?.deps, deps)) slots[i] = { callback, deps };
      return slots[i].callback;
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!sameDeps(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() };
      });
    },
  };
  const write = async raw => { writes.push(JSON.parse(raw)); };
  const agent = { write, isCurrent: id => id === "process-1", spawn: () => assert.fail("Permission tests must never launch a CLI") };
  const queue = { client: { read: async () => ({ receipt: null, messages: [] }), ack: async () => undefined } };
  const stubs = {
    ...dependencies, react,
    "../browserConnection": { connectBrowser: () => assert.fail("Unexpected browser discovery in a browser-disabled session") },
    "../api": { agentWrite: (_id, raw) => write(raw), formatError: error => error.message ?? String(error) },
    "../conversations": { readConversation: () => assert.fail("Unexpected history read") },
    "../platform": { IS_WINDOWS: true },
    "./chatSession": { localId: () => `local-${++counter}`, useAgentProcess: (_id, callbacks) => { handlers = callbacks; return agent; } },
    "./useMessageQueue": { useMessageQueue: () => queue },
  };
  const exports = {};
  compiled[provider](name => { assert.ok(stubs[name], `Unexpected dependency: ${name}`); return stubs[name]; }, exports,
    { setTimeout: () => assert.fail("Unexpected startup timer"), clearTimeout() {} }, { randomUUID: () => `user-${++counter}` });
  const options = { sessionId: "tab", cwd: "D:/projects/trex", command: null, args: null, shell: "powershell", env: null,
    conversationId: null, mode, visible: false, planningOnly, onExit() {}, onRunning() {} };
  const render = () => {
    cursor = 0;
    session = exports[`use${provider}Chat`](options);
    for (const effect of effects.splice(0)) effect();
    return session;
  };
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); });
  render();
  return {
    writes, options,
    line(event) { handlers.onLine(JSON.stringify(event), "process-1"); render(); },
    get session() { return render(); },
    get state() { return render().state; },
    get card() { return render().state.items.findLast(item => item.kind === "permission"); },
  };
}

const claudeRequest = (tool, input = {}, id = "permission-1") => ({ type: "control_request", request_id: id,
  request: { subtype: "can_use_tool", tool_name: tool, input, permission_suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] } });
const codexRequest = (method, params = {}, id = 0) => ({ jsonrpc: "2.0", id, method: `item/${method}`, params });
const assertPlan = h => { assert.equal(h.state.permissionMode, "plan"); assert.equal(h.state.modeChoice, "plan"); };

for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "mcp__custom__write", "UnknownTool", ""]) {
  for (const remember of [false, true]) {
    test(`Claude planner refuses ${tool || "unnamed tool"} on receipt and on a stale approval (remember=${remember})`, t => {
      const h = harness(t, "Claude");
      h.line(claudeRequest(tool, { command: "cat README.md; touch changed", dangerouslyDisableSandbox: true }));
      assert.equal(h.card.state, "denied");
      assert.equal(h.writes.length, 1);
      assert.equal(h.writes[0].response.response.behavior, "deny");
      h.session.answer({ ...h.card, state: "pending" }, true, remember);
      assert.equal(h.writes.length, 2);
      for (const reply of h.writes) {
        assert.equal(reply.response.request_id, "permission-1");
        assert.equal(reply.response.subtype, "success");
        assert.equal(reply.response.response.behavior, "deny");
        assert.equal(reply.response.response.updatedPermissions, undefined);
      }
      assertPlan(h);
    });
  }
}

for (const tool of ["Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "WebFetch"]) {
  test(`Claude planner preserves ${tool} approval without permission amendments`, t => {
    const h = harness(t, "Claude");
    const input = { file_path: "D:/project/README.md", pattern: "plan" };
    h.line(claudeRequest(tool, input));
    assert.equal(h.card.state, "pending"); assert.equal(h.writes.length, 0);
    h.session.answer(h.card, true, true);
    assert.equal(h.card.state, "allowed");
    assert.deepEqual(h.writes[0].response.response, { behavior: "allow", updatedInput: input });
    assertPlan(h);
  });
}

test("Claude planner keeps ExitPlanMode denied on receipt and manual approval", t => {
  const h = harness(t, "Claude");
  h.line(claudeRequest("ExitPlanMode"));
  h.session.answer(h.card, true, true);
  assert.equal(h.card.state, "denied");
  assert.ok(h.writes.every(reply => reply.response.response.behavior === "deny"));
  assertPlan(h);
});

test("Claude planner refuses shell approvals even when the display looks like a read", t => {
  const h = harness(t, "Claude");
  h.line(claudeRequest("Bash", { command: "cat README.md" }));
  assert.equal(h.card.state, "denied");
  assert.equal(h.writes[0].response.response.behavior, "deny");
});

for (const tool of [["Read"], { toString: "Read" }]) {
  test(`Claude planner refuses malformed tool names without coercion: ${JSON.stringify(tool)}`, t => {
    const h = harness(t, "Claude");
    h.line(claudeRequest(tool));
    assert.equal(h.card.state, "denied");
    assert.equal(h.writes[0].response.response.behavior, "deny");
  });
}

const unsafePermissions = [
  { fileSystem: { write: ["D:/project"] } },
  { fileSystem: { read: ["D:/docs"], write: ["D:/project"] } },
  { fileSystem: { write: "all" } },
  { fileSystem: { entries: [{ path: { type: "path", path: "D:/project" }, access: "write" }] } },
  { fileSystem: { entries: [{ access: "unknown" }] } },
  { fileSystem: { read: "unrestricted" } },
  { fileSystem: { read: [], unrestricted: true } },
  { fileSystem: "unrestricted" },
  { filesystem: { write: ["D:/project"] } },
  { network: { enabled: true } },
  { network: { enabled: false, unknown: true } },
  { unknown: { enabled: true } },
  [], null,
];
for (const [index, permissions] of unsafePermissions.entries()) {
  for (const remember of [false, true]) {
    test(`Codex planner refuses unsafe permission profile ${index} on receipt and session/turn approval (${remember})`, t => {
      const h = harness(t, "Codex");
      h.line(codexRequest("permissions/requestApproval", { permissions }));
      assert.equal(h.card.state, "denied");
      assert.equal(h.writes.length, 1);
      assert.deepEqual(h.writes[0], { id: 0, result: { permissions: {}, scope: "turn" } });
      h.session.answer({ ...h.card, state: "pending" }, true, remember);
      assert.equal(h.writes.length, 2);
      assert.deepEqual(h.writes[1], h.writes[0]);
      assertPlan(h);
    });
  }
}

for (const [method, params, expected] of [
  ["fileChange/requestApproval", { grantRoot: "D:/project" }, { decision: "decline" }],
  ["commandExecution/requestApproval", { command: "echo changed > file", availableDecisions: ["accept", "acceptForSession", "decline"] }, { decision: "decline" }],
  ["commandExecution/requestApproval", { command: "rm file", availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm"] } }, "cancel"] }, { decision: "cancel" }],
  ["commandExecution/requestApproval", { command: "cat README.md; touch file", commandActions: [{ type: "read", path: "README.md" }] }, { decision: "decline" }],
  ["commandExecution/requestApproval", { command: "ls" }, { decision: "decline" }],
]) {
  test(`Codex planner refuses execution/edit escalation: ${method} ${params.command ?? "files"}`, t => {
    const h = harness(t, "Codex");
    h.line(codexRequest(method, params, "approval-id"));
    assert.equal(h.card.state, "denied");
    assert.deepEqual(h.writes, [{ id: "approval-id", result: expected }]);
    h.session.answer({ ...h.card, state: "pending" }, true, true);
    assert.deepEqual(h.writes[1], h.writes[0]);
    assertPlan(h);
  });
}

for (const permissions of [
  { fileSystem: { read: ["D:/docs"], write: [] }, network: null },
  { fileSystem: { read: ["D:/docs"], write: null }, network: { enabled: false } },
  { fileSystem: { entries: [{ path: { type: "path", path: "D:/docs" }, access: "read" }], globScanMaxDepth: 5 } },
]) {
  test(`Codex planner preserves read-only grants and limits remembered approvals to the turn: ${JSON.stringify(permissions)}`, t => {
    const h = harness(t, "Codex");
    h.line(codexRequest("permissions/requestApproval", { permissions }));
    assert.equal(h.card.state, "pending"); assert.equal(h.writes.length, 0);
    h.session.answer(h.card, true, true);
    assert.equal(h.card.state, "allowed");
    assert.deepEqual(h.writes, [{ id: 0, result: { permissions, scope: "turn" } }]);
    assertPlan(h);
  });
}

for (const provider of ["Claude", "Codex"]) {
  for (const allowed of [true, false]) {
    test(`${provider} planner preserves answered and skipped questions (${allowed})`, t => {
      const h = harness(t, provider);
      const questions = [{ id: "region", question: "Where?", header: "Region", options: [{ label: "Lima", description: "" }] }];
      h.line(provider === "Claude" ? claudeRequest("AskUserQuestion", { questions }) : codexRequest("tool/requestUserInput", { questions }));
      assert.equal(h.card.state, "pending"); assert.equal(h.writes.length, 0);
      h.session.answer(h.card, allowed, true, [{ question: "Where?", selected: ["Lima"], other: "" }]);
      assert.equal(h.card.state, "allowed");
      if (provider === "Claude") {
        assert.equal(h.writes[0].response.response.behavior, "allow");
        assert.deepEqual(h.writes[0].response.response.updatedInput.answers, allowed ? { "Where?": "Lima" } : {});
      } else assert.deepEqual(h.writes[0].result, { answers: allowed ? { region: { answers: ["Lima"] } } : {} });
      assertPlan(h);
    });
  }
}

test("Planner inbox reads still work through both server request paths", async t => {
  const claude = harness(t, "Claude");
  claude.line(claudeRequest(dependencies["../inboxProtocol"].CLAUDE_INBOX_TOOL));
  assert.equal(claude.writes[0].response.response.behavior, "allow");
  claude.line({ type: "control_request", request_id: "inbox-bridge", request: { subtype: "mcp_message",
    server_name: dependencies["../messageQueue"].INBOX_SERVER, message: { id: 1, method: "tools/call",
      params: { name: dependencies["../messageQueue"].INBOX_TOOL, arguments: {} } } } });
  const codex = harness(t, "Codex");
  codex.line(codexRequest("tool/call", { tool: dependencies["../messageQueue"].INBOX_TOOL, arguments: {} }));
  await flush();
  assert.equal(codex.writes[0].result.success, true);
  assert.equal(claude.writes[1].response.response.mcp_response.result.isError, false);
});

test("Codex planner refuses unknown dynamic tool calls", t => {
  const h = harness(t, "Codex");
  h.line(codexRequest("tool/call", { tool: "custom_write", arguments: { path: "file" } }));
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].id, 0);
  assert.equal(typeof h.writes[0].error.message, "string");
  assert.equal(h.writes[0].result, undefined);
});

for (const provider of ["Claude", "Codex"]) {
  test(`${provider} cannot grant a write after a prop or mode change attempts to unlock the planner`, t => {
    const h = harness(t, provider);
    h.options.planningOnly = false;
    h.session.setMode(provider === "Claude" ? "bypassPermissions" : "full");
    h.line(provider === "Claude" ? claudeRequest("Write") : codexRequest("permissions/requestApproval", { permissions: { fileSystem: { write: ["D:/project"] } } }));
    h.session.answer(h.card, true, true);
    assert.equal(h.card.state, "denied");
    assertPlan(h);
  });

  test(`${provider} planner still respects denial of a legitimate read-only request`, t => {
    const h = harness(t, provider);
    h.line(provider === "Claude" ? claudeRequest("Read", { file_path: "file" })
      : codexRequest("permissions/requestApproval", { permissions: { fileSystem: { read: ["D:/docs"] } } }));
    h.session.answer(h.card, false, true);
    assert.equal(h.card.state, "denied");
    if (provider === "Claude") assert.equal(h.writes[0].response.response.behavior, "deny");
    else assert.deepEqual(h.writes[0].result, { permissions: {}, scope: "turn" });
  });
}

test("Claude executor preserves normal write/session approvals and allow-all behavior", t => {
  const h = harness(t, "Claude", { planningOnly: false, mode: "default" });
  h.line(claudeRequest("Write", { file_path: "a", content: "changed" }));
  assert.equal(h.card.state, "pending");
  h.session.answer(h.card, true, true);
  assert.equal(h.writes[0].response.response.behavior, "allow");
  assert.deepEqual(h.writes[0].response.response.updatedPermissions, h.card.suggestions);
  const full = harness(t, "Claude", { planningOnly: false, mode: "bypassPermissions" });
  full.line(claudeRequest("Bash", { command: "touch file" }));
  assert.equal(full.writes[0].response.response.behavior, "allow");
});

test("Codex executor preserves write/session grants, command amendments and allow-all behavior", t => {
  const h = harness(t, "Codex", { planningOnly: false, mode: "auto" });
  const permissions = { fileSystem: { write: ["D:/project"] } };
  h.line(codexRequest("permissions/requestApproval", { permissions }));
  assert.equal(h.card.state, "pending");
  h.session.answer(h.card, true, true);
  assert.deepEqual(h.writes[0].result, { permissions, scope: "session" });
  h.line(codexRequest("commandExecution/requestApproval", { command: "touch file", availableDecisions: ["accept", "acceptForSession", "decline"] }, 1));
  h.session.answer(h.card, true, true);
  assert.deepEqual(h.writes[1].result, { decision: "acceptForSession" });
  const full = harness(t, "Codex", { planningOnly: false, mode: "full" });
  full.line(codexRequest("fileChange/requestApproval"));
  assert.deepEqual(full.writes[0].result, { decision: "accept" });
});
