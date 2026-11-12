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
test("computer control and accessibility guidance follow their own switches for every provider", () => {
  const base = { integrations: off };
  for (const provider of ["claude", "codex", "trex", "antigravity"]) {
    assert.equal(integrationInstructions(provider, integrationContext({ ...base, desktopEnabled: false }, { a11y: false, browser: false })), "", provider);
    const desktop = integrationInstructions(provider, integrationContext({ ...base, desktopEnabled: true }));
    assert.match(desktop, /Computer control/, provider); assert.doesNotMatch(desktop, /Accessibility|a11y_/, provider);
    const a11y = integrationInstructions(provider, integrationContext(base, { a11y: true }));
    assert.match(a11y, /Accessibility control/, provider); assert.doesNotMatch(a11y, /Computer control|desktop_/, provider);
  }
});
test("with every integration off, Claude's appended prompt keeps only the app's own guidance", () => {
  const all = integrationContext({ integrations: { github: true, blender: true, hyperframes: true }, desktopEnabled: true },
    { browser: true, a11y: true, available: { github: true, blender: true, hyperframes: true } });
  const none = integrationContext({ integrations: off, desktopEnabled: false });
  const appended = context => { const flags = claudeChatFlags(null, null, { integrations: context }); return flags[flags.indexOf("--append-system-prompt") + 1]; };
  assert.doesNotMatch(appended(none), /GitHub|Blender|HyperFrames|Computer control|Accessibility|browser_navigate|desktop_|a11y_|Check real results/);
  assert.match(appended(none), /trex_update_tasks/, "the app's own tools stay");
  assert.ok(Buffer.byteLength(appended(none)) < Buffer.byteLength(appended(all)) / 2, "turning everything off removes more than half of the appended text");
});
test("without the native app, detection degrades to the enabled preferences synchronously", () => {
  assert.equal(detectedIntegrations("D:/offline-project"), null);
  assert.equal(detectedIntegrations("D:/offline-project"), null);
});

