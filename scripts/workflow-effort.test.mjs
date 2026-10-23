import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { normalizeAgentWorkflow, workflowEffortLevels } = await load("agentWorkflow");
const { initialChatState } = await load("chatState");
const { chatReducer, claudeChatFlags } = await load("claudeChat");
const { codexReducer, turnOverrides } = await load("codexChat");
const { normalizeConfig } = await load("api");

const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const prototypeNames = ["constructor", "__proto__", "prototype", "toString", "valueOf", "hasOwnProperty"];
const invalidEfforts = [
  "", " ", "High", "maximum", "future-level", ...prototypeNames,
  "high --model other", "high\n--extra", "high\0", 0, 1, true, false,
  [], ["high"], {}, { effort: "high" }, new String("high"), Object.create(null),
];
const model = (value, efforts, extra = {}) => ({
  value, displayName: value, description: "", efforts, defaultEffort: efforts[0] ?? null, ...extra,
});
const freeze = value => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const agent = (provider, model) => ({
  profileId: `${provider}-account`, profileName: `${provider} account`, provider, model,
  launch: { profileId: `${provider}-account`, profileName: `${provider} account`,
    command: `${provider}-personal`, args: "--verbose", shell: "pwsh", launchMode: "arg",
    env: { ACCOUNT_DIR: `D:/accounts/${provider}` } },
});
const workflow = () => ({
  id: "workflow-effort", role: "planner", status: "planning",
  planner: agent("claude", "planner-model"), executor: agent("codex", "executor-model"),
  peerTabId: null, plan: null, error: null,
});

test("workflow effort capabilities belong to the exact selected catalog entry", () => {
  const models = freeze([
    model("default", ["medium"], { resolvedModel: "engine", defaultEffort: "medium" }),
    model("alias", ["low", "high"], { resolvedModel: "engine" }),
    model("engine", ["max", "ultra"]),
    model("no-effort", []),
  ]);
  assert.deepEqual(workflowEffortLevels(models, "alias"), ["low", "high"]);
  assert.deepEqual(workflowEffortLevels(models, "engine"), ["max", "ultra"]);
  assert.deepEqual(workflowEffortLevels(models, "default"), ["medium"]);
  assert.deepEqual(workflowEffortLevels(models, "no-effort"), []);
});

test("a profile default, blank or unknown selection never borrows another model's effort levels", () => {
  const models = [model("default", ["high"]), model("alias", ["ultra"], { resolvedModel: "unlisted-engine" })];
  for (const selected of [null, undefined, "", " ", "missing", "Alias", " alias ", "unlisted-engine"]) {
    assert.deepEqual(workflowEffortLevels(models, selected), [], `selection ${String(selected)}`);
  }
  assert.deepEqual(workflowEffortLevels([], "alias"), []);
});

test("workflow effort levels deduplicate in advertised order and discard unrecognized capabilities", () => {
  const advertised = freeze(["ultra", "high", "ultra", "future-level", "max", "high", "none",
    ...prototypeNames, "", "HIGH", " high ", "high --extra"]);
  const models = freeze([model("selected", advertised, { defaultEffort: "medium" })]);
  const result = workflowEffortLevels(models, "selected");
  assert.deepEqual(result, ["ultra", "high", "max", "none"]);
  result.push("low");
  assert.deepEqual(workflowEffortLevels(models, "selected"), ["ultra", "high", "max", "none"]);
});

test("a model with no recognized effort capabilities does not acquire its advertised default", () => {
  assert.deepEqual(workflowEffortLevels([model("selected", ["future-level", "constructor"], { defaultEffort: "high" })], "selected"), []);
});

