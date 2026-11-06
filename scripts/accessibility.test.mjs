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

test("the app expects exactly the tools the engine publishes", async () => {
  const prefix = /pub const PREFIX: &str = "([a-z0-9_]+)"/.exec(await readFile(new URL("../trex-cli/src/a11y_mcp.rs", import.meta.url), "utf8"))[1];
  assert.deepEqual([...accessibility.A11Y_READ_TOOLS], (await rustList("READ_TOOLS", "a11y/mod.rs")).map(name => prefix + name));
  assert.deepEqual([...accessibility.A11Y_ACTION_TOOLS], (await rustList("ACTION_TOOLS", "a11y/mod.rs")).map(name => prefix + name));
  assert.deepEqual([...accessibility.A11Y_KEYBOARD_TOOLS], (await rustList("KEYBOARD_TOOLS", "a11y/mod.rs")).map(name => prefix + name));
  // Nunca entrada física del ratón: eso es el control de computadora, otra integración.
  for (const hidden of ["a11y_mouse_click", "a11y_hover", "a11y_drag", "a11y_clipboard_get", "a11y_screenshot"]) {
    assert.ok(![...accessibility.A11Y_READ_TOOLS, ...accessibility.A11Y_ACTION_TOOLS].includes(hidden), hidden);
  }
});

