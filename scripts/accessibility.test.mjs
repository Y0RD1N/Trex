import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const accessibility = await load("accessibility");
const integrations = await load("integrations");
const { normalizeConfig } = await load("api");

/** Una constante `[&str; N]` de la pasarela (o del motor propio) en Rust. */
async function rustList(name, file = "a11y_mcp.rs") {
  const source = await readFile(new URL(`../trex-cli/src/${file}`, import.meta.url), "utf8");
  const match = new RegExp(`pub const ${name}: \\[&str; (\\d+)\\] = \\[([^\\]]*)\\]`).exec(source);
  assert.ok(match, `${name} not found`);
  const items = [...match[2].matchAll(/"([a-z_]+)"/g)].map(item => item[1]);
  assert.equal(items.length, Number(match[1]));
  return items;
}

test("the app expects exactly the tools the gateway publishes", async () => {
  const prefix = /pub const PREFIX: &str = "([a-z0-9_]+)"/.exec(await readFile(new URL("../trex-cli/src/a11y_mcp.rs", import.meta.url), "utf8"))[1];
  assert.deepEqual([...accessibility.A11Y_READ_TOOLS], (await rustList("READ_TOOLS")).map(name => prefix + name));
  assert.deepEqual([...accessibility.A11Y_ACTION_TOOLS], (await rustList("ACTION_TOOLS")).map(name => prefix + name));
  // Lo que se exige al conectar es lo que publica el motor de Trex, que es lo común a los dos.
  assert.deepEqual([...accessibility.A11Y_CORE_READ_TOOLS], (await rustList("READ_TOOLS", "a11y/mod.rs")).map(name => prefix + name));
  assert.deepEqual([...accessibility.A11Y_CORE_ACTION_TOOLS], (await rustList("ACTION_TOOLS", "a11y/mod.rs")).map(name => prefix + name));
  for (const name of [...accessibility.A11Y_CORE_READ_TOOLS, ...accessibility.A11Y_CORE_ACTION_TOOLS]) {
    assert.ok([...accessibility.A11Y_READ_TOOLS, ...accessibility.A11Y_ACTION_TOOLS].includes(name), name);
  }
  // Nunca entrada física ni herramientas que permitan saltarse la selección.
  for (const hidden of ["a11y_mouse_click", "a11y_hover", "a11y_drag", "a11y_batch", "a11y_clipboard_get", "a11y_screenshot"]) {
    assert.ok(![...accessibility.A11Y_READ_TOOLS, ...accessibility.A11Y_ACTION_TOOLS].includes(hidden), hidden);
  }
});

test("accessibility control is opt-in and announced only when the gateway is attached", () => {
  assert.equal(normalizeConfig({}).settings.a11yEnabled, false);
  assert.equal(normalizeConfig({ settings: { a11yEnabled: true } }).settings.a11yEnabled, true);
  assert.equal(normalizeConfig({ settings: { a11yEnabled: "yes" } }).settings.a11yEnabled, false);
  assert.equal(normalizeConfig({}).settings.a11yEngine, "trex", "the built-in engine is the default");
  assert.equal(normalizeConfig({ settings: { a11yEngine: "agent-desktop" } }).settings.a11yEngine, "agent-desktop");
  assert.equal(normalizeConfig({ settings: { a11yEngine: "other" } }).settings.a11yEngine, "trex");
  const gateway = engine => ({ command: "trex-agent", args: ["a11y-mcp", "--mode", "full", ...(engine ? ["--engine", engine] : [])] });
  assert.equal(accessibility.accessibilityEngine(gateway("trex")), "trex");
  assert.equal(accessibility.accessibilityEngine(gateway("agent-desktop")), "agent-desktop");
  assert.equal(accessibility.accessibilityEngine(gateway(null)), null);
  const preference = { a11yEnabled: true, desktopEnabled: false };
  assert.doesNotMatch(integrations.integrationInstructions("claude", integrations.integrationContext(preference)), /Accessibility control/);
  const claude = integrations.integrationInstructions("claude", integrations.integrationContext(preference, { a11y: true }));
  assert.match(claude, /trex_a11y MCP tools \(a11y_\*\)/);
  assert.doesNotMatch(claude, /Computer control/, "it does not enable computer control");
  assert.match(integrations.integrationInstructions("trex", integrations.integrationContext(preference, { a11y: true })), /mcp_trex_a11y_\* tools/);
});

test("an unavailable agent-desktop becomes a chat notice instead of a failed start", async () => {
  const warnings = [];
  // Sin Tauri, la consulta falla como fallaría sin agent-desktop: el chat recibe un aviso y sigue.
  assert.equal(await accessibility.accessibilityServer("full", message => warnings.push(message)), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^El control por accesibilidad \(experimental\) no se activó en este chat: /);
});
