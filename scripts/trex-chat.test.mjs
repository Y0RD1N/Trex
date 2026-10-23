import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { trexReducer, parseTrexModels, trexRequest } = await load("trexChat");
const { initialChatState } = await load("chatState");
const { completedWorkflowPlan } = await load("agentWorkflow");
const { summarizeWork } = await load("workSummary");
const { describeTool, inputDiff } = await load("chatState");
const { normalizeProfiles, launchForProfile, profilesForInstallation, trexProfileArgs, trexProfileName } = await load("profiles");
const { normalizeConfig, DEFAULT_SETTINGS } = await load("api");
const { createProfileModelLoader } = await load("profileModels");

const ready = () => trexReducer(initialChatState("plan"), { type: "trexReady", result: { sessionId: "session", model: "deepseek-model", mode: "plan", items: [] }, models: [] });
const send = (state = ready(), id = "user-1") => trexReducer(state, { type: "send", id, text: "Planifica esta mejora.", now: 100 });
const event = (state, method, params = {}) => trexReducer(state, { type: "trexEvent", method, params: { sessionId: "session", messageId: "user-1", ...params }, now: 200 });

test("Saved CLI names retain spaces, quotes and literal slashes in launcher references", () => {
  for (const name of ["TREX1", "Work account", `Work's \"API\"`, String.raw`account\path's \"key\"`, "new", "Trabajo 🦖"]) {
    assert.equal(trexProfileName({ args: trexProfileArgs(name), name: "Different display label" }), name);
  }
  assert.equal(trexProfileName({ args: '--profile="Work account" app-server', name: "Other" }), "Work account");
});

test("Trex model capabilities retain only explicit supported effort levels and unique safe IDs", () => {
  const models = parseTrexModels([{ id: "deepseek/model", name: "DeepSeek", efforts: ["high", "max", "high", "invented"], contextWindow: 1000 },
    { id: "deepseek/model" }, { id: "bad model" }, { id: "minimax", efforts: [] }]);
  assert.deepEqual(models.map(m => m.value), ["deepseek/model", "minimax"]);
  assert.deepEqual(models[0].efforts, ["high", "max"]);
  assert.equal(models[0].contextWindow, 1000);
  assert.deepEqual(models[1].efforts, []);
});

test("Trex streams text and thinking separately and finalizes only the accepted live turn", () => {
  let state = send();
  state = event(state, "message/delta", { id: "think", kind: "thinking", text: "Analizando" });
  state = event(state, "message/delta", { id: "answer", text: "<trex_plan>Primer" });
  state = event(state, "message/delta", { id: "answer", text: " paso</trex_plan>" });
  assert.equal(state.items.find(i => i.id === "answer").text, "<trex_plan>Primer paso</trex_plan>");
  assert.equal(state.lastCompletion, null);
  state = event(state, "turn/completed", { status: "completed", usage: { inputTokens: 300, outputTokens: 50, contextWindow: 1000, costUsd: .01 } });
  assert.equal(state.pendingTurns, 0);
  assert.equal(state.lastCompletion.status, "completed");
  assert.deepEqual(state.lastCompletion.messageIds, ["user-1"]);
  assert.ok(state.lastCompletion.itemIds.includes("answer"));
  assert.equal(state.items.find(i => i.id === "answer").final, true);
  assert.equal(state.usage.used, 300); assert.equal(state.usage.total, 350); assert.equal(state.costUsd, .01);
  assert.equal(completedWorkflowPlan(state.items, state.lastCompletion), "Primer paso");
});

test("Stale sessions, unknown message IDs and duplicate terminals cannot complete a new Trex request", () => {
  let state = send();
  for (const params of [{ sessionId: "old" }, { messageId: "wrong" }]) assert.equal(event(state, "turn/completed", { ...params, status: "completed" }), state);
  state = event(state, "turn/completed", { status: "completed" });
  const duplicate = event(state, "turn/completed", { status: "completed", usage: { inputTokens: 5 } });
  assert.equal(duplicate, state);
  const next = send(state, "user-2");
  assert.equal(event(next, "turn/completed", { status: "completed" }), next);
});

test("Interrupted Trex work retains attribution and cannot authorize automatic plan execution", () => {
  let state = send();
  state = event(state, "message/delta", { id: "answer", text: "<trex_plan>Old plan</trex_plan>" });
  state = trexReducer(state, { type: "interruptSend", id: "user-1" });
  state = event(state, "turn/completed", { status: "completed" });
  assert.equal(state.lastCompletion.status, "interrupted");
  assert.equal(completedWorkflowPlan(state.items, state.lastCompletion), null);
  assert.equal(state.items.some(item => item.kind === "turn"), false, "a racing success must not arm the queue wake effect after Stop");
});

test("Tool and permission events preserve IDs and terminate pending approvals on failure", () => {
  let state = send();
  state = event(state, "tool/start", { id: "edit-1", toolName: "write_file", input: { path: "a.ts", content: "test" } });
  state = event(state, "permission/request", { id: "approve-1", toolUseId: "edit-1", toolName: "write_file", input: { path: "a.ts" } });
  assert.equal(state.items.find(i => i.id === "approve-1").state, "pending");
  assert.equal(state.items.find(i => i.id === "edit-1").name, "Write");
  assert.equal(describeTool("Write", state.items.find(i => i.id === "edit-1").input, "D:/project", false).target, "a.ts");
  state = event(state, "tool/result", { id: "edit-1", output: "Denied", isError: true });
  state = event(state, "turn/completed", { status: "failed", error: "Request failed" });
  assert.equal(state.items.find(i => i.id === "approve-1").state, "denied");
  assert.equal(state.items.find(i => i.id === "edit-1").status, "error");
  assert.equal(state.lastCompletion.status, "failed");
});

