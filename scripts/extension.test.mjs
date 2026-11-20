import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const lib = await import("../extension/lib.js");
const page = await import("../extension/page.js");
const read = name => readFile(new URL(`../extension/${name}`, import.meta.url), "utf8");

test("the extension only opens web addresses", () => {
  assert.equal(lib.webUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(lib.webUrl("example.com"), "https://example.com/");
  assert.equal(lib.webUrl(" http://127.0.0.1:3000 "), "http://127.0.0.1:3000/");
  for (const blocked of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "chrome://settings", "chrome-extension://abc/popup.html", "data:text/html,<b>x", "about:blank", "", "   ", null, 7, "x".repeat(5000)]) {
    assert.equal(lib.webUrl(blocked), null, String(blocked).slice(0, 40));
  }
});

test("pairing input is normalised and ports are bounded", () => {
  assert.equal(lib.normalizeCode(" abc-234 "), "ABC234");
  assert.equal(lib.validPort("7341"), 7341);
  for (const port of ["80", "70000", "abc", "", "7341.5"]) assert.equal(lib.validPort(port), null, port);
});

test("keys and shortcuts map to what the debugger protocol needs", () => {
  assert.deepEqual(lib.parseKey("Enter"), { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r" });
  assert.deepEqual(lib.parseKey("ctrl+a"), { key: "a", code: "KeyA", keyCode: 65, modifiers: 2, text: "" });
  assert.deepEqual(lib.parseKey("shift+Tab"), { key: "Tab", code: "Tab", keyCode: 9, modifiers: 8, text: "" });
  assert.equal(lib.parseKey("Shift+a").text, "A");
  assert.equal(lib.parseKey("F5").keyCode, 116);
  assert.equal(lib.parseKey("ctrl+shift+ArrowDown").modifiers, 10);
  assert.equal(lib.parseKey("+").key, "+");
  for (const bad of ["", "hyper+a", "notakey", "ctrl+", null, "a".repeat(50)]) assert.equal(lib.parseKey(bad), null, String(bad));
});

test("tabs and pages are described in plain lines for the agent", () => {
  assert.match(lib.describeTabs([]), /tab_open/);
  assert.equal(lib.describeTabs([{ id: 7, active: true, title: "Inicio", url: "https://example.com/" }]), "tabId 7 (activa) · Inicio · https://example.com/");
  const text = lib.describePage({ title: "T", url: "https://e.com/", elements: [{ ref: "ref_1", role: "link", name: "Entrar", value: "" }, { ref: "ref_2", role: "contraseña", name: "Clave", value: "(oculto)" }],
    moreElements: 3, text: "Hola", truncated: true });
  assert.match(text, /ref_1 link «Entrar»/);
  assert.match(text, /ref_2 contraseña «Clave» = \(oculto\)/);
  assert.match(text, /3 elementos más/);
  assert.match(text, /el texto sigue/);
  assert.equal(lib.browserName([{ brand: "Chromium" }, { brand: "Google Chrome" }], false), "Chrome");
  assert.equal(lib.browserName([{ brand: "Chromium" }], true), "Brave");
  assert.equal(lib.browserName([{ brand: "Microsoft Edge" }], false), "Edge");
  assert.equal(lib.browserName(undefined, false), "Chromium");
});

test("page functions are self-contained, since they are sent to the tab as text", () => {
  for (const fn of [page.collect, page.locate, page.ensureClicked, page.focusRef, page.activePassword, page.scrollPage]) {
    const source = fn.toString();
    // Re-creating the function from its text must work: nothing from the module scope is captured.
    assert.equal(typeof new Function(`return (${source})`)(), "function", fn.name);
    assert.doesNotMatch(source, /\b(chrome|import)\b/, fn.name);
  }
  // A password field never gives away what is typed in it.
  assert.match(page.collect.toString(), /type === "password"\) return element\.value \? "\(oculto\)"/);
});

test("the manifest asks for the minimum and every tool goes through the group gate", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "debugger", "storage", "tabGroups", "tabs"]);
  // Only the local trex app: no access to sites through host permissions.
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.equal(manifest.content_scripts, undefined);
  for (const file of ["background.js", "popup.html", "popup.js", "popup.css", "lib.js", "page.js", "icons/32.png", "icons/64.png", "icons/128.png"]) await read(file);

  const background = await read("background.js");
  const tools = background.slice(background.indexOf("const TOOLS = {"), background.indexOf("async function run("));
  const bodies = [...tools.matchAll(/\n  async (\w+)\(([^)]*)\) \{([\s\S]*?)\n  \},/g)].map(([, name, args, body]) => ({ name, args, body }));
  assert.deepEqual(bodies.map(tool => tool.name), ["tabs_list", "read_page", "screenshot", "tab_open", "navigate", "click", "type", "key", "scroll", "tab_close"]);
  for (const tool of bodies) {
    if (!tool.args.includes("tabId")) continue;
    assert.match(tool.body.trimStart(), /^(const tab = )?await sharedTab\(tabId\);/, `${tool.name} must check the trex group first`);
  }
  // The tool names match the ones the app lists for the agents.
  const rust = await readFile(new URL("../src-tauri/src/browser_bridge.rs", import.meta.url), "utf8");
  const listed = name => {
    const start = rust.indexOf(`pub const ${name}:`), open = rust.indexOf("= [", start), close = rust.indexOf("];", open);
    return [...rust.slice(open, close).matchAll(/"(\w+)"/g)].map(match => match[1]);
  };
  assert.deepEqual([...listed("OBSERVE_TOOLS"), ...listed("ACTION_TOOLS")], bodies.map(tool => tool.name));
  // Typing into a password field is refused by code, not just discouraged.
  assert.match(tools, /if \(field\.password\) throw new Error/);
});
