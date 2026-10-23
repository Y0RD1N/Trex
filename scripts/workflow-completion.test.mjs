import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { initialChatState } = await load("chatState");
const { chatReducer } = await load("claudeChat");
const { codexReducer } = await load("codexChat");
const send = (id) => ({ type: "send", id, text: id, now: 1 });
const line = (event) => ({ type: "line", event, now: 1000 });
const rpc = (method, params) => ({ type: "rpc", message: { method, params }, scope: "process", now: 1000 });
const providers = [
  {
    name: "Claude", reducer: chatReducer,
    response: (id, text) => line({ type: "assistant", message: { id, content: [{ type: "text", text }] } }),
    finish: (id, status = "completed", extra = {}) => line({ type: "result", uuid: id,
      subtype: status === "completed" ? "success" : status === "interrupted" ? "error_during_execution" : status, ...extra }),
    history: () => ({ type: "history", entries: [
      { type: "user", uuid: "old-user", message: { role: "user", content: "old request" } },
      { type: "assistant", message: { id: "old-response", stop_reason: "end_turn", content: [{ type: "text", text: "old plan" }] } },
      { type: "result", uuid: "old-turn", subtype: "success" },
    ] }),
  },
  {
    name: "Codex", reducer: codexReducer,
    response: (id, text) => rpc("item/completed", { item: { type: "agentMessage", id, text } }),
    finish: (id, status = "completed", extra = {}) => rpc("turn/completed", { turn: { id, status, error: null, ...extra } }),
    history: () => ({ type: "history", turns: [{ id: "old-turn", status: "completed", items: [
      { type: "userMessage", id: "old-user", content: [{ type: "text", text: "old request" }] },
      { type: "agentMessage", id: "old-response", text: "old plan" },
    ] }] }),
  },
];
const run = (provider, actions, state = initialChatState()) => actions.reduce(provider.reducer, state);
const responseTexts = (state) => state.items.filter(item => state.lastCompletion.itemIds.includes(item.id) && item.kind === "text").map(item => item.text);

for (const provider of providers) {
  test(`${provider.name}: live success identifies its local messages and only its own response`, () => {
    let state = run(provider, [provider.history(), send("plan"), provider.response("plan-response", "current plan")]);
    assert.equal(state.lastCompletion, null, "streamed/final text and loaded history are not terminal success");
    state = provider.reducer(state, provider.finish("plan-turn"));
    assert.equal(state.lastCompletion.status, "completed");
    assert.deepEqual(state.lastCompletion.messageIds, ["plan"]);
    assert.deepEqual(responseTexts(state), ["current plan"]);
    const completion = state.lastCompletion;
    assert.equal(provider.reducer(state, provider.finish("plan-turn")).lastCompletion, completion);
    assert.equal(provider.reducer(state, provider.history()).lastCompletion, completion, "hydration must not republish a completion");
    state = run(provider, [send("execute"), provider.response("execute-response", "implementation"), provider.finish("execute-turn")], state);
    assert.notEqual(state.lastCompletion.id, completion.id);
    assert.deepEqual(state.lastCompletion.messageIds, ["execute"]);
    assert.deepEqual(responseTexts(state), ["implementation"]);
  });

  test(`${provider.name}: history arriving mid-response cannot shift the completion's response`, () => {
    let state = run(provider, [send("live"), provider.response("live-response", "live plan"), provider.history(), provider.history()]);
    assert.equal(state.lastCompletion, null);
    state = provider.reducer(state, provider.finish("live-turn"));
    assert.deepEqual(responseTexts(state), ["live plan"]);
    assert.deepEqual(state.lastCompletion.messageIds, ["live"]);
  });

  for (const status of ["interrupted", "failed", "cancelled", "canceled", "unknown", ""]) {
    test(`${provider.name}: ${JSON.stringify(status)} terminal cannot authorize execution`, () => {
      const state = run(provider, [send("plan"), provider.response("partial", "partial plan"), provider.finish("terminal", status)]);
      assert.notEqual(state.lastCompletion.status, "completed");
      assert.deepEqual(state.lastCompletion.messageIds, ["plan"]);
      assert.equal(state.pendingTurns, 0);
      assert.equal(provider.reducer(state, provider.finish("terminal")).lastCompletion, state.lastCompletion,
        "a contradictory duplicate success cannot replace the terminal outcome");
    });
  }

  test(`${provider.name}: lifecycle changes clear live success and cannot replay it`, () => {
    const done = run(provider, [send("plan"), provider.response("response", "plan"), provider.finish("done")]);
    for (const action of [{ type: "reset" }, { type: "rewind", id: "plan", sessionId: "rewound" }, { type: "spawned" }]) {
      const cleared = provider.reducer(done, action);
      assert.equal(cleared.lastCompletion, null);
      assert.equal(cleared.turnItemStart, null);
    }
    const spawned = provider.reducer(done, { type: "spawned" });
    assert.equal(provider.reducer(spawned, provider.finish("done")).lastCompletion, null);
    const pending = run(provider, [send("next"), { type: "spawned" }, provider.response("next-response", "next plan"), provider.finish("next-turn")], done);
    assert.deepEqual(responseTexts(pending), ["next plan"], "spawning after send preserves the current cursor");
  });

  for (const [action, expected] of [
    [{ type: "spawnFailed", message: "missing executable" }, "failed"],
    [{ type: "exit", code: 1 }, "failed"],
    [{ type: "exit", code: 0 }, "interrupted"],
    [{ type: "exit", code: null }, "interrupted"],
  ]) {
    test(`${provider.name}: ${action.type} (${action.code ?? "no code"}) never succeeds for pending work`, () => {
      const state = run(provider, [send("plan"), action]);
      assert.equal(state.lastCompletion.status, expected);
      assert.deepEqual(state.lastCompletion.messageIds, ["plan"]);
      assert.equal(state.pendingTurns, 0);
      assert.equal(provider.reducer(state, action).lastCompletion, state.lastCompletion);
    });
  }

  test(`${provider.name}: terminal deduplication survives more than 64 later turns`, () => {
    let state = initialChatState();
    for (let index = 0; index < 70; index++) state = run(provider, [send(`u${index}`), provider.finish(`t${index}`)], state);
    state = provider.reducer(state, send("next"));
    const before = state;
    state = provider.reducer(state, provider.finish("t0"));
    assert.equal(state.lastCompletion, before.lastCompletion);
    assert.deepEqual(state.pendingMessageIds, ["next"]);
  });

  test(`${provider.name}: queued inbox messages are not attributed as separately submitted planning turns`, () => {
    const state = run(provider, [send("plan"), { type: "queuedRead", messages: [{ id: "inbox", text: "context", previews: [] }] },
      provider.response("response", "plan"), provider.finish("plan-turn")]);
    assert.deepEqual(state.lastCompletion.messageIds, ["plan"]);
    assert.deepEqual(responseTexts(state), ["plan"]);
    assert.ok(!state.lastCompletion.itemIds.includes("inbox"));
  });
}

