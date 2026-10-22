import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { initialChatState, normalizeModelChoice } = await load("chatState");
const { chatReducer, claudeChatFlags } = await load("claudeChat");
const { codexReducer, codexLaunch, turnOverrides } = await load("codexChat");
const { normalizeConfig } = await load("api");

test("el modelo se elige antes del primer arranque y Claude lo conserva al recuperar historial", () => {
  const initial = initialChatState("plan", "opus");
  const restored = chatReducer(initial, { type: "history", entries: [] });
  assert.equal(restored.modelChoice, "opus");
  const flags = claudeChatFlags("--model sonnet", null, { model: restored.modelChoice });
  assert.deepEqual(flags.slice(-2), ["--model", "opus"]);
  assert.equal(restored.modeChoice, "plan");
});

test("Codex aplica el modelo elegido al primer turno y a la colaboración aunque el perfil tenga otro", () => {
  const initial = initialChatState("plan", "modelo-elegido");
  const opened = codexReducer(initial, { type: "thread", response: { thread: { id: "thread" }, model: "modelo-del-perfil" } });
  const restored = codexReducer(opened, { type: "history", turns: [] });
  const overrides = turnOverrides({ mode: restored.modeChoice, model: restored.modelChoice, effort: null }, { model: restored.model, effort: null });
  assert.equal(overrides.model, "modelo-elegido");
  assert.equal(overrides.collaborationMode.settings.model, "modelo-elegido");
});

test("predeterminado conserva el modelo del perfil sin añadir una elección explícita", () => {
  const state = initialChatState(null, null);
  const launch = codexLaunch("--model modelo-del-perfil");
  assert.equal(state.modelChoice, null);
  assert.ok(!claudeChatFlags("--model sonnet", null, { model: state.modelChoice }).includes("--model"));
  assert.equal(launch.thread.model, "modelo-del-perfil");
  assert.ok(!("model" in turnOverrides({ mode: null, model: state.modelChoice, effort: null }, { model: "modelo-del-perfil", effort: null })));
});

test("la configuración restaura la elección por pestaña y descarta identificadores malformados o de shells", () => {
  const config = normalizeConfig({ ui: { lastTabs: [
    { projectId: "p", kind: "claude", chatModel: "opus" },
    { projectId: "p", kind: "codex", chatModel: "provider/model:version" },
    { projectId: "p", kind: "claude" },
    { projectId: "p", kind: "codex", chatModel: "modelo\n--extra" },
    { projectId: "p", kind: "shell", chatModel: "opus" },
  ] } });
  assert.deepEqual(config.ui.lastTabs.map(tab => tab.chatModel), ["opus", "provider/model:version", null, null, null]);
  for (const value of [null, {}, 42, "", " ", "a".repeat(257), "opus --extra", "opus\0", "modelo\targumento"]) assert.equal(normalizeModelChoice(value), null);
  assert.equal(normalizeModelChoice("  opus  "), "opus");
});
