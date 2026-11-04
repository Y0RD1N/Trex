import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";
const { normalizeIntegrations, integrationInstructions, integrationRestrictions, assertIntegrationRestrictions } = await load("integrations");
const { normalizeConfig } = await load("api");
const { claudeChatFlags } = await load("claudeChat");
const { claudeInboxReply } = await load("inboxProtocol");
const off = { github: false, blender: false, hyperframes: false };

test("integration switches migrate old preferences and survive native-bound config normalization", () => {
  assert.deepEqual(normalizeIntegrations(undefined), { github: true, blender: true, hyperframes: true });
  const config = normalizeConfig({ settings: { integrations: { ...off, github: true } } });
  assert.deepEqual(config.settings.integrations, { ...off, github: true });
  assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(config))).settings.integrations, config.settings.integrations);
});
test("every provider receives only enabled application announcements", () => {
  for (const provider of ["claude", "codex", "trex", "antigravity"]) {
    assert.equal(integrationInstructions(provider, { applications: off }), "");
    const text = integrationInstructions(provider, { applications: { ...off, github: true } });
    assert.match(text, /GitHub/); assert.doesNotMatch(text, /Blender|HyperFrames|desktop_|browser_navigate/);
  }
});
test("app restrictions never enable a disabled CLI profile and require a native acknowledgement", () => {
  assert.deepEqual(integrationRestrictions(), { tools: {} });
  assert.deepEqual(integrationRestrictions({ ...off, github: true }), { tools: { blender: false, hyperframes: false } });
  assert.throws(() => assertIntegrationRestrictions({}, off), /no confirmó/);
  assert.throws(() => assertIntegrationRestrictions({ applicationIntegrations: { ...off, github: true } }, off));
  assert.doesNotThrow(() => assertIntegrationRestrictions({ applicationIntegrations: off }, off));
});
test("Claude launch and inbox initialization cannot reintroduce a disabled integration", async () => {
  const context = { applications: off };
  const flags = claudeChatFlags(null, null, { integrations: context });
  assert.doesNotMatch(flags[flags.indexOf("--append-system-prompt") + 1], /GitHub|Blender|HyperFrames/);
  const response = await claudeInboxReply("init", { subtype: "mcp_message", server_name: "trex_inbox", message: { id: 1, method: "initialize", params: {} } }, async () => { throw Error("unexpected queue read"); }, context);
  const instructions = JSON.parse(response.line).response.response.mcp_response.result.instructions;
  assert.doesNotMatch(instructions, /GitHub|Blender|HyperFrames/); assert.match(instructions, /task|plan/i);
});
const { integrationContext, detectedIntegrations } = await load("integrations");
const { BROWSER_INSTRUCTIONS } = await load("browser");
test("only enabled applications that were not detected as missing are announced; preferences stay untouched", () => {
  const preferences = { github: true, blender: true, hyperframes: true };
  const context = integrationContext({ integrations: preferences }, { available: { github: true, blender: false, hyperframes: false } });
  for (const provider of ["claude", "codex", "trex", "antigravity"]) {
    const text = integrationInstructions(provider, context);
    assert.match(text, /GitHub/); assert.doesNotMatch(text, /Blender|HyperFrames/);
  }
  assert.deepEqual(preferences, { github: true, blender: true, hyperframes: true });
  assert.deepEqual(integrationRestrictions(preferences), { tools: {} }, "detection never becomes a saved restriction");
  assert.equal(integrationInstructions("claude", integrationContext({ integrations: preferences }, { available: { github: false, blender: false, hyperframes: false } })), "");
  assert.match(integrationInstructions("claude", integrationContext({ integrations: preferences })), /GitHub.*Blender.*HyperFrames/s, "unknown availability keeps announcing enabled apps");
});
test("browser guidance needs a browser attached to that session, once per provider", () => {
  const enabled = { integrations: off, browser: { enabled: true } };
  assert.equal(integrationContext(enabled).browser, false, "the preference alone does not attach a browser");
  assert.equal(integrationInstructions("codex", integrationContext(enabled)), "");
  const codex = integrationInstructions("codex", integrationContext(enabled, { browser: true }));
  assert.equal(codex, BROWSER_INSTRUCTIONS);
  assert.match(integrationInstructions("claude", integrationContext(enabled, { browser: true })), /browser_navigate/);
  assert.ok(Buffer.byteLength(BROWSER_INSTRUCTIONS) < 700);
});
test("without the native app, detection degrades to the enabled preferences synchronously", () => {
  assert.equal(detectedIntegrations("D:/offline-project"), null);
  assert.equal(detectedIntegrations("D:/offline-project"), null);
});