test("Claude: merged turns preserve later sends and isolate the response after each terminal", () => {
  const provider = providers[0];
  let state = run(provider, [send("u1"), send("u2"), send("u3"), provider.response("first", "first plan"),
    provider.finish("r1", "completed", { user_message_uuids: ["u1", "u2"] })]);
  assert.deepEqual(state.lastCompletion.messageIds, ["u1", "u2"]);
  assert.deepEqual(state.pendingMessageIds, ["u3"]);
  assert.deepEqual(responseTexts(state), ["first plan"]);
  const completion = state.lastCompletion;
  state = run(provider, [provider.response("second", "second plan"),
    provider.finish("different-stale-id", "completed", { user_message_uuid: "u1" })], state);
  assert.equal(state.lastCompletion, completion);
  assert.deepEqual(state.pendingMessageIds, ["u3"]);
  state = provider.reducer(state, provider.finish("r3", "completed", { user_message_uuid: "u3" }));
  assert.deepEqual(state.lastCompletion.messageIds, ["u3"]);
  assert.deepEqual(responseTexts(state), ["second plan"]);
});

test("Claude: older unidentifiable terminals are deduplicated conservatively", () => {
  const provider = providers[0];
  const terminal = line({ type: "result", subtype: "success" });
  const state = run(provider, [send("one"), terminal, send("two")]);
  const duplicate = provider.reducer(state, terminal);
  assert.equal(duplicate.lastCompletion, state.lastCompletion);
  assert.deepEqual(duplicate.pendingMessageIds, ["two"]);
});

test("Claude: a success subtype with an error is a failed completion", () => {
  const provider = providers[0];
  for (const extra of [{ is_error: true }, { errors: ["limit reached"] }, { error: "invalid credentials" }]) {
    const state = run(provider, [send("plan"), provider.finish("error", "completed", extra)]);
    assert.equal(state.lastCompletion.status, "failed");
  }
});