// ---- Blender, HyperFrames and the other applications (trex_apps) ----
const { appsWanted, appsFromArgs, appToolsFor, BLENDER_READ_TOOLS, BLENDER_ACTION_TOOLS, HYPERFRAMES_READ_TOOLS, HYPERFRAMES_ACTION_TOOLS, GITHUB_READ_TOOLS, GITHUB_ACTION_TOOLS, APPS_SERVER } = await load("apps");
const { BLENDER_APPS_GUIDE, HYPERFRAMES_APPS_GUIDE, GITHUB_APPS_GUIDE } = await load("integrations");
const only = (...apps) => ({ github: apps.includes("github"), blender: apps.includes("blender"), hyperframes: apps.includes("hyperframes") });
test("each session is offered only the applications that are enabled and not known to be missing", () => {
  assert.deepEqual(appsWanted(undefined, null), ["blender", "hyperframes", "github"], "default preferences, unknown detection");
  assert.deepEqual(appsWanted(only("hyperframes"), null), ["hyperframes"]);
  assert.deepEqual(appsWanted(only("github", "blender"), { github: false }), ["blender"], "gh not found");
  assert.deepEqual(appsWanted(only(), null), []);
  assert.deepEqual(appsWanted(only("blender", "hyperframes"), { blender: false }), ["hyperframes"], "detected as missing");
  assert.deepEqual(appsWanted(only("blender", "hyperframes"), { blender: true, hyperframes: true }), ["blender", "hyperframes"]);
});
test("the applications a server started with are read back from its arguments", () => {
  assert.deepEqual(appsFromArgs(["apps-mcp", "--mode", "full", "--cwd", "/p", "--apps", "github,hyperframes,blender"]), ["blender", "hyperframes", "github"]);
  assert.deepEqual(appsFromArgs(["apps-mcp", "--apps", "blender"]), ["blender"]);
  for (const bad of [undefined, "x", [], ["--apps"], ["--apps", 3], ["apps-mcp", "--apps", "gimp"]]) assert.deepEqual(appsFromArgs(bad), [], JSON.stringify(bad));
});
test("the tools a server offers depend on the applications it was given", () => {
  assert.deepEqual(appToolsFor(["blender"]), { read: [...BLENDER_READ_TOOLS], action: [...BLENDER_ACTION_TOOLS] });
  assert.deepEqual(appToolsFor(["hyperframes"]), { read: [...HYPERFRAMES_READ_TOOLS], action: [...HYPERFRAMES_ACTION_TOOLS] });
  assert.deepEqual(appToolsFor(["github"]), { read: [...GITHUB_READ_TOOLS], action: [...GITHUB_ACTION_TOOLS] });
  assert.equal(appToolsFor(["blender", "hyperframes", "github"]).read.length, BLENDER_READ_TOOLS.length + HYPERFRAMES_READ_TOOLS.length + GITHUB_READ_TOOLS.length);
});
test("each provider is told about Blender and HyperFrames in the way it can use", () => {
  const blender = integrationContext({ integrations: only("blender") }, { apps: ["blender"] });
  const claude = integrationInstructions("claude", blender);
  assert.match(claude, /trex_apps MCP tools \(blender_\*\)/);
  assert.match(claude, /select:mcp__trex_apps__blender_open,mcp__trex_apps__blender_scene,mcp__trex_apps__blender_view/, "one ToolSearch call for the deferred tools");
  assert.doesNotMatch(claude, /hyperframes/i, "only the attached application is mentioned");
  for (const provider of ["codex", "antigravity"]) assert.ok(integrationInstructions(provider, blender).includes(BLENDER_APPS_GUIDE), `${provider} gets the full guide: it never sees the server's instructions`);
  assert.ok([BLENDER_APPS_GUIDE, HYPERFRAMES_APPS_GUIDE, GITHUB_APPS_GUIDE].every(guide => Buffer.byteLength(guide) < 1100), "the guides stay short");
  const gh = integrationContext({ integrations: only("github") }, { apps: ["github"] });
  assert.match(integrationInstructions("claude", gh), /trex_apps MCP tools \(github_\*\).*untrusted data/);
  assert.match(integrationInstructions("claude", gh), /select:mcp__trex_apps__github_repos,mcp__trex_apps__github_prs,mcp__trex_apps__github_pr_view/);
  for (const provider of ["codex", "antigravity"]) assert.ok(integrationInstructions(provider, gh).includes(GITHUB_APPS_GUIDE), provider);
  assert.match(integrationInstructions("claude", integrationContext({ integrations: only("github") })), /installed gh CLI/, "without the server it keeps the CLI advice");
  const both = integrationContext({ integrations: only("blender", "hyperframes") }, { apps: ["blender", "hyperframes"] });
  const claudeBoth = integrationInstructions("claude", both);
  assert.match(claudeBoth, /trex_apps MCP tools \(hyperframes_\*\)/);
  assert.equal([...claudeBoth.matchAll(/ToolSearch/g)].length, 1, "a single search loads the tools of every attached application");
  assert.match(claudeBoth, /mcp__trex_apps__blender_open.*mcp__trex_apps__hyperframes_project.*mcp__trex_apps__hyperframes_init/);
  for (const provider of ["codex", "antigravity"]) {
    const text = integrationInstructions(provider, both);
    assert.ok(text.includes(BLENDER_APPS_GUIDE) && text.includes(HYPERFRAMES_APPS_GUIDE), provider);
  }
  const native = integrationInstructions("trex", integrationContext({ integrations: only("blender", "hyperframes") }));
  assert.match(native, /advertised blender_\* tools/);
  assert.match(native, /advertised hyperframes_\* tools: hyperframes_check is the gate/);
  assert.doesNotMatch(native, /not an open window|hyperframes_run/);
  for (const provider of ["claude", "codex", "antigravity"]) {
    const headless = integrationInstructions(provider, integrationContext({ integrations: only("blender", "hyperframes") }));
    assert.match(headless, /background process/, `${provider} without the server keeps the headless Blender advice`);
    assert.match(headless, /check --json is the gate/, `${provider} without the server uses the CLI`);
    assert.doesNotMatch(headless, /trex_apps/, `${provider} is not promised tools it does not have`);
  }
  assert.equal(integrationInstructions("claude", integrationContext({ integrations: off }, { apps: ["blender", "hyperframes"] })), "", "off means silent, even when attached");
  assert.doesNotMatch(integrationInstructions("claude", integrationContext({ integrations: only("hyperframes") }, { apps: ["blender", "hyperframes"] })), /blender/i, "a disabled app is not announced even if the server has it");
});
test("the tool names the app knows match the ones the Rust providers define", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const [file, prefix, read, action] of [["blender_live.rs", "blender", BLENDER_READ_TOOLS, BLENDER_ACTION_TOOLS], ["hyperframes.rs", "hyperframes", HYPERFRAMES_READ_TOOLS, HYPERFRAMES_ACTION_TOOLS], ["github.rs", "github", GITHUB_READ_TOOLS, GITHUB_ACTION_TOOLS]]) {
    const source = await readFile(new URL(`../trex-cli/src/${file}`, import.meta.url), "utf8");
    const defined = [...source.matchAll(new RegExp(`tool\\("(${prefix}_[a-z_]+)"`, "g"))].map(match => match[1]).sort();
    assert.deepEqual(defined, [...read, ...action].sort(), file);
    const readList = source.match(/const READ: &\[&str\] = &\[([^\]]+)\]/)[1].match(new RegExp(`${prefix}_[a-z_]+`, "g"));
    assert.deepEqual(readList, [...read], `${file} read-only set`);
  }
  assert.equal(APPS_SERVER, "trex_apps");
  const apps = await readFile(new URL("../trex-cli/src/apps_mcp.rs", import.meta.url), "utf8");
  assert.match(apps, /server_name: "trex-apps"/);
  assert.match(apps, /"hyperframes" => App::Hyperframes/);
  assert.match(apps, /"github" => App::Github/);
});