for (const role of ["planner", "executor"]) {
  test(`${role}: legacy workflow metadata remains compatible without an effort property`, () => {
    const raw = freeze(workflow());
    const normalized = normalizeAgentWorkflow(raw);
    assert.deepEqual(normalized, raw);
    assert.equal(Object.hasOwn(normalized[role], "effort"), false);
    assert.notStrictEqual(normalized[role].launch, raw[role].launch);
    const withUndefined = workflow();
    withUndefined[role].effort = undefined;
    assert.equal(Object.hasOwn(normalizeAgentWorkflow(withUndefined)[role], "effort"), false);
  });

  test(`${role}: recognized effort choices and explicit provider defaults survive normalization`, () => {
    for (const effort of [...levels, null, "  high  "]) {
      const raw = workflow();
      raw[role].effort = effort;
      freeze(raw);
      const normalized = normalizeAgentWorkflow(raw);
      assert.ok(normalized, `effort ${String(effort)}`);
      assert.equal(normalized[role].effort, effort === "  high  " ? "high" : effort);
      assert.equal(Object.hasOwn(normalized[role], "effort"), true);
      assert.equal(Object.hasOwn(normalized[role === "planner" ? "executor" : "planner"], "effort"), false);
      assert.equal(raw[role].effort, effort, "normalization must not change the saved choice");
    }
  });

  test(`${role}: malformed and prototype effort values reject the workflow instead of falling back`, () => {
    for (const effort of invalidEfforts) {
      const raw = workflow();
      raw[role].effort = effort;
      assert.equal(normalizeAgentWorkflow(raw), null, `invalid effort ${JSON.stringify(effort)}`);
    }
  });
}

test("planner and executor preserve independent effort choices even on the same account and model", () => {
  const raw = workflow();
  raw.executor = structuredClone(raw.planner);
  raw.planner.effort = "low";
  raw.executor.effort = "max";
  const normalized = normalizeAgentWorkflow(freeze(raw));
  assert.equal(normalized.planner.effort, "low");
  assert.equal(normalized.executor.effort, "max");
  assert.deepEqual(normalizeAgentWorkflow(JSON.parse(JSON.stringify(normalized))), normalized);
});

test("initial chat state carries a chosen effort before any provider process starts", () => {
  for (const effort of levels) {
    const state = initialChatState("plan", "chosen-model", effort);
    assert.equal(state.effortChoice, effort);
    assert.equal(state.effort, effort);
    assert.equal(state.modelChoice, "chosen-model");
    assert.equal(state.modeChoice, "plan");
    assert.equal(state.process, "starting");
    assert.equal(state.sessionId, null);
  }
  assert.equal(initialChatState(null, null, " high ").effortChoice, "high");
});

test("initial chat state keeps old call signatures and invalid effort values at the provider default", () => {
  for (const state of [initialChatState(), initialChatState("plan"), initialChatState("plan", "chosen-model"),
    ...[null, undefined, ...invalidEfforts].map(effort => initialChatState(null, null, effort))]) {
    assert.equal(state.effortChoice, null);
    assert.equal(state.effort, null);
  }
});