test("Claude: cancellation markers and failed sends cannot be followed by success for the same message", () => {
  const provider = providers[0];
  const interrupted = run(provider, [send("plan"), line({ type: "user", message: { content: "[Request interrupted by user]" } }), provider.finish("late-success")]);
  assert.equal(interrupted.lastCompletion.status, "interrupted");
  const failed = run(provider, [send("plan"), { type: "sendFailed", id: "plan", message: "write failed" }, provider.finish("late-success")]);
  assert.equal(failed.lastCompletion.status, "failed");
});

test("Claude: assistant acknowledgements and interrupt receipts attribute only the consumed messages", () => {
  const provider = providers[0];
  const merged = run(provider, [send("one"), send("two"), line({ type: "assistant", user_message_uuids: ["one", "two"], message: { id: "m", content: [] } }),
    provider.finish("merged")]);
  assert.deepEqual(merged.lastCompletion.messageIds, ["one", "two"]);
  const stopped = run(provider, [send("one"), send("two"), line({ type: "control_response", response: { response: { still_queued: ["two"] } } }),
    provider.finish("stopped", "interrupted")]);
  assert.deepEqual(stopped.lastCompletion.messageIds, ["one"]);
  assert.deepEqual(stopped.pendingMessageIds, ["two"]);
});

test("Codex: old, hydrated and unidentified terminals cannot close a newly bound turn", () => {
  const provider = providers[1];
  const state = run(provider, [provider.history(), send("plan"), { type: "bindTurn", id: "plan", turnId: "current" }]);
  for (const terminal of [provider.finish("old-turn"), provider.finish("different-turn"), rpc("turn/completed", { turn: { status: "completed" } })]) {
    const next = provider.reducer(state, terminal);
    assert.equal(next.lastCompletion, null);
    assert.deepEqual(next.pendingMessageIds, ["plan"]);
  }
  const done = provider.reducer(state, provider.finish("current"));
  assert.equal(done.lastCompletion.status, "completed");
});

test("Codex: completion error data, failed start and non-retryable errors never succeed", () => {
  const provider = providers[1];
  const errored = run(provider, [send("plan"), provider.finish("turn", "completed", { error: { message: "provider error" } })]);
  assert.equal(errored.lastCompletion.status, "failed");
  const pending = run(provider, [send("plan"), rpc("turn/started", { turn: { id: "turn" } })]);
  const retry = provider.reducer(pending, rpc("error", { turnId: "turn", willRetry: true, error: { message: "retrying" } }));
  assert.equal(retry.lastCompletion, null);
  const failed = run(provider, [rpc("error", { turnId: "turn", willRetry: false, error: { message: "failure" } }), provider.finish("turn")], pending);
  assert.equal(failed.lastCompletion.status, "failed");
  const rejected = run(provider, [{ type: "turnFailed", message: "start failed" }, provider.finish("turn")], pending);
  assert.equal(rejected.lastCompletion.status, "failed");
  assert.deepEqual(rejected.lastCompletion.messageIds, ["plan"]);
});

test("provider notifications from another session and out-of-order turn starts cannot complete current work", () => {
  let claude = run(providers[0], [line({ type: "system", subtype: "init", session_id: "current" }), send("plan")]);
  claude = providers[0].reducer(claude, providers[0].finish("stale", "completed", { session_id: "other" }));
  assert.equal(claude.lastCompletion, null);
  assert.deepEqual(claude.pendingMessageIds, ["plan"]);
  let codex = run(providers[1], [{ type: "thread", response: { thread: { id: "current" } } }, send("plan"), rpc("turn/started", { turn: { id: "live" } })]);
  codex = run(providers[1], [rpc("turn/started", { turn: { id: "stale" } }), { type: "turnStarted", turnId: "stale" },
    rpc("turn/completed", { threadId: "other", turn: { id: "live", status: "completed" } })], codex);
  assert.equal(codex.turnId, "live");
  assert.equal(codex.lastCompletion, null);
  assert.deepEqual(codex.pendingMessageIds, ["plan"]);
});

test("provider plan content alone does not publish completion", () => {
  const claude = run(providers[0], [send("plan"), line({ type: "control_request", request_id: "approval", request: {
    subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "plan" },
  } })]);
  assert.equal(claude.lastCompletion, null);
  assert.equal(claude.items.at(-1).state, "pending");
  const codex = run(providers[1], [send("plan"), rpc("item/completed", { item: { type: "plan", id: "plan-item", text: "plan" } })]);
  assert.equal(codex.lastCompletion, null);
  const finished = providers[1].reducer(codex, providers[1].finish("turn"));
  assert.ok(finished.lastCompletion.itemIds.includes("plan-item"));
});
