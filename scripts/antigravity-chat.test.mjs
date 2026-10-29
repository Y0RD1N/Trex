import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { AcpConnection, AcpError, acpPrompt, acpMcpServer, validAcpSessionId, sameAcpCwd } = await load("acpProtocol");
const { antigravityReducer: reduce, acpConfigs, acpModels, acpModes, acpOutputText } = await load("antigravityChat");
const { initialChatState } = await load("chatState");
const { chatTasks } = await load("chatTasks");
const { normalizeConfig, DEFAULT_CONFIG } = await load("api");
const { normalizeProfiles, launchForProfile } = await load("profiles");
const { canResume, resumedLaunch } = await load("conversations");
const ready = () => reduce(initialChatState(), { type: "acpReady", sessionId: "opaque/session-1", result: {} });
const send = (state = ready(), id = "u1") => reduce(state, { type: "send", id, text: "Revisa esto", now: 100 });
const update = (state, value, { turn = "u1", replay = false, sessionId = "opaque/session-1" } = {}) => reduce(state, { type: "acpUpdate", sessionId, turn, replay, update: value });

test("ACP correlates concurrent requests, server requests and notifications independently", async () => {
  const writes = [], notices = [], requests = [];
  const rpc = new AcpConnection({ write: async line => writes.push(JSON.parse(line)) }, (m, p) => notices.push([m, p]), (...args) => requests.push(args));
  const first = rpc.call("one"), second = rpc.call("two"); await Promise.resolve();
  rpc.accept(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { two: true } }));
  rpc.accept(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s" } }));
  rpc.accept(JSON.stringify({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: {} }));
  rpc.accept(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { one: true } }));
  assert.deepEqual(await first, { one: true }); assert.deepEqual(await second, { two: true });
  assert.equal(requests[0][0], "permission"); assert.equal(notices.length, 1); assert.equal(writes.length, 2);
  rpc.close();
});
test("ACP reports write failure and closed connections without leaving pending work", async () => {
  const rpc = new AcpConnection({ write: async () => { throw Error("pipe failed"); } }, () => {}, () => {});
  const request = rpc.issue("session/prompt", {}, 0);
  await assert.rejects(request.written, /pipe failed/); await assert.rejects(request.result, /pipe failed/);
  rpc.close(); await assert.rejects(rpc.call("after-close"), /cerrada/);
});
test("ACP preserves structured protocol errors and rejects pending work on disconnect", async () => {
  const rpc = new AcpConnection({ write: async () => {} }, () => {}, () => {});
  const pending = rpc.call("session/new"); await Promise.resolve();
  rpc.accept(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Authentication required", data: { setup: true } } }));
  await assert.rejects(pending, e => e instanceof AcpError && e.code === -32000 && e.data.setup);
  const next = rpc.call("session/prompt", {}, 0); rpc.close(); await assert.rejects(next, /cerró/);
});
test("Images remain real ACP blocks, with explicit capability and format validation", () => {
  const image = { mediaType: "image/png", data: "aGVsbG8=" };
  assert.deepEqual(acpPrompt("[Imagen 1]", [image], true), [{ type: "text", text: "[Imagen 1]" }, { type: "image", mimeType: "image/png", data: image.data }]);
  assert.throws(() => acpPrompt("", [image], false), /no admite imágenes/);
  assert.throws(() => acpPrompt("", [{ ...image, data: "not base64" }], true), /formato/);
  assert.deepEqual(acpMcpServer("trex_browser", { command: "C:/Program Files/Trex/browser.exe", args: ["--client", "chat-one"] }).env, []);
});
test("History paths respect Windows normalization and Linux case sensitivity", () => {
  assert.equal(sameAcpCwd("D:/Projects/Trex/", "d:\\projects\\trex"), true);
  assert.equal(sameAcpCwd("/work/Trex", "/work/trex"), false);
  assert.equal(sameAcpCwd("/work/trex/", "/work/trex"), true);
});
test("Tool outputs never dump MCP image bytes into the transcript", () => {
  const output = acpOutputText({ content: [{ type: "text", text: "Screenshot captured" }, { type: "image", mimeType: "image/png", data: "BASE64_IMAGE_PAYLOAD" }] });
  assert.match(output, /Screenshot captured/); assert.doesNotMatch(output, /BASE64_IMAGE_PAYLOAD/);
});
test("Profile migration and tab restoration retain Antigravity instead of falling back to Claude", () => {
  const profile = { id: "agy", provider: "antigravity", name: "Google", command: "antigravity-acp", args: "", configDir: "C:/accounts/work", shell: "", launchMode: "arg" };
  const settings = { ...DEFAULT_CONFIG.settings, profiles: [profile], defaultProfileId: "agy" };
  assert.equal(normalizeProfiles([profile], settings)[0].provider, "antigravity");
  const launch = launchForProfile(settings, profile); assert.deepEqual(launch.env, { GEMINI_HOME: "C:/accounts/work" });
  assert.equal(canResume(launch, "antigravity"), true); assert.equal(resumedLaunch(launch, "antigravity", "opaque/session-1").args, "");
  const config = normalizeConfig({ ...DEFAULT_CONFIG, settings, ui: { ...DEFAULT_CONFIG.ui, lastTabs: [{ projectId: "p", kind: "antigravity", subtitle: "Google", launch, conversationId: "opaque/session-1" }] } });
  assert.equal(config.ui.lastTabs[0].kind, "antigravity"); assert.equal(config.ui.lastTabs[0].conversationId, "opaque/session-1");
  assert.equal(validAcpSessionId("bad\nidentifier"), false);
});
test("Model and effort selectors use advertised IDs and omit unverified planning modes", () => {
  const configs = acpConfigs([{ id: "model", type: "select", category: "model", currentValue: "model-A", options: [{ group: "g", options: [{ value: "model-A", name: "Account model" }] }] },
    { id: "effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "imaginary", name: "Fake" }] }]);
  assert.deepEqual(acpModels(configs, null).map(m => [m.value, m.efforts]), [["model-A", ["high"]]]);
  assert.deepEqual(acpModes({ availableModes: [{ id: "ask", name: "Ask" }, { id: "plan", name: "Plan" }] }).map(m => m.value), ["ask"]);
});
test("ACP streams are scoped to the current session and cannot append text to the previous turn", () => {
  let state = send();
  assert.equal(update(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "WRONG" } }, { sessionId: "another-session" }), state);
  state = update(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } });
  state = update(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " part" } });
  state = reduce(state, { type: "acpFinished", id: "u1", result: { stopReason: "end_turn" }, now: 200 });
  assert.equal(state.items.find(i => i.kind === "text").text, "first part");
  assert.equal(state.lastCompletion.status, "completed");
  state = send(state, "u2"); state = update(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } }, { turn: "u2" });
  assert.deepEqual(state.items.filter(i => i.kind === "text").map(i => i.text), ["first part", "second"]);
});
test("Replay resets history without producing live completions or duplicate turns", () => {
  let state = send(); state = reduce(state, { type: "acpFinished", id: "u1", result: { stopReason: "end_turn" }, now: 200 });
  state = reduce(state, { type: "acpHistoryStart", sessionId: "opaque/session-1" });
  state = update(state, { sessionUpdate: "user_message_chunk", messageId: "history-user", content: { type: "text", text: "Before" } }, { turn: null, replay: true });
  state = update(state, { sessionUpdate: "agent_message_chunk", messageId: "history-agent", content: { type: "text", text: "Answer" } }, { turn: null, replay: true });
  assert.equal(state.lastCompletion, null); assert.equal(state.items.length, 2);
  state = reduce(state, { type: "acpReady", sessionId: "opaque/session-1", history: true, result: {} });
  assert.equal(state.historyCount, 2);
});
test("Recovered user image blocks remain attached to the matching historical message", () => {
  let state = ready();
  state = update(state, { sessionUpdate: "user_message_chunk", messageId: "past", content: { type: "text", text: "Mira [Imagen 1]" } }, { turn: null, replay: true });
  state = update(state, { sessionUpdate: "user_message_chunk", messageId: "past", content: { type: "image", mimeType: "image/png", data: "aW1hZ2U=" } }, { turn: null, replay: true });
  assert.equal(state.items.length, 1); assert.equal(state.items[0].images, 1); assert.deepEqual(state.items[0].previews, ["data:image/png;base64,aW1hZ2U="]);
});
test("Task updates require completed tools and interruption cannot complete the task plan", () => {
  let state = send();
  state = update(state, { sessionUpdate: "tool_call", toolCallId: "plan-tool", title: "trex_inbox/trex_update_tasks", rawInput: { plan: [{ step: "Verify result", status: "in_progress" }] }, status: "in_progress" });
  assert.equal(chatTasks(state.items, "Google").length, 0);
  state = update(state, { sessionUpdate: "tool_call_update", toolCallId: "plan-tool", status: "completed", rawOutput: { structuredContent: { plan: [{ step: "Verify result", status: "in_progress" }] } } });
  assert.equal(chatTasks(state.items, "Google")[0].status, "in_progress");
  state = reduce(state, { type: "interruptSend", id: "u1" }); state = reduce(state, { type: "acpFinished", id: "u1", result: { stopReason: "end_turn" }, now: 300 });
  assert.equal(state.lastCompletion.status, "interrupted"); assert.equal(chatTasks(state.items, "Google")[0].status, "in_progress");
});
test("Failed MCP task calls and malformed native plans cannot publish or erase the accepted task list", () => {
  let state = send();
  state = update(state, { sessionUpdate: "plan", entries: [{ content: "Keep this task", status: "pending" }] });
  const before = chatTasks(state.items, "Google");
  state = update(state, { sessionUpdate: "tool_call", toolCallId: "failed-plan", title: "trex_inbox/trex_update_tasks", rawInput: { plan: [] }, status: "in_progress" });
  state = update(state, { sessionUpdate: "tool_call_update", toolCallId: "failed-plan", status: "completed", rawOutput: { isError: true } });
  assert.deepEqual(chatTasks(state.items, "Google"), before);
  const invalid = update(state, { sessionUpdate: "plan", entries: [{ content: "One", status: "in_progress" }, { content: "Two", status: "in_progress" }] });
  assert.equal(invalid, state);
});
test("Accepted MCP task results survive friendly ACP titles without trusting an unconfirmed tool call", () => {
  let state = send(); const plan = { plan: [{ step: "Check", status: "pending" }] };
  state = update(state, { sessionUpdate: "tool_call", toolCallId: "friendly", title: "Publish task list", rawInput: plan, status: "in_progress" });
  state = update(state, { sessionUpdate: "tool_call_update", toolCallId: "friendly", status: "completed", rawOutput: { structuredContent: plan } });
  assert.equal(chatTasks(state.items, "Google")[0].title, "Check");
  let unconfirmed = send();
  unconfirmed = update(unconfirmed, { sessionUpdate: "tool_call", toolCallId: "missing", title: "trex_update_tasks", rawInput: plan, status: "completed" });
  assert.equal(chatTasks(unconfirmed.items, "Google").length, 0);
});