test("config JSON round trips preserve each stage's effort, tab choice and original account snapshot", () => {
  const saved = workflow();
  saved.planner.effort = "high";
  saved.executor.effort = "ultra";
  const raw = freeze({ settings: { profiles: [] }, ui: { lastTabs: [
    { id: "t-planner", projectId: "p", kind: "claude", chatModel: saved.planner.model, chatEffort: "high", workflow: saved },
    { id: "t-executor", projectId: "p", kind: "codex", chatModel: saved.executor.model, chatEffort: "ultra",
      workflow: { ...saved, role: "executor", status: "executing" } },
    { id: "t-legacy", projectId: "p", kind: "claude", workflow: workflow() },
    { id: "t-default", projectId: "p", kind: "codex", chatEffort: null,
      workflow: { ...workflow(), planner: { ...saved.planner, effort: null }, executor: { ...saved.executor, effort: null } } },
  ] } });
  const first = normalizeConfig(raw);
  const restored = normalizeConfig(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(restored.ui.lastTabs, first.ui.lastTabs);
  assert.deepEqual(restored.ui.lastTabs.map(tab => tab.chatEffort), ["high", "ultra", null, null]);
  for (const tab of restored.ui.lastTabs.slice(0, 2)) {
    assert.deepEqual(tab.workflow.planner, saved.planner);
    assert.deepEqual(tab.workflow.executor, saved.executor);
  }
  assert.equal(Object.hasOwn(restored.ui.lastTabs[2].workflow.planner, "effort"), false);
  assert.equal(Object.hasOwn(restored.ui.lastTabs[2].workflow.executor, "effort"), false);
  assert.equal(restored.ui.lastTabs[3].workflow.planner.effort, null);
  assert.equal(restored.ui.lastTabs[3].workflow.executor.effort, null);
});

test("config normalization discards invalid tab efforts, invalid workflows and shell effort metadata", () => {
  const invalidWorkflow = workflow();
  invalidWorkflow.executor.effort = "constructor";
  const raw = { ui: { lastTabs: [
    ...invalidEfforts.map(chatEffort => ({ projectId: "p", kind: "codex", chatEffort })),
    { projectId: "p", kind: "claude", chatEffort: " high ", workflow: invalidWorkflow },
    { projectId: "p", kind: "shell", chatEffort: "ultra", workflow: workflow() },
  ] } };
  const tabs = normalizeConfig(raw).ui.lastTabs;
  assert.deepEqual(tabs.slice(0, invalidEfforts.length).map(tab => tab.chatEffort), invalidEfforts.map(() => null));
  assert.equal(tabs.at(-2).chatEffort, "high");
  assert.equal(tabs.at(-2).workflow, null);
  assert.equal(tabs.at(-1).chatEffort, null);
  assert.equal(tabs.at(-1).workflow, null);
});

test("Claude keeps the initial workflow effort through history, reset and restart flags", () => {
  let state = initialChatState("plan", "planner-model", "max");
  for (const action of [{ type: "history", entries: [] }, { type: "spawned" }, { type: "reset" }]) state = chatReducer(state, action);
  assert.equal(state.effortChoice, "max");
  assert.equal(state.effort, "max");
  const flags = claudeChatFlags("--model profile-model --effort low", "saved-session",
    { model: state.modelChoice, effort: state.effortChoice, mode: state.modeChoice });
  assert.deepEqual(flags.slice(-6), ["--model", "planner-model", "--effort", "max", "--permission-mode", "plan"]);
  assert.equal(flags.filter(flag => flag === "--effort").length, 1);
  assert.equal(flags[flags.indexOf("--resume") + 1], "saved-session");
});

test("Claude default effort leaves the profile's effort arguments in charge", () => {
  const state = initialChatState("plan", "planner-model");
  const flags = claudeChatFlags("--effort low", null, { effort: state.effortChoice });
  assert.equal(flags.includes("--effort"), false);
});

test("Codex initial workflow effort overrides thread defaults in the turn and collaboration settings", () => {
  let state = initialChatState("plan", "planner-model", "ultra");
  state = codexReducer(state, { type: "thread", response: { thread: { id: "thread" }, model: "profile-model", reasoningEffort: "low" } });
  for (const action of [{ type: "history", turns: [] }, { type: "spawned" }, { type: "reset" }]) state = codexReducer(state, action);
  assert.equal(state.effort, "ultra");
  assert.equal(state.effortChoice, "ultra");
  const overrides = turnOverrides({ mode: state.modeChoice, model: state.modelChoice, effort: state.effortChoice },
    { model: "profile-model", effort: "low" });
  assert.equal(overrides.effort, "ultra");
  assert.equal(overrides.model, "planner-model");
  assert.deepEqual(overrides.collaborationMode, { mode: "plan", settings: {
    model: "planner-model", reasoning_effort: "ultra", developer_instructions: null,
  } });
});

test("Codex default effort adopts the thread's value without adding an explicit turn effort", () => {
  const state = codexReducer(initialChatState("plan", "planner-model"), {
    type: "thread", response: { thread: { id: "thread" }, model: "profile-model", reasoningEffort: "xhigh" },
  });
  assert.equal(state.effortChoice, null);
  assert.equal(state.effort, "xhigh");
  const current = { model: state.model, effort: state.effort };
  const overrides = turnOverrides({ mode: state.modeChoice, model: state.modelChoice, effort: state.effortChoice }, current);
  assert.equal(Object.hasOwn(overrides, "effort"), false);
  assert.equal(overrides.collaborationMode.settings.reasoning_effort, "xhigh");
  assert.deepEqual(turnOverrides({ mode: null, model: null, effort: null }, current), {});
});
