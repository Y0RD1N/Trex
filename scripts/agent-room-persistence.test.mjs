import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { normalizeConfig } = await load("api");
const { restoreAgentRoom } = await load("agentRoom");
const participant = (provider, name, conversationId) => ({
  agent: { profileId: name, profileName: name, provider, model: `${provider}-chosen`, effort: provider === "claude" ? "max" : "ultra",
    launch: { profileId: name, profileName: name, command: `${provider}-account`, args: "", shell: "pwsh", launchMode: "arg", env: { ACCOUNT_PATH: `D:/${name}` } } },
  conversationId, mode: provider === "claude" ? "acceptEdits" : "auto",
});
const room = () => ({ id: "room-123", planner: { ...participant("claude", "old-claude", "11111111-1111-4111-8111-111111111111"), mode: "plan" },
  executor: participant("codex", "old-codex", "22222222-2222-4222-8222-222222222222"), active: "executor", phase: "executing", cycle: 2,
  order: ["planner::plan-1", "executor::result-1", "planner::plan-2"], plan: null, error: null,
  pending: { id: "delivery-2", role: "executor", reference: { id: "context-2", pending: true, sourceLabel: "Planner", instruction: "Implementa el plan" } } });
const config = team => ({ ui: { lastTabs: [{ id: "t-existing", projectId: "project", kind: "claude", subtitle: "Chat compartido", agentRoom: team }] } });

test("a shared tab persists both provider identities even after launcher profiles change", () => {
  const first = normalizeConfig(config(room()));
  const second = normalizeConfig(JSON.parse(JSON.stringify(first)));
  assert.equal(second.ui.lastTabs.length, 1);
  assert.equal(second.ui.lastTabs[0].id, "t-existing");
  assert.deepEqual(second.ui.lastTabs[0].agentRoom, first.ui.lastTabs[0].agentRoom);
  assert.equal(second.ui.lastTabs[0].agentRoom.planner.agent.launch.env.ACCOUNT_PATH, "D:/old-claude");
  assert.equal(second.ui.lastTabs[0].agentRoom.executor.agent.effort, "ultra");
  assert.deepEqual(second.ui.lastTabs[0].agentRoom.order, room().order);
});

test("restoring an accepted-or-uncertain delivery requires a pause and retains the exact reference", () => {
  const saved = normalizeConfig(config(room())).ui.lastTabs[0].agentRoom;
  const restored = restoreAgentRoom(saved);
  assert.equal(restored.phase, "paused");
  assert.deepEqual(restored.pending, saved.pending);
  assert.equal(restored.executor.conversationId, saved.executor.conversationId);
  assert.equal(restored.cycle, 2);
  assert.equal(saved.phase, "executing");
});

test("a completed shared tab reopens completed with its choices and no pending work", () => {
  const saved = room(); saved.phase = "completed"; saved.pending = null;
  const restored = restoreAgentRoom(normalizeConfig(config(saved)).ui.lastTabs[0].agentRoom);
  assert.equal(restored.phase, "completed");
  assert.equal(restored.pending, null);
  assert.equal(restored.planner.agent.effort, "max");
  assert.equal(restored.executor.agent.model, "codex-chosen");
});

test("malformed room metadata cannot replace a recoverable normal conversation", () => {
  const bad = room(); bad.executor.agent.launch.profileId = "wrong-account";
  const value = config(bad); value.ui.lastTabs[0].conversationId = "11111111-1111-4111-8111-111111111111";
  const tab = normalizeConfig(value).ui.lastTabs[0];
  assert.equal(tab.agentRoom, null);
  assert.equal(tab.conversationId, value.ui.lastTabs[0].conversationId);
  const shell = config(room()); shell.ui.lastTabs[0].kind = "shell";
  assert.equal(normalizeConfig(shell).ui.lastTabs[0].agentRoom, null);
});

test("configuration accepts metadata only, dropping injected transcript bodies", () => {
  const saved = room(); saved.transcript = "PRIVATE_TRANSCRIPT"; saved.executor.messages = ["PRIVATE_MESSAGE"];
  const text = JSON.stringify(normalizeConfig(config(saved)).ui.lastTabs);
  assert.doesNotMatch(text, /PRIVATE_TRANSCRIPT|PRIVATE_MESSAGE/);
  assert.match(text, /context-2/);
});
