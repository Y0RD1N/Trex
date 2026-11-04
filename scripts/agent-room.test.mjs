import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { normalizeAgentRoom, restoreAgentRoom, mergeRoomItems, roomConversationContext, routeRoomMessage } = await load("agentRoom");
const { initialChatState } = await load("chatState");
const { createHandoffContext, buildHandoffPrompt } = await load("handoff");
const { chatReducer: claudeReducer } = await load("claudeChat");
const clone = value => structuredClone(value);
const source = { sessionId: "source-room", provider: "claude", profileId: "planner-account", profileName: "Claude personal", title: "Mejorar búsqueda", projectId: "trex", projectName: "TREX", cwd: "D:\\projects\\trex" };
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const agent = (provider, profileId) => ({ profileId, profileName: `${provider} account`, provider, model: provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol", effort: "high",
  launch: { profileId, profileName: `${provider} launcher`, command: `${provider}-personal`, args: "", shell: "pwsh", launchMode: "arg", env: { [provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: `D:\\accounts\\${profileId}` } } });
const reference = (extra = {}) => ({ id: "plan_01", sourceLabel: "Claude personal", pending: false, ...extra });
const room = (extra = {}) => ({ id: "room_01", planner: { agent: agent("claude", "planner-account"), conversationId, mode: "plan" }, executor: { agent: agent("codex", "executor-account"), conversationId: null, mode: "auto" },
  active: "executor", phase: "idle", cycle: 0, pending: null, order: [], plan: null, error: null, ...extra });
const user = (id, text = "Mejora la búsqueda.") => ({ kind: "user", id, text, images: 0, previews: [] });
const reply = (id, text = "Respuesta", final = true) => ({ kind: "text", id, messageId: "shared-message", text, final });
const thinking = (id, text) => ({ kind: "thinking", id, messageId: "shared-message", text, final: true });
const tool = (id, name = "Bash", input = { command: "npm test" }, output = "tests passed") => ({ kind: "tool", id, name, input, output, status: "done", patch: null });
const permission = (id, toolUseId = "shared-tool") => ({ kind: "permission", id, toolUseId, toolName: "Bash", input: { command: "npm test" }, description: "Confirmar", suggestions: [], state: "pending", request: { id: 7, method: "permission" } });
const state = items => ({ ...initialChatState(), items });
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("normalizes independent participants, conversations, launch snapshots and modes without mutation", () => {
  const raw = freeze(room({ cycle: 4, order: ["executor::first", "planner::last"] }));
  const result = normalizeAgentRoom(raw);
  assert.deepEqual(result, raw);
  assert.notStrictEqual(result.planner.agent.launch, raw.planner.agent.launch);
  assert.notStrictEqual(result.executor.agent.launch.env, raw.executor.agent.launch.env);
  assert.deepEqual(normalizeAgentRoom(JSON.parse(JSON.stringify(result))), result);
  const sameProvider = room();
  sameProvider.executor.agent = agent("claude", "second-claude-account");
  sameProvider.executor.mode = "acceptEdits";
  assert.equal(normalizeAgentRoom(sameProvider).executor.agent.profileId, "second-claude-account");
});
test("Antigravity executors retain opaque ACP session IDs and advertised permission modes", () => {
  const raw = room();
  raw.executor = { agent: { ...agent("antigravity", "google"), model: "account-model", launch: { profileId: "google", profileName: "Google", command: "antigravity-acp", args: "", shell: "", launchMode: "arg", env: { GEMINI_HOME: "D:/accounts/google" } } }, conversationId: "opaque/acp-session", mode: "request-review" };
  const restored = normalizeAgentRoom(raw);
  assert.equal(restored.executor.conversationId, "opaque/acp-session"); assert.equal(restored.executor.mode, "request-review");
  assert.equal(routeRoomMessage("@antigravity revisa este cambio", restored).role, "executor");
});

test("validates all required room fields and participant conversation identities", () => {
  for (const raw of [undefined, null, [], "room", 12, {}]) assert.equal(normalizeAgentRoom(raw), null);
  for (const id of [undefined, null, "", " ", "../room", "room\n", "room\0", "x".repeat(101), 3]) assert.equal(normalizeAgentRoom(room({ id })), null, JSON.stringify(id));
  for (const active of [undefined, null, "Planner", "other", [], 1]) assert.equal(normalizeAgentRoom(room({ active })), null);
  for (const phase of [undefined, null, "running", "Planning", {}, 1]) assert.equal(normalizeAgentRoom(room({ phase })), null);
  for (const cycle of [undefined, null, -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) assert.equal(normalizeAgentRoom(room({ cycle })), null);
  for (const order of [undefined, null, {}, "planner::item"]) assert.equal(normalizeAgentRoom(room({ order })), null);
  for (const role of ["planner", "executor"]) {
    for (const participant of [undefined, null, [], {}]) assert.equal(normalizeAgentRoom(room({ [role]: participant })), null);
    for (const id of [undefined, "", "../conversation", "session-id", `${conversationId}\n`, 1]) {
      const raw = room(); raw[role].conversationId = id;
      assert.equal(normalizeAgentRoom(raw), null, `${role}: ${JSON.stringify(id)}`);
    }
    const raw = room(); raw[role].conversationId = conversationId.toUpperCase();
    assert.equal(normalizeAgentRoom(raw)[role].conversationId, conversationId.toUpperCase());
  }
  for (const phase of ["idle", "planning", "waiting", "transferring", "executing", "completed", "paused", "failed"]) assert.equal(normalizeAgentRoom(room({ phase })).phase, phase);
  assert.equal(normalizeAgentRoom(room({ cycle: Number.MAX_SAFE_INTEGER })).cycle, Number.MAX_SAFE_INTEGER);
});

test("reuses agent validation for model, effort, provider and launcher identity", () => {
  for (const role of ["planner", "executor"]) {
    for (const [field, value] of [["profileId", ""], ["profileName", ""], ["provider", "shell"], ["model", "--model evil"], ["effort", "unknown"]]) {
      const raw = room(); raw[role].agent[field] = value;
      assert.equal(normalizeAgentRoom(raw), null, `${role}.${field}`);
    }
    const raw = room(); raw[role].agent.launch.profileId = "another-account";
    assert.equal(normalizeAgentRoom(raw), null);
  }
});

test("preserves independently configured native permissions for both participants", () => {
  for (const provider of ["claude", "codex"]) {
    const modes = provider === "claude" ? ["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk", "manual"] : ["read-only", "auto", "plan", "full"];
    for (const mode of modes) {
      const raw = room(); raw.planner.agent = agent(provider, "planner-account"); raw.executor.agent = agent(provider, "executor-account");
      raw.planner.mode = mode; raw.executor.mode = mode;
      const result = normalizeAgentRoom(raw);
      assert.equal(result.planner.mode, mode);
      assert.equal(result.executor.mode, mode);
    }
  }
  for (const mode of ["unknown", "AUTO", "", 1, [], {}]) {
    for (const role of ["planner", "executor"]) { const raw = room(); raw[role].mode = mode; assert.equal(normalizeAgentRoom(raw), null); }
  }
  const missing = room(); delete missing.planner.mode; delete missing.executor.mode;
  assert.equal(normalizeAgentRoom(missing).planner.mode, "plan");
  assert.equal(Object.hasOwn(normalizeAgentRoom(missing).executor, "mode"), false);
  missing.executor.mode = null;
  missing.planner.mode = null;
  assert.equal(normalizeAgentRoom(missing).executor.mode, null);
  assert.equal(normalizeAgentRoom(missing).planner.mode, "plan");
  const wrongProviderMode = room(); wrongProviderMode.executor.mode = "acceptEdits";
  assert.equal(normalizeAgentRoom(wrongProviderMode), null);
});

test("persists only bounded references, safe ledger IDs and sanitized errors, never transcript bodies", () => {
  const raw = room({ content: "ROOM_TRANSCRIPT", items: ["ROOM_ITEM_BODY"], plan: reference({ content: "PLAN_BODY" }),
    pending: { id: "delivery_01", role: "executor", reference: reference({ pending: true, content: "PENDING_BODY" }), text: "DELIVERY_BODY" },
    order: ["planner::safe:id", "executor::safe", "planner::safe:id", "unowned", "planner::", "planner::has space", "planner::bad\n", `executor::${"x".repeat(513)}`, "__proto__", null, {}],
    error: "Useful failure\nAPI_KEY=ERROR_SECRET\n<environment_context>ENV_SECRET</environment_context>\n" + "🦖 ".repeat(1_000) });
  raw.planner.items = ["PARTICIPANT_BODY"];
  raw.executor.agent.history = ["AGENT_BODY"];
  const result = normalizeAgentRoom(freeze(raw));
  assert.deepEqual(result.order, ["planner::safe:id", "executor::safe"]);
  assert.deepEqual(result.plan, reference());
  assert.deepEqual(result.pending, { id: "delivery_01", role: "executor", reference: reference({ pending: true }) });
  assert.match(result.error, /Useful failure/);
  assert.ok([...result.error].length <= 1200);
  assert.doesNotMatch(JSON.stringify(result), /ROOM_TRANSCRIPT|ROOM_ITEM_BODY|PLAN_BODY|PENDING_BODY|DELIVERY_BODY|PARTICIPANT_BODY|AGENT_BODY|ERROR_SECRET|ENV_SECRET/);
});

test("malformed pending deliveries fail closed while invalid optional plans are discarded", () => {
  for (const pending of [[], {}, "pending", { id: "bad\n", role: "planner", reference: reference() }, { id: "delivery", role: "other", reference: reference() }, { id: "delivery", role: "executor", reference: { id: "../bad", sourceLabel: "Claude" } }]) {
    assert.equal(normalizeAgentRoom(room({ pending })), null, JSON.stringify(pending));
  }
  for (const plan of [[], {}, "body", { id: "../plan", sourceLabel: "Claude" }, { id: "plan\n", sourceLabel: "Claude" }, { id: "plan", sourceLabel: "Claude", pending: "true" }]) assert.equal(normalizeAgentRoom(room({ plan })).plan, null);
});

test("restore pauses in-flight phases and uncertain deliveries without advancing cycle or resending", () => {
  assert.equal(restoreAgentRoom(null), null);
  assert.equal(restoreAgentRoom(undefined), null);
  for (const phase of ["idle", "completed", "failed", "paused"]) { const raw = freeze(room({ phase })); assert.strictEqual(restoreAgentRoom(raw), raw); }
  for (const phase of ["planning", "waiting", "transferring", "executing"]) {
    const raw = freeze(room({ phase, cycle: 3 }));
    const restored = restoreAgentRoom(raw);
    assert.equal(restored.phase, "paused");
    assert.equal(restored.cycle, 3);
    assert.equal(restored.active, raw.active);
    assert.equal(raw.phase, phase);
    assert.strictEqual(restoreAgentRoom(restored), restored);
  }
  for (const phase of ["idle", "completed", "failed", "paused"]) {
    const raw = freeze(room({ phase, pending: { id: "delivery", role: "executor", reference: reference({ pending: true }) } }));
    const restored = restoreAgentRoom(raw);
    assert.equal(restored.phase, "paused");
    assert.strictEqual(restored.pending, raw.pending);
    assert.match(restored.error, /no se ha vuelto a enviar/);
  }
  assert.equal(restoreAgentRoom(room({ plan: reference({ pending: true }) })).phase, "paused");
});

test("namespaces every kind and nested message/tool IDs while preserving provider ownership", () => {
  const items = [user("user"), reply("text"), thinking("thinking", "Thought"), tool("shared-tool"), permission("permission"), permission("unlinked", null),
    { kind: "notice", id: "notice", tone: "info", text: "Ready" }, { kind: "turn", id: "turn", durationMs: 123 }];
  const states = freeze({ planner: state(items), executor: state(clone(items)) });
  const result = mergeRoomItems(states, []);
  assert.equal(result.items.length, 16);
  assert.equal(new Set(result.items.map(item => item.id)).size, 16);
  for (const role of ["planner", "executor"]) for (const original of items) {
    const id = `${role}::${original.id}`, item = result.items.find(item => item.id === id);
    assert.deepEqual(result.owners[id], { role, originalId: original.id });
    if (original.kind === "text" || original.kind === "thinking") assert.equal(item.messageId, `${role}::shared-message`);
    if (original.kind === "permission") {
      assert.equal(item.toolUseId, original.toolUseId === null ? null : `${role}::shared-tool`);
      assert.deepEqual(item.request, original.request);
    }
  }
  assert.equal(states.planner.items[1].id, "text");
  assert.equal(states.planner.items[1].messageId, "shared-message");
});

test("the ledger preserves interleaving and replaces streamed values without moving rows", () => {
  const first = mergeRoomItems({ executor: state([user("request"), reply("answer", "First chunk", false)]) }, []);
  const second = mergeRoomItems({ planner: state([reply("plan", "Plan")]), executor: state([user("request"), reply("answer", "Full answer"), tool("test")]) }, first.order);
  assert.deepEqual(second.order, ["executor::request", "executor::answer", "planner::plan", "executor::test"]);
  assert.deepEqual(second.items.map(item => item.id), second.order);
  assert.equal(second.items[1].text, "Full answer");
  assert.equal(second.items[1].final, true);
  assert.deepEqual(first.items.map(item => item.id), ["executor::request", "executor::answer"]);
  const third = mergeRoomItems({ planner: state([reply("plan", "Updated plan")]), executor: state([reply("answer", "Latest answer"), user("request"), tool("test")]) }, second.order);
  assert.deepEqual(third.order, second.order);
  assert.equal(third.items[1].text, "Latest answer");
});

test("retains seeded and temporarily absent ledger entries through history hydration without ghost rows", () => {
  const seeded = ["executor::old-user", "executor::old-answer", "planner::plan", "executor::new-answer"];
  const waiting = mergeRoomItems({}, seeded);
  assert.deepEqual(waiting.items, []);
  assert.deepEqual(waiting.order, seeded);
  assert.deepEqual(waiting.owners, {});
  const plannerFirst = mergeRoomItems({ planner: state([reply("plan")]) }, waiting.order);
  assert.deepEqual(plannerFirst.items.map(item => item.id), ["planner::plan"]);
  const restored = mergeRoomItems({ planner: state([reply("plan")]), executor: state([user("old-user"), reply("old-answer"), reply("new-answer")]) }, plannerFirst.order);
  assert.deepEqual(restored.items.map(item => item.id), seeded);
  const deleted = mergeRoomItems({ planner: state([]), executor: state([reply("new-answer")]) }, restored.order);
  assert.deepEqual(deleted.items.map(item => item.id), ["executor::new-answer"]);
  assert.deepEqual(deleted.order, seeded);
});

test("deduplicates corrupt ledgers and source replacement IDs, safely appending unseen provider rows", () => {
  const result = mergeRoomItems({ planner: state([reply("same", "old"), reply("same", "replacement"), user("__proto__"), user("constructor"), user("invalid id")]), executor: state([reply("same", "other provider")]) },
    ["executor::same", "executor::same", "unknown", "planner::", "planner::missing", "planner::bad\0"]);
  assert.deepEqual(result.order, ["executor::same", "planner::missing", "planner::same", "planner::__proto__", "planner::constructor"]);
  assert.equal(result.items[1].text, "replacement");
  assert.deepEqual(result.owners["planner::__proto__"], { role: "planner", originalId: "__proto__" });
  assert.deepEqual(Object.keys(result.owners).sort(), ["executor::same", "planner::same", "planner::__proto__", "planner::constructor"].sort());
});

test("rekeyed hydrated users and history markers retain two-cycle interleaving while live rows append", () => {
  const turn = id => ({ kind: "turn", id, durationMs: 100 });
  const marker = id => ({ kind: "notice", id, tone: "info", text: "Recovered history" });
  const seed = ["planner::local-plan-1", "planner::plan-1", "planner::t-p1",
    "executor::local-exec-1", "executor::result-1", "executor::t-e1",
    "planner::local-plan-2", "planner::plan-2", "planner::t-p2",
    "executor::local-exec-2", "executor::result-2", "executor::t-e2", "planner::post-cycle-live"];
  const plannerItems = [user("native-plan-1"), reply("plan-1"), marker("history-p1"), turn("t-p1"), user("native-plan-2"), reply("plan-2"), turn("t-p2"), user("post-cycle-live")];
  const executorItems = [user("native-exec-1"), reply("result-1"), turn("t-e1"), user("native-exec-2"), reply("result-2"), turn("t-e2"), marker("history-tail"), user("new-live-request")];
  const states = freeze({ planner: { ...state(plannerItems), historyCount: 7 }, executor: { ...state(executorItems), historyCount: 7 } });
  const result = mergeRoomItems(states, freeze(seed));
  assert.deepEqual(result.items.map(item => item.id), ["planner::native-plan-1", "planner::plan-1", "planner::history-p1", "planner::t-p1",
    "executor::native-exec-1", "executor::result-1", "executor::t-e1",
    "planner::native-plan-2", "planner::plan-2", "planner::t-p2",
    "executor::native-exec-2", "executor::result-2", "executor::t-e2", "executor::history-tail", "planner::post-cycle-live", "executor::new-live-request"]);
  const seeded = new Set(seed);
  assert.deepEqual(result.order.filter(id => seeded.has(id)), seed, "all absent local IDs and seeded relative order survive");
  for (const role of ["planner", "executor"]) {
    const nativeId = role === "planner" ? "native-plan-1" : "native-exec-1";
    assert.deepEqual(result.owners[`${role}::${nativeId}`], { role, originalId: nativeId });
  }
  assert.equal(result.owners["executor::local-exec-1"], undefined);
  assert.deepEqual(mergeRoomItems(states, result.order), result, "hydration ordering is stable on repeated renders");
  assert.deepEqual(seed, ["planner::local-plan-1", "planner::plan-1", "planner::t-p1", "executor::local-exec-1", "executor::result-1", "executor::t-e1",
    "planner::local-plan-2", "planner::plan-2", "planner::t-p2", "executor::local-exec-2", "executor::result-2", "executor::t-e2", "planner::post-cycle-live"]);
});

test("history insertion anchors only to present provider items and preserves runs without a following anchor", () => {
  const seed = ["executor::absent-old-user", "executor::answer", "planner::later-cycle"];
  const items = [user("native-user"), reply("answer"), { kind: "turn", id: "recovered-turn", durationMs: 100 },
    { kind: "notice", id: "history-note", tone: "info", text: "History" }, user("live")];
  const result = mergeRoomItems({ executor: { ...state(items), historyCount: 4 }, planner: state([reply("later-cycle")]) }, seed);
  assert.deepEqual(result.items.map(item => item.id), ["executor::native-user", "executor::answer", "executor::recovered-turn", "executor::history-note", "planner::later-cycle", "executor::live"]);
  assert.equal(result.order[0], "executor::absent-old-user");
  const unanchored = mergeRoomItems({ executor: { ...state([user("first"), reply("second")]), historyCount: 2 } }, ["planner::absent", "executor::also-absent"]);
  assert.deepEqual(unanchored.order, ["planner::absent", "executor::also-absent", "executor::first", "executor::second"]);
});

test("actual Claude streamed and replayed blocks retain presentation keys across two persisted planning cycles", () => {
  const line = event => ({ type: "line", event, now: 1_000 });
  const stream = event => line({ type: "stream_event", event });
  const blocks = cycle => [{ type: "thinking", thinking: `Reasoning ${cycle}` }, { type: "text", text: `Plan ${cycle}` }];
  const liveTurn = (previous, cycle) => [
    { type: "send", id: `local-plan-user-${cycle}`, text: `Plan task ${cycle}`, now: 0 },
    stream({ type: "message_start", message: { id: `msg-plan-${cycle}` } }),
    ...blocks(cycle).map((content_block, index) => stream({ type: "content_block_start", index, content_block })),
    line({ type: "assistant", message: { id: `msg-plan-${cycle}`, content: blocks(cycle), stop_reason: "end_turn" } }),
    line({ type: "result", uuid: `live-result-${cycle}`, subtype: "success", is_error: false, duration_ms: 1_000 }),
  ].reduce(claudeReducer, previous);
  const executorTurn = cycle => [user(`local-exec-user-${cycle}`), { ...reply(`codex-item-${cycle}`, `Implemented ${cycle}`), messageId: `codex-item-${cycle}` },
    { kind: "turn", id: `t-codex-turn-${cycle}`, durationMs: 1_000 }];
  const planner1 = liveTurn(initialChatState(), 1), executor1 = state(executorTurn(1));
  let merged = mergeRoomItems({ planner: planner1 }, []);
  merged = mergeRoomItems({ planner: planner1, executor: executor1 }, merged.order);
  const planner2 = liveTurn(planner1, 2), executor2 = state([...executorTurn(1), ...executorTurn(2)]);
  merged = mergeRoomItems({ planner: planner2, executor: executor1 }, merged.order);
  merged = mergeRoomItems({ planner: planner2, executor: executor2 }, merged.order);
  const persisted = JSON.parse(JSON.stringify(merged.order));
  assert.equal(planner1.items.find(item => item.kind === "text").id, "msg-plan-1:text:1");
  const entries = [1, 2].flatMap(cycle => [
    { type: "user", uuid: `native-plan-user-${cycle}`, timestamp: "2026-10-23T10:00:00Z", message: { role: "user", content: `Plan task ${cycle}` } },
    { type: "assistant", uuid: `assistant-entry-${cycle}`, timestamp: "2026-10-23T10:00:01Z", message: { id: `msg-plan-${cycle}`, role: "assistant", content: blocks(cycle), stop_reason: "end_turn" } },
  ]);
  const restoredPlanner = claudeReducer(initialChatState(), { type: "history", entries });
  assert.equal(restoredPlanner.historyCount, 8);
  assert.equal(restoredPlanner.items.find(item => item.kind === "text").id, "msg-plan-1:text:1:2");
  const restored = mergeRoomItems({ planner: freeze(restoredPlanner), executor: freeze(executor2) }, freeze(persisted));
  assert.deepEqual(restored.items.map(item => item.id), [
    "planner::native-plan-user-1", "planner::msg-plan-1:thinking:0", "planner::msg-plan-1:text:0", "planner::history-t-assistant-entry-1",
    "executor::local-exec-user-1", "executor::codex-item-1", "executor::t-codex-turn-1",
    "planner::native-plan-user-2", "planner::msg-plan-2:thinking:0", "planner::msg-plan-2:text:0", "planner::history-t-assistant-entry-2",
    "executor::local-exec-user-2", "executor::codex-item-2", "executor::t-codex-turn-2",
  ]);
  for (const item of restoredPlanner.items) {
    if (item.kind !== "text" && item.kind !== "thinking") continue;
    const stable = `${item.messageId}:${item.kind}:0`;
    assert.deepEqual(restored.owners[`planner::${stable}`], { role: "planner", originalId: item.id });
  }
  assert.equal(restored.owners["executor::codex-item-1"].originalId, "codex-item-1");
  assert.ok(restored.order.includes("planner::local-plan-user-1"), "absent original user UUID survives");
  assert.ok(restored.order.includes("planner::t-live-result-1"), "absent original turn marker survives");
  assert.deepEqual(mergeRoomItems({ planner: restoredPlanner, executor: executor2 }, restored.order), restored);
  const replaySeed = persisted.map(id => /:(text|thinking):\d+$/.test(id) ? `${id}:73` : id);
  replaySeed.push("planner::msg-plan-1:text:0");
  assert.deepEqual(normalizeAgentRoom(room({ order: replaySeed })).order, persisted, "persisted replay suffixes normalize and deduplicate in place");
  assert.deepEqual(mergeRoomItems({ planner: restoredPlanner, executor: executor2 }, replaySeed), restored);
});

test("actual split Claude history records anchor per-kind ordinals across two cycles and multiple text blocks", () => {
  const line = event => ({ type: "line", event, now: 1_000 });
  const stream = event => line({ type: "stream_event", event });
  const blocks = cycle => [{ type: "thinking", thinking: `Reason ${cycle}` }, { type: "text", text: `Plan ${cycle}, part A` }, { type: "text", text: `Plan ${cycle}, part B` }];
  const liveTurn = (previous, cycle) => [
    { type: "send", id: `local-user-${cycle}`, text: `Plan ${cycle}`, now: 0 },
    stream({ type: "message_start", message: { id: `msg-split-${cycle}` } }),
    ...blocks(cycle).flatMap((content_block, at) => [
      stream({ type: "content_block_start", index: [0, 1, 3][at], content_block }),
      line({ type: "assistant", message: { id: `msg-split-${cycle}`, content: [content_block], stop_reason: at === 2 ? "end_turn" : null } }),
    ]),
    line({ type: "result", uuid: `live-result-${cycle}`, subtype: "success", is_error: false, duration_ms: 1_000 }),
  ].reduce(claudeReducer, previous);
  const execItems = cycle => [user(`executor-user-${cycle}`), { ...reply(`codex-result-${cycle}`), messageId: `codex-result-${cycle}` }];
  const planner1 = liveTurn(initialChatState(), 1), planner2 = liveTurn(planner1, 2);
  const executor = state([...execItems(1), ...execItems(2)]);
  assert.deepEqual(planner1.items.filter(item => item.kind === "text").map(item => item.id), ["msg-split-1:text:1", "msg-split-1:text:3"]);
  const rawSeed = [...planner1.items.map(item => `planner::${item.id}`), ...execItems(1).map(item => `executor::${item.id}`),
    ...planner2.items.slice(planner1.items.length).map(item => `planner::${item.id}`), ...execItems(2).map(item => `executor::${item.id}`)];
  const persisted = JSON.parse(JSON.stringify(normalizeAgentRoom(room({ order: rawSeed })).order));
  const entries = [1, 2].flatMap(cycle => [
    { type: "user", uuid: `native-user-${cycle}`, message: { role: "user", content: `Plan ${cycle}` } },
    ...blocks(cycle).map((block, at) => ({ type: "assistant", uuid: `split-record-${cycle}-${at}`,
      message: { id: `msg-split-${cycle}`, role: "assistant", content: [block], stop_reason: at === 2 ? "end_turn" : null } })),
  ]);
  const history = claudeReducer(initialChatState(), { type: "history", entries });
  assert.equal(history.historyCount, 10);
  assert.deepEqual(history.items.filter(item => item.kind === "text" && item.messageId === "msg-split-1").map(item => item.id), ["msg-split-1:text:0:2", "msg-split-1:text:0:3"]);
  const result = mergeRoomItems({ planner: freeze(history), executor: freeze(executor) }, freeze(persisted));
  assert.deepEqual(result.items.map(item => item.id), [
    "planner::native-user-1", "planner::msg-split-1:thinking:0", "planner::msg-split-1:text:0", "planner::msg-split-1:text:1", "planner::history-t-split-record-1-2",
    "executor::executor-user-1", "executor::codex-result-1",
    "planner::native-user-2", "planner::msg-split-2:thinking:0", "planner::msg-split-2:text:0", "planner::msg-split-2:text:1", "planner::history-t-split-record-2-2",
    "executor::executor-user-2", "executor::codex-result-2",
  ]);
  assert.deepEqual(result.owners["planner::msg-split-1:text:0"], { role: "planner", originalId: "msg-split-1:text:0:2" });
  assert.deepEqual(result.owners["planner::msg-split-1:text:1"], { role: "planner", originalId: "msg-split-1:text:0:3" });
  assert.equal(result.items.filter(item => item.kind === "text" && item.id.startsWith("planner::msg-split-1")).map(item => item.text).join(" / "), "Plan 1, part A / Plan 1, part B");
  assert.deepEqual(mergeRoomItems({ planner: history, executor }, rawSeed), result, "unconverted stream indices reconcile by kind encounter order");
  assert.deepEqual(mergeRoomItems({ planner: history, executor }, result.order), result, "ordinals survive repeated merges");
  const recoveredSeed = [...history.items.slice(0, 5).map(item => `planner::${item.id}`), ...execItems(1).map(item => `executor::${item.id}`),
    ...history.items.slice(5).map(item => `planner::${item.id}`), ...execItems(2).map(item => `executor::${item.id}`)];
  const recovered = normalizeAgentRoom(room({ order: recoveredSeed }));
  assert.ok(recovered.order.includes("planner::msg-split-1:text:0"));
  assert.ok(recovered.order.includes("planner::msg-split-1:text:1"), "separate index-zero records remain separate blocks");
  assert.deepEqual(mergeRoomItems({ planner: history, executor }, recovered.order).items, result.items);
});

test("routes explicit bilingual roles, planning commands and unambiguous provider mentions", () => {
  const raw = room();
  for (const prefix of ["/plan", "/planificar", "@planificador", "@planner", "@Claude", "@CLAUDE"]) {
    assert.deepEqual(routeRoomMessage(`  ${prefix} Build a search index.  `, raw), { kind: "plan", role: "planner", text: "Build a search index." });
    for (const phase of ["planning", "waiting"]) assert.deepEqual(routeRoomMessage(`${prefix} Keep keyboard access.`, room({ phase })), { kind: "message", role: "planner", text: "Keep keyboard access." });
  }
  for (const prefix of ["@ejecutor", "@executor", "@Codex", "@CODEX"]) assert.deepEqual(routeRoomMessage(`${prefix}\nRun tests.`, raw), { kind: "message", role: "executor", text: "Run tests." });
  const swapped = room(); swapped.planner.agent = agent("codex", "planner"); swapped.executor.agent = agent("claude", "executor");
  assert.deepEqual(routeRoomMessage("@Codex Make a plan.", swapped), { kind: "plan", role: "planner", text: "Make a plan." });
  assert.deepEqual(routeRoomMessage("@Claude Run tests.", swapped), { kind: "message", role: "executor", text: "Run tests." });
});

test("preserves plain text and missing-task drafts without guessing destinations", () => {
  const raw = room();
  for (const text of ["Implement the planner's idea", "Ask Claude to plan", "@plannerish Make a plan", "/planning work", "@executor: Run", "hello @planner work", "/plan", " /planificar  ", "@planificador\n", "@planner", "@ejecutor", "@executor  ", "@Claude", "@Codex", "", "  "]) {
    assert.deepEqual(routeRoomMessage(text, raw), { kind: "message", role: "executor", text });
  }
  for (const provider of ["claude", "codex"]) {
    const same = room({ active: "planner" }); same.planner.agent = agent(provider, "planner"); same.executor.agent = agent(provider, "executor");
    for (const text of ["@Claude Make a plan.", "@Codex Run tests."]) assert.deepEqual(routeRoomMessage(text, same), { kind: "message", role: "planner", text });
    assert.equal(routeRoomMessage("@planner Work", same).kind, "plan");
    assert.equal(routeRoomMessage("@executor Work", same).role, "executor");
  }
});

test("context uses existing handoff sanitation and limits across both role histories", () => {
  const delivered = buildHandoffPrompt({ id: "safe-handoff", createdAt: 1, sourceLabel: "Claude", sourceProvider: "claude", sourceSessionId: "source", cwd: source.cwd, content: "ORIGINAL_GOAL: improve keyboard search.", truncated: false }, "Continue with accessibility.");
  const merged = mergeRoomItems({ planner: state([user("first", delivered), thinking("private", "THINKING_PRIVATE"),
    tool("plan", "ExitPlanMode", { plan: "PLAN_VISIBLE: check focus." }, null)]), executor: state([
    { ...user("latest", "LATEST_REQUEST: verify navigation.\nAPI_KEY=INLINE_PRIVATE\n<environment_context>ENV_PRIVATE</environment_context>"), images: 1, previews: ["data:image/png;base64,IMAGE_PRIVATE"] },
    { ...permission("private"), input: { secret: "PERMISSION_PRIVATE" } }, tool("secret", "Read", { file_path: ".env" }, "ENV_FILE_PRIVATE"),
    tool("test", "Bash", { command: "npm test" }, "tests passed\npassword: PASSWORD_PRIVATE"), reply("done", "Latest visible result.")]) }, []);
  const result = roomConversationContext(freeze(merged.items), freeze(source));
  const expected = createHandoffContext({ ...initialChatState(), items: merged.items }, source, result.createdAt);
  assert.deepEqual(result, expected);
  assert.equal(result.imagesOmitted, 1);
  assert.ok(Buffer.byteLength(result.content, "utf8") <= 64 * 1024);
  for (const text of ["ORIGINAL_GOAL", "LATEST_REQUEST", "PLAN_VISIBLE", "tests passed", "Latest visible result"]) assert.ok(result.content.includes(text), text);
  assert.doesNotMatch(result.content, /THINKING_PRIVATE|INLINE_PRIVATE|ENV_PRIVATE|IMAGE_PRIVATE|PERMISSION_PRIVATE|ENV_FILE_PRIVATE|PASSWORD_PRIVATE|<!-- trex-handoff:/);
  assert.equal(merged.items[0].text, delivered);
});

test("room context bounds large histories and keeps original and latest user goals", () => {
  const items = [user("first", "ORIGINAL_TASK: improve search.")];
  for (let at = 0; at < 100; at++) items.push(reply(`answer-${at}`, "Visible answer 漢🦖 ".repeat(600)));
  items.push(user("last", "LATEST_TASK: verify keyboard access."));
  const result = roomConversationContext(items, source);
  assert.ok(Buffer.byteLength(result.content, "utf8") <= 64 * 1024);
  assert.equal(result.truncated, true);
  assert.match(result.content, /ORIGINAL_TASK/);
  assert.match(result.content, /LATEST_TASK/);
  assert.equal(result.content, Buffer.from(result.content, "utf8").toString("utf8"));
});

// --- Incremental deliveries: each role keeps its own conversation ---
const roomApi = await load("agentRoom");
const handoffApi = await load("handoff");
const ledger = items => mergeRoomItems({ planner: state(items.planner ?? []), executor: state(items.executor ?? []) }, []);

test("delivery cursors and setup targets persist, and older rooms without them still load", () => {
  const saved = room({ delivered: { planner: "planner::p1", executor: null }, setupContext: reference({ id: "prior_chat" }), setupRole: "executor",
    pending: { id: "delivery_2", role: "executor", reference: reference({ id: "ctx_2", pending: true }), cursor: "executor::e1" } });
  const result = normalizeAgentRoom(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(result.delivered, { planner: "planner::p1", executor: null });
  assert.equal(result.setupRole, "executor");
  assert.equal(result.pending.cursor, "executor::e1");
  assert.deepEqual(normalizeAgentRoom(JSON.parse(JSON.stringify(result))), result);
  const legacy = normalizeAgentRoom(room({ pending: { id: "delivery_1", role: "planner", reference: reference({ id: "ctx_1", pending: true }) } }));
  assert.equal(legacy.delivered, undefined); assert.equal(legacy.setupRole, undefined); assert.equal("cursor" in legacy.pending, false);
  const damaged = normalizeAgentRoom(room({ delivered: { planner: "no-role-prefix", executor: 7 }, setupRole: "nobody" }));
  assert.ok(damaged, "an unreadable cursor costs one full delivery, never the room");
  assert.deepEqual(damaged.delivered, {}); assert.equal(damaged.setupRole, undefined);
});

test("the first delivery carries the full context once; later ones only the other agent's new entries", () => {
  const merged = ledger({ planner: [user("p-user", "Planifica"), reply("p-reply", "Plan listo")], executor: [user("e-user", "Implementa"), tool("e-tool"), reply("e-reply", "Hecho")] });
  const first = roomApi.roomDelivery(room({}), merged, "planner", true);
  assert.equal(first.full, true);
  assert.deepEqual(first.items.map(item => item.id), ["executor::e-user", "executor::e-tool", "executor::e-reply"], "its own entries are already in its conversation");
  assert.equal(first.cursor, merged.order.at(-1));
  const fresh = roomApi.roomDelivery(room({}), merged, "executor", false);
  assert.equal(fresh.full, true); assert.equal(fresh.items.length, merged.items.length, "a new conversation receives everything");
  const later = roomApi.roomDelivery(room({ delivered: { planner: "executor::e-user" } }), merged, "planner", true);
  assert.equal(later.full, false);
  assert.deepEqual(later.items.map(item => item.id), ["executor::e-tool", "executor::e-reply"]);
  assert.equal(later.peerWork, true);
  const quiet = roomApi.roomDelivery(room({ delivered: { planner: merged.order.at(-1) } }), merged, "planner", true);
  assert.deepEqual(quiet.items, []); assert.equal(quiet.peerWork, false);
  const unknown = roomApi.roomDelivery(room({ delivered: { planner: "executor::vanished" } }), merged, "planner", true);
  assert.equal(unknown.full, true, "a cursor missing from the ledger resends the full context once");
});

test("incremental updates keep the newest entries, files and commands within their limit and filter secrets", () => {
  const items = [user("u", "Corrige el login"), tool("cmd", "Bash", { command: "npm test" }, "ok"), tool("edit", "Edit", { file_path: "src/login.ts" }),
    reply("old", "Resultado anterior largo. ".repeat(900)), reply("new", "Último resultado.\napi_key=FAKE_SECRET_123456789")];
  const result = handoffApi.roomUpdates(items, { user: "Usuario → Ejecutor", agent: "Ejecutor" }, 8 * 1024);
  assert.ok(Buffer.byteLength(result.text) <= 8 * 1024);
  assert.equal(result.truncated, true);
  assert.match(result.text, /Último resultado/);
  assert.match(result.text, /src\/login\.ts/);
  assert.doesNotMatch(result.text, /FAKE_SECRET/);
  assert.equal(roomApi.roomRequestText("# Solicitud actual del usuario\n\nArregla ## esto\n\n## Novedades de Ejecutor · Codex desde tu última entrega\n\nx"), "Arregla ## esto");
  assert.equal(roomApi.roomRequestText("# Solicitud actual del usuario\n\nSolo la tarea\n\n---\n## Estado del proyecto capturado por TREX\nmain"), "Solo la tarea");
  assert.equal(roomApi.roomRequestText("sin encabezado"), null);
});