test("Trex patches expose all destinations in approvals, diffs and completed work", () => {
  let state = send();
  const patch = JSON.stringify({ files: [{ path: "src/a.ts", before: "old", after: "new" }, { path: "src/b.ts", before: null, after: "created" }] });
  state = event(state, "tool/start", { id: "patch-1", toolName: "apply_patch", input: { patch } });
  state = event(state, "permission/request", { id: "permission-1", toolName: "apply_patch", input: { patch } });
  const permission = state.items.find(i => i.id === "permission-1");
  assert.equal(describeTool(permission.toolName, permission.input, "D:/project", false).target, "src/a.ts, src/b.ts");
  assert.ok(inputDiff(permission.toolName, permission.input).some(line => line.text === "src/b.ts"));
  state = event(state, "tool/result", { id: "patch-1", output: "Done" });
  const files = summarizeWork(state.items, "D:/project").files;
  assert.deepEqual(files.map(file => file.path), ["src/a.ts", "src/b.ts"]);
  assert.equal(files[1].kind, "added");
});

test("History hydration preserves a reserved send and never publishes a successful live completion", () => {
  const state = trexReducer(send(), { type: "trexReady", result: { sessionId: "session", model: "model", mode: "plan",
    items: [{ kind: "text", id: "old", messageId: "old", text: "<trex_plan>Old</trex_plan>", final: true }] }, models: [] });
  assert.equal(state.historyCount, 1);
  assert.deepEqual(state.items.map(i => i.id), ["old", "user-1"]);
  assert.equal(state.pendingTurns, 1); assert.equal(state.lastCompletion, null);
});

test("Native Trex profiles remain independent launcher references without API credentials", () => {
  const settings = { ...DEFAULT_SETTINGS, profiles: normalizeProfiles([
    { id: "one", name: "TREX1", provider: "trex", command: "trex-agent", args: '--profile "TREX1"', shell: "", configDir: "C:/accounts/one" },
    { id: "two", name: "TREX2", provider: "trex", command: "trex-agent", args: '--profile "TREX2"', shell: "", configDir: "C:/accounts/two" },
  ], DEFAULT_SETTINGS) };
  assert.equal(settings.profiles.length, 2);
  const first = launchForProfile(settings, settings.profiles[0]), second = launchForProfile(settings, settings.profiles[1]);
  assert.deepEqual(first.env, { TREX_HOME: "C:/accounts/one" });
  assert.deepEqual(second.env, { TREX_HOME: "C:/accounts/two" });
  assert.notEqual(first.args, second.args);
  assert.equal(JSON.stringify(first).includes("apiKey"), false);
  assert.deepEqual(profilesForInstallation(settings, false).map(p => p.provider), ["claude", "codex"]);
  assert.deepEqual(profilesForInstallation(settings, true), settings.profiles);
});

test("App configuration retains Trex kinds and saved choices across restart", () => {
  const normalized = normalizeConfig({ settings: { profiles: [{ id: "trex1", name: "TREX1", provider: "trex", command: "trex-agent", args: "--profile TREX1" }] },
    ui: { chatModes: { trex: "ask" }, lastTabs: [{ projectId: "p", kind: "trex", subtitle: "TREX1", chatMode: "plan", chatModel: "deepseek/model", chatEffort: "high" }] } });
  assert.equal(normalized.settings.profiles[0].provider, "trex");
  assert.equal(normalized.ui.lastTabs[0].kind, "trex");
  assert.equal(normalized.ui.lastTabs[0].chatModel, "deepseek/model");
  assert.equal(normalized.ui.lastTabs[0].chatEffort, "high");
  assert.equal(normalized.ui.chatModes.trex, "ask");
});

test("Trex model discovery initializes its protocol and never sends a model generation request", async () => {
  const calls = []; let onLine;
  const loader = createProfileModelLoader({ listenLine: async (_, cb) => { onLine = cb; return () => {}; }, listenExit: async () => () => {},
    spawn: async request => { assert.deepEqual(request.flags, ["app-server"]); assert.equal(request.profileArgs, "--profile TREX2"); },
    write: async (_, line) => { const p = JSON.parse(line); calls.push(p); onLine(JSON.stringify({ jsonrpc: "2.0", id: p.id, result: p.method === "initialize" ? { protocolVersion: 1 } : { models: [{ id: "minimax", efforts: ["high"] }] } })); },
    kill: async () => {} });
  const result = await loader({ id: "t", name: "TREX2", provider: "trex", command: "trex-agent", args: "--profile TREX2", shell: "", configDir: "" }, DEFAULT_SETTINGS, "D:/project");
  assert.deepEqual(calls.map(p => p.method), ["initialize", "models/list"]);
  assert.equal(result[0].value, "minimax");
  assert.deepEqual(JSON.parse(trexRequest("id", "session/start", { mode: "plan" })), { jsonrpc: "2.0", id: "id", method: "session/start", params: { mode: "plan" } });
});