test("accessibility control is opt-in and announced only when the gateway is attached", () => {
  assert.equal(normalizeConfig({}).settings.a11yEnabled, false);
  assert.equal(normalizeConfig({ settings: { a11yEnabled: true } }).settings.a11yEnabled, true);
  assert.equal(normalizeConfig({ settings: { a11yEnabled: "yes" } }).settings.a11yEnabled, false);
  // Solo hay el motor propio: un motor guardado de versiones anteriores se ignora.
  assert.equal("a11yEngine" in normalizeConfig({ settings: { a11yEngine: "agent-desktop", a11yEnabled: true } }).settings, false);
  assert.equal(normalizeConfig({ settings: { a11yEngine: "agent-desktop", a11yEnabled: true } }).settings.a11yEnabled, true);
  const gateway = keyboard => ({ command: "trex-agent", args: ["a11y-mcp", "--mode", "full", ...(keyboard ? ["--keyboard"] : [])] });
  assert.equal(accessibility.accessibilityKeyboard(gateway(true)), true);
  assert.equal(accessibility.accessibilityKeyboard(gateway(false)), false);
  const preference = { a11yEnabled: true, desktopEnabled: false };
  assert.doesNotMatch(integrations.integrationInstructions("claude", integrations.integrationContext(preference)), /Accessibility control/);
  const claude = integrations.integrationInstructions("claude", integrations.integrationContext(preference, { a11y: true }));
  assert.match(claude, /trex_a11y MCP tools \(a11y_\*\)/);
  assert.doesNotMatch(claude, /Computer control/, "it does not enable computer control");
  assert.match(claude, /single ToolSearch call \(select:mcp__trex_a11y__a11y_list_windows,[\w,]*mcp__trex_a11y__a11y_scroll,/, "deferred tools load together");
  assert.doesNotMatch(integrations.integrationInstructions("codex", integrations.integrationContext(preference, { a11y: true })), /ToolSearch/);
  // Computer use y accesibilidad son independientes: ninguno se presenta como preferido.
  for (const provider of ["claude", "codex", "antigravity", "trex"]) {
    const both = integrations.integrationInstructions(provider, integrations.integrationContext({ a11yEnabled: true, desktopEnabled: true }, { a11y: true }));
    assert.match(both, /separate integrations: use the one the user asks for/, provider);
    assert.doesNotMatch(both, /prefer (advertised|connected|the advertised|the connected) (desktop|trex_desktop|trex_a11y|mcp_trex_a11y)/, provider);
    assert.doesNotMatch(both, /desktop_status/, `${provider}: no startup round trips`);
  }
  // El navegador también: Claude carga sus herramientas habituales de una vez.
  const web = integrations.integrationInstructions("claude", integrations.integrationContext({}, { browser: true }));
  assert.match(web, /single ToolSearch call \(select:mcp__trex_browser__browser_navigate,[\w,]*mcp__trex_browser__browser_batch,/);
  assert.doesNotMatch(integrations.integrationInstructions("trex", integrations.integrationContext({}, { browser: true })), /ToolSearch/);
  // Claude y Trex CLI ya reciben la guía del servidor: el texto de la app es corto.
  const short = integrations.integrationInstructions("claude", integrations.integrationContext({ a11yEnabled: true, desktopEnabled: true, integrations: { github: false, blender: false, hyperframes: false } }, { a11y: true }));
  const long = integrations.integrationInstructions("codex", integrations.integrationContext({ a11yEnabled: true, desktopEnabled: true, integrations: { github: false, blender: false, hyperframes: false } }, { a11y: true }));
  assert.ok(short.replace(/ If these tools are deferred[^.]*\./, "").length < long.length * 0.6, `${short.length} vs ${long.length}`);
  assert.match(integrations.integrationInstructions("trex", integrations.integrationContext(preference, { a11y: true })), /mcp_trex_a11y_\* tools/);
});

test("an unavailable accessibility engine becomes a chat notice instead of a failed start", async () => {
  const warnings = [];
  // Sin Tauri, la consulta falla como fallaría fuera de Windows: el chat recibe un aviso y sigue.
  assert.equal(await accessibility.accessibilityServer("full", message => warnings.push(message)), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^El control por accesibilidad \(experimental\) no se activó en este chat: /);
});

test("accessibility tools read as plain Spanish in the chat, with the verified mark", async () => {
  const chat = await load("chatState");
  for (const name of ["mcp__trex_a11y__a11y_list_windows", "mcp_trex_a11y_a11y_list_windows_1a2b3c4d"]) assert.equal(chat.a11yToolName(name), "list_windows");
  assert.equal(chat.a11yToolName("mcp__trex_desktop__desktop_click"), null);
  const row = (tool, input, running = false) => chat.describeTool(`mcp__trex_a11y__a11y_${tool}`, input, "C:/", running);
  assert.deepEqual(row("launch", { app: "notepad" }), { icon: "run", verb: "Abrió", target: "notepad" });
  assert.deepEqual(row("type", { ref_id: "@s1:e1", text: "x".repeat(1043) }, true), { icon: "edit", verb: "Escribiendo", target: "1043 caracteres" });
  assert.equal(row("select", { value: "Verde" }).target, "«Verde»");
  assert.equal(row("press", { keys: "ctrl+s" }).target, "ctrl+s");
  // Las variantes llegan como argumento: cada una con su verbo.
  assert.deepEqual(row("set_value", { ref_id: "@s1:e1", value: "x".repeat(5), append: true }), { icon: "edit", verb: "Escribió", target: "5 caracteres" });
  assert.deepEqual(row("set_value", { ref_id: "@s1:e1", value: "" }), { icon: "edit", verb: "Vació", target: "un campo" });
  assert.equal(row("toggle", { state: "on" }).verb, "Marcó");
  assert.equal(row("toggle", { state: "off" }).verb, "Desmarcó");
  assert.equal(row("toggle", {}).verb, "Cambió");
  assert.deepEqual(row("click", { button: "right" }), { icon: "tool", verb: "Abrió", target: "un menú contextual" });
  assert.equal(row("expand", { collapse: true }).verb, "Plegó");
  assert.deepEqual(row("window", { app: "notepad", action: "close" }), { icon: "tool", verb: "Cerró", target: "notepad" });
  assert.deepEqual(row("batch", { steps: [{}, {}, {}] }, true), { icon: "tool", verb: "Haciendo", target: "3 pasos" });
  assert.equal(chat.a11yVerified("mcp__trex_a11y__a11y_type", "Value verified: \"hola\"."), true);
  assert.equal(chat.a11yVerified("mcp__trex_a11y__a11y_check", "Now checked (verified)."), true);
  assert.equal(chat.a11yVerified("mcp__trex_a11y__a11y_click", "Clicked (invoked)."), false, "a click has no state to verify");
  assert.equal(chat.a11yVerified("Bash", "Value verified"), false);
});

test("the working row names the app the agent is driving, only while it is", async () => {
  const chat = await load("chatState");
  const tool = (tool, input, output = "") => ({ kind: "tool", id: tool, name: `mcp__trex_a11y__a11y_${tool}`, input, status: "done", output, patch: null });
  const user = { kind: "user", id: "u", text: "abre el bloc de notas", images: 0, previews: [] };
  assert.equal(chat.a11yActivity([user]), null);
  assert.deepEqual(chat.a11yActivity([user, tool("launch", { app: "notepad" })]), { app: "notepad" });
  const read = tool("snapshot", { window_id: "w44" }, "window w44 \"Sin título: Bloc de notas\" (notepad.exe) · snapshot s1 · 26 elements · 61 ms");
  assert.deepEqual(chat.a11yActivity([user, read, tool("type", { ref_id: "@s1:e1", text: "hola" })]), { app: "notepad" });
  // Después de otra herramienta (por ejemplo, leer un archivo), ya no está manejando apps.
  assert.equal(chat.a11yActivity([user, read, { kind: "tool", id: "r", name: "Read", input: {}, status: "done", output: "", patch: null }]), null);
});

test("keyboard shortcuts travel with the gateway only when allowed", async () => {
  assert.equal(normalizeConfig({}).settings.a11yKeyboard, false);
  assert.equal(normalizeConfig({ settings: { a11yKeyboard: true } }).settings.a11yKeyboard, true);
  assert.equal(accessibility.accessibilityKeyboard({ command: "trex-agent", args: ["a11y-mcp", "--mode", "full", "--keyboard"] }), true);
  assert.equal(accessibility.accessibilityKeyboard({ command: "trex-agent", args: ["a11y-mcp", "--mode", "full"] }), false);
});
