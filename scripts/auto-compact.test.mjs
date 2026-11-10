import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const auto = await load("autoCompact"), api = await load("api");
const on = (provider, tokens) => ({ ...auto.normalizeAutoCompact(null), [provider]: { enabled: true, tokens } });

test("automatic context summary is off until the user turns it on", () => {
  const settings = api.normalizeConfig({}).settings.autoCompact;
  assert.deepEqual(settings, { claude: { enabled: false, tokens: 400_000 }, codex: { enabled: false, tokens: 300_000 }, trex: { enabled: false, tokens: 128_000 } });
  for (const provider of ["claude", "codex", "trex", "antigravity"]) assert.equal(auto.autoCompactTokens(settings, provider), null);
  assert.deepEqual(api.DEFAULT_SETTINGS.autoCompact, settings);
  // With the option off, each assistant starts exactly as before.
  assert.deepEqual(auto.claudeAutoCompactEnv(auto.claudeAutoCompact(settings, null)), {});
  assert.deepEqual(auto.codexAutoCompactFlags(auto.codexAutoCompact(settings, ["app-server"])), []);
  assert.deepEqual(auto.trexAutoCompactSettings(auto.autoCompactTokens(settings, "trex")), {});
});

test("a saved threshold alone never enables it, and odd values fall back or are clamped", () => {
  const saved = api.normalizeConfig({ settings: { autoCompact: {
    claude: { enabled: "yes", tokens: 250_000 }, codex: { enabled: true, tokens: 10 }, trex: { enabled: true, tokens: 0 }, antigravity: { enabled: true, tokens: 5 },
  } } }).settings.autoCompact;
  assert.deepEqual(saved.claude, { enabled: false, tokens: 250_000 });
  assert.deepEqual(saved.codex, { enabled: true, tokens: 50_000 }, "below the minimum is raised to it");
  assert.deepEqual(saved.trex, { enabled: true, tokens: 128_000 }, "0 is what the native configuration stores before a threshold is chosen");
  assert.equal("antigravity" in saved, false);
  assert.equal(auto.autoCompactThreshold("claude", 5_000_000), 1_000_000);
  assert.equal(auto.autoCompactThreshold("claude", 399_999.6), 400_000);
  assert.equal(auto.autoCompactThreshold("claude", Number.NaN), 400_000);
  assert.deepEqual(auto.normalizeAutoCompact("on"), auto.normalizeAutoCompact(null));
});

test("each assistant receives the threshold through its own mechanism", () => {
  assert.deepEqual(auto.claudeAutoCompactEnv(auto.claudeAutoCompact(on("claude", 400_000), "--model opus")), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" });
  assert.deepEqual(auto.codexAutoCompactFlags(auto.codexAutoCompact(on("codex", 250_000), ["app-server"])), ["-c", "model_auto_compact_token_limit=250000"]);
  assert.deepEqual(auto.trexAutoCompactSettings(auto.autoCompactTokens(on("trex", 200_000), "trex")), { context: { autoCompact: true, maxActiveTokens: 200_000 } });
  // Turning it on for one assistant does not touch the others.
  assert.equal(auto.autoCompactTokens(on("claude", 400_000), "codex"), null);
  assert.equal(auto.autoCompactTokens(on("claude", 400_000), "antigravity"), null);
});

test("a threshold written in the profile wins over the setting", () => {
  for (const args of ["--autocompact 600k", "--model opus --autocompact=auto"]) assert.equal(auto.claudeAutoCompact(on("claude", 400_000), args), null);
  assert.equal(auto.claudeAutoCompact(on("claude", 400_000), "--append-system-prompt \"no --autocompactx here\""), 400_000);
  assert.equal(auto.codexAutoCompact(on("codex", 250_000), ["app-server", "-c", "model_auto_compact_token_limit=120000"]), null);
  assert.equal(auto.codexAutoCompact(on("codex", 250_000), ["app-server", "-c", "model=gpt-6-luna"]), 250_000);
});

test("the Codex chat keeps a profile's own -c options ahead of the app's", async () => {
  const codex = await load("codexChat");
  const launch = codex.codexLaunch("-c model_auto_compact_token_limit=120000");
  assert.deepEqual(launch.flags.slice(0, 3), ["app-server", "-c", "model_auto_compact_token_limit=120000"]);
  assert.deepEqual(auto.codexAutoCompactFlags(auto.codexAutoCompact(on("codex", 250_000), launch.flags)), []);
  // Without it, the app's option goes after the subcommand, like the profile's own.
  const plain = codex.codexLaunch("");
  assert.equal(plain.flags[0], "app-server");
  assert.deepEqual(auto.codexAutoCompactFlags(auto.codexAutoCompact(on("codex", 250_000), plain.flags)), ["-c", "model_auto_compact_token_limit=250000"]);
});
