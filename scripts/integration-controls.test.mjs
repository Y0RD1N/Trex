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
