import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const lib = await import("../extension/lib.js");
const page = await import("../extension/page.js");
// Without \r: with core.autocrlf the working copy has CRLF line ends.
const lf = text => text.replace(/\r\n/g, "\n");
const read = async name => lf(await readFile(new URL(`../extension/${name}`, import.meta.url), "utf8"));

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

const OWNER_A = "a".repeat(32), OWNER_B = "b".repeat(32);

test("every order names its chat with an opaque id, and group titles are clean", () => {
  assert.deepEqual(lib.chatOf({ owner: OWNER_A, group: "trex · Claude 2" }), { owner: OWNER_A, title: "trex · Claude 2", color: lib.chatColor(OWNER_A) });
  // Without a valid owner the extension does nothing: no shared «anyone» identity.
  for (const params of [{}, { owner: "" }, { owner: "t-1" }, { owner: "A".repeat(32) }, { owner: "a".repeat(8) }, { owner: 7 }, null, undefined]) {
    assert.equal(lib.chatOf(params), null, JSON.stringify(params));
  }
  assert.equal(lib.chatTitle("Claude 2"), "trex · Claude 2");
  assert.equal(lib.chatTitle("trex · Claude 2"), "trex · Claude 2");
  assert.equal(lib.chatTitle(""), "trex · Chat");
  assert.equal(lib.chatTitle(undefined), "trex · Chat");
  // Never the bare common group, never invisible direction tricks, always short.
  assert.equal(lib.chatTitle("trex"), "trex · trex");
  assert.equal(lib.chatTitle("Cla\u202eude\u200b 2\n"), "trex · Claude 2");
  assert.equal(lib.chatTitle("Una conversación muy larga sobre el navegador"), "trex · Una conversación muy la…");
  // Same title the bridge builds (src-tauri/src/browser_bridge.rs, group_title).
  assert.equal(lib.chatTitle("trex · Una conversación muy la…"), "trex · Una conversación muy la…");
  // Chat colours never reuse the common group's orange or the grey of ended chats.
  for (const owner of [OWNER_A, OWNER_B, "0123456789abcdef", "ffffffffffffffff"]) {
    assert.ok(lib.CHAT_COLORS.includes(lib.chatColor(owner)));
    assert.notEqual(lib.chatColor(owner), lib.COMMON_COLOR);
    assert.notEqual(lib.chatColor(owner), lib.ENDED_COLOR);
  }
});

test("a chat only reaches its own group and the common one, never another chat's", () => {
  const owners = { 10: { owner: OWNER_A, title: "trex · Claude 2" }, 20: { owner: OWNER_B, title: "trex · Codex" } };
  const common = new Set([30]);
  assert.equal(lib.tabAccess(10, owners, OWNER_A, common), "propia");
  assert.equal(lib.tabAccess(20, owners, OWNER_A, common), "ajena");
  assert.equal(lib.tabAccess(30, owners, OWNER_A, common), "comun");
  // Not grouped, or in one of the person's own groups: out of reach.
  for (const groupId of [-1, 40, undefined, null, "10"]) assert.equal(lib.tabAccess(groupId, owners, OWNER_A, common), "fuera", String(groupId));
  // A group whose chat ended has no owner and is not titled «trex»: nobody reaches it.
  assert.equal(lib.tabAccess(50, owners, OWNER_A, common), "fuera");

  const tabs = [{ id: 1, groupId: 10 }, { id: 2, groupId: 20 }, { id: 3, groupId: 30 }, { id: 4, groupId: -1 }, { id: 5, groupId: 10 }];
  const seen = lib.splitTabs(tabs, owners, OWNER_A, common);
  assert.deepEqual(seen.own.map(tab => tab.id), [1, 5]);
  assert.deepEqual(seen.common.map(tab => tab.id), [3]);
  assert.deepEqual(lib.splitTabs(tabs, owners, OWNER_B, common).own.map(tab => tab.id), [2]);

  // The popup offers the chats that still have a group, once each.
  const chats = lib.knownChats({ ...owners, 11: { owner: OWNER_A, title: "trex · Claude 2" }, 99: { owner: "c".repeat(32), title: "trex · Viejo" } }, new Set([10, 11, 20]));
  assert.deepEqual(chats, [{ owner: OWNER_A, title: "trex · Claude 2" }, { owner: OWNER_B, title: "trex · Codex" }]);
});

test("tabs and pages are described in plain lines for the agent", () => {
  assert.match(lib.describeTabs([]), /tab_open/);
  assert.equal(lib.describeTabs([{ id: 7, active: true, title: "Inicio", url: "https://example.com/" }]), "Tus pestañas:\ntabId 7 (activa) · Inicio · https://example.com/");
  const both = lib.describeTabs([], [{ id: 8, title: "Correo", url: "https://mail.example/" }]);
  assert.match(both, /^Aún no tienes pestañas propias\./);
  assert.match(both, /grupo común «trex»[\s\S]*tabId 8 · Correo/);
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
  const dialog = lib.describeDialog({ type: "prompt", message: "¿Tu nombre?", defaultPrompt: "Ana" });
  assert.match(dialog, /pregunta \(prompt\): «¿Tu nombre\?»/);
  assert.match(dialog, /Valor propuesto: «Ana»/);
  assert.match(dialog, /handle_dialog/);
  assert.match(lib.describeDialog({ type: "beforeunload", message: "" }), /salir de la página/);
});

test("passwords, verification codes and payment data are left to the person", () => {
  const field = extra => ({ tag: "input", type: "text", kind: "text", name: "", id: "", autocomplete: "", label: "", placeholder: "", ...extra });
  assert.equal(lib.fieldBlock(field({ name: "email" })), null);
  assert.equal(lib.fieldBlock(null), null);
  assert.match(lib.fieldBlock(field({ type: "password" })), /contraseña/);
  for (const payment of [{ autocomplete: "cc-number" }, { autocomplete: "billing cc-csc" }, { autocomplete: "cc-exp-month" }, { name: "cardnumber" },
    { id: "card_number" }, { name: "cvv" }, { label: "Número de tarjeta" }, { placeholder: "Código de seguridad" }, { label: "Card expiry" }]) {
    assert.match(lib.fieldBlock(field(payment)) ?? "", /datos de pago/, JSON.stringify(payment));
  }
  assert.match(lib.fieldBlock(field({ autocomplete: "one-time-code" })), /códigos de verificación/);
  // Typing without a reference into a frame: the focused field cannot be inspected.
  assert.match(lib.fieldBlock(field({ tag: "iframe", type: "", kind: "frame" })), /marco/);

  for (const card of ["4111 1111 1111 1111", "4111-1111-1111-1111", "5555555555554444", "378282246310005"]) assert.equal(lib.looksLikeCard(card), true, card);
  for (const other of ["4111 1111 1111 1112", "1234", "hola 4111111111111111", "0000000000000000", "+34 600 000 000", "", null]) assert.equal(lib.looksLikeCard(other), false, String(other));
});

test("tool arguments are checked before touching the page", () => {
  assert.equal(lib.validRef("ref_12"), "ref_12");
  for (const bad of ["12", "ref_", "ref_1; alert(1)", null, 3]) assert.equal(lib.validRef(bad), null, String(bad));

  assert.deepEqual(lib.formFields([{ ref: "ref_1", value: "Ana" }, { ref: "ref_2", checked: true }, { ref: "ref_3", value: "" }]),
    [{ ref: "ref_1", value: "Ana" }, { ref: "ref_2", checked: true }, { ref: "ref_3", value: "" }]);
  for (const [fields, reason] of [[[], /fields/], [null, /fields/], [[{ value: "x" }], /ref_N/], [[{ ref: "ref_1" }], /uno de los dos/],
    [[{ ref: "ref_1", value: "x", checked: true }], /uno de los dos/], [[{ ref: "ref_1", value: 3 }], /uno de los dos/],
    [[{ ref: "ref_1", value: "a" }, { ref: "ref_1", value: "b" }], /dos veces/], [Array.from({ length: 51 }, (_, i) => ({ ref: `ref_${i}`, value: "x" })), /50/],
    [[{ ref: "ref_1", value: "x".repeat(20001) }], /largo/], [Array.from({ length: 6 }, (_, i) => ({ ref: `ref_${i}`, value: "x".repeat(20000) })), /Demasiado texto/]]) {
    assert.throws(() => lib.formFields(fields), reason);
  }

  const options = [{ value: "", text: "Elige", disabled: true }, { value: "es", text: "España", disabled: false }, { value: "mx", text: "México", disabled: false }, { value: "ar", text: "Argentina", disabled: true }];
  assert.equal(lib.pickOption(options, "mx"), 2);
  assert.equal(lib.pickOption(options, "España"), 1);
  assert.equal(lib.pickOption(options, "  méxico "), 2);
  assert.equal(lib.pickOption(options, "ES"), 1);
  assert.equal(lib.pickOption(options, "ar"), -1, "disabled options are not chosen");
  assert.equal(lib.pickOption(options, "Chile"), -1);
  assert.equal(lib.listOptions(options), "«España», «México»");

  assert.deepEqual(lib.waitSpec({ text: " Listo " }), { kind: "text", value: "Listo", gone: false, timeoutMs: 10000 });
  assert.deepEqual(lib.waitSpec({ ref: "ref_4", gone: true, timeout: 5 }), { kind: "ref", value: "ref_4", gone: true, timeoutMs: 5000 });
  assert.deepEqual(lib.waitSpec({ selector: "#ok", timeout: 120 }), { kind: "selector", value: "#ok", gone: false, timeoutMs: 30000 }, "capped at 30 s");
  assert.deepEqual(lib.waitSpec({ load: true }), { kind: "load", value: "", gone: false, timeoutMs: 10000 });
  for (const [args, reason] of [[{}, /una sola/], [{ text: "a", selector: "b" }, /una sola/], [{ load: true, gone: true }, /load/], [{ ref: "x" }, /ref_N/],
    [{ text: "a", timeout: -1 }, /segundos/], [{ text: "a", timeout: "pronto" }, /segundos/], [{ text: "a".repeat(501) }, /largo/], [{ text: "a", gone: "sí" }, /gone/]]) {
    assert.throws(() => lib.waitSpec(args), reason, JSON.stringify(args).slice(0, 60));
  }
  assert.equal(lib.waitResult({ kind: "text", value: "Listo", gone: false, timeoutMs: 10000 }, true), "«Listo» ya está en la página.");
  assert.match(lib.waitResult({ kind: "ref", value: "ref_4", gone: true, timeoutMs: 5000 }, false), /Pasaron 5 s y el elemento ref_4 sigue a la vista/);

  // upload_file: trex already checked the paths; the extension only accepts their shape.
  assert.deepEqual(lib.uploadPaths(["C:\\proyecto\\a.txt", "/home/ana/b.png", "\\\\servidor\\c.pdf"]), ["C:\\proyecto\\a.txt", "/home/ana/b.png", "\\\\servidor\\c.pdf"]);
  for (const bad of [[], null, "C:\\a.txt", ["a.txt"], ["C:\\a\0b"], [7], Array.from({ length: 11 }, () => "C:\\a.txt")]) assert.equal(lib.uploadPaths(bad), null, JSON.stringify(bad));
});

test("page functions are self-contained, since they are sent to the tab as text", () => {
  const functions = [page.collect, page.locate, page.ensureClicked, page.focusRef, page.fieldInfo, page.setValue, page.setChecked, page.chooseOption, page.probe, page.refElement, page.scrollPage];
  assert.deepEqual(functions.map(fn => fn.name).sort(), Object.keys(page).sort(), "every exported page function is checked");
  for (const fn of functions) {
    const source = fn.toString();
    // Re-creating the function from its text must work: nothing from the module scope is captured.
    assert.equal(typeof new Function(`return (${source})`)(), "function", fn.name);
    assert.doesNotMatch(source, /\b(chrome|import)\b/, fn.name);
  }
  // A password field never gives away what is typed in it, and fieldInfo never reads values.
  assert.match(page.collect.toString(), /type === "password"\) return element\.value \? "\(oculto\)"/);
  assert.doesNotMatch(page.fieldInfo.toString(), /element\.value\b/);
});

test("the manifest asks for the minimum and every tool goes through the chat's own tabs", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.0");
  assert.ok(manifest.description.length <= 132, "the stores cut longer descriptions");
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "debugger", "storage", "tabGroups", "tabs"]);
  // Only the local trex app: no access to sites through host permissions.
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.equal(manifest.content_scripts, undefined);
  for (const file of ["background.js", "popup.html", "popup.js", "popup.css", "lib.js", "page.js", "icons/32.png", "icons/64.png", "icons/128.png"]) await read(file);

  const background = await read("background.js");
  const tools = background.slice(background.indexOf("const TOOLS = {"), background.indexOf("async function run("));
  const bodies = [...tools.matchAll(/\n  async (\w+)\(([^)]*)\) \{([\s\S]*?)\n  \},/g)].map(([, name, args, body]) => ({ name, args, body }));
  assert.deepEqual(bodies.map(tool => tool.name), ["tabs_list", "read_page", "screenshot", "wait_for", "tab_open", "navigate", "click", "type", "fill_form",
    "select_option", "key", "scroll", "upload_file", "handle_dialog", "tab_close"]);
  for (const tool of bodies) {
    assert.match(tool.args, /^chat\b/, `${tool.name} receives the chat first`);
    if (!tool.args.includes("tabId")) continue;
    assert.match(tool.body.trimStart(), /^(const tab = )?await ownTab\(chat, tabId\);/, `${tool.name} must check the chat's tabs first`);
  }
  // The tool names match the ones the app lists for the agents.
  const rust = lf(await readFile(new URL("../src-tauri/src/browser_bridge.rs", import.meta.url), "utf8"));
  const listed = name => {
    const start = rust.indexOf(`pub const ${name}:`), open = rust.indexOf("= [", start), close = rust.indexOf("];", open);
    return [...rust.slice(open, close).matchAll(/"(\w+)"/g)].map(match => match[1]);
  };
  assert.deepEqual(listed("OBSERVE_TOOLS"), ["tabs_list", "read_page", "screenshot", "wait_for"]);
  assert.deepEqual([...listed("OBSERVE_TOOLS"), ...listed("ACTION_TOOLS")], bodies.map(tool => tool.name));
  // Typing into passwords, codes or payment fields is refused by code, not just discouraged.
  for (const name of ["type", "fill_form"]) assert.match(bodies.find(tool => tool.name === name).body, /refuseSensitive\(/, name);
  assert.match(background, /function refuseSensitive\(field, text\) \{\n  const reason = fieldBlock\(field\) \?\? \(looksLikeCard\(text\)/);
  // The bridge sends the chat as an opaque owner, never the session key.
  assert.match(rust, /json!\(\{ "owner": chat\.owner, "group": chat\.group, "arguments": arguments \}\)/);
  assert.doesNotMatch(rust, /"session": session, "arguments"/);
});

test("the store package holds only the extension files", async () => {
  const { packageExtension, zipEntries } = await import("./package-extension.mjs");
  const out = await mkdtemp(join(tmpdir(), "trex-extension-test-"));
  try {
    const { file, entries } = await packageExtension(out);
    assert.match(file, /trex-extension-0\.2\.0\.zip$/);
    const inside = zipEntries(await readFile(file));
    assert.deepEqual(inside.map(entry => entry.name), entries);
    assert.equal(inside[0].name, "manifest.json", "manifest at the root, first");
    assert.deepEqual([...inside.map(entry => entry.name)].sort(), ["background.js", "icons/128.png", "icons/32.png", "icons/64.png", "lib.js", "manifest.json", "page.js", "popup.css", "popup.html", "popup.js"]);
    // The packaged manifest is the one in the repository, with LF line ends whatever the checkout.
    assert.equal(inside[0].text(), await read("manifest.json"));
    assert.ok(inside.filter(entry => !entry.name.endsWith(".png")).every(entry => !entry.text().includes("\r")));
    // Same code, same package.
    const again = await packageExtension(join(out, "otra"));
    assert.ok((await readFile(file)).equals(await readFile(again.file)));
    // Never inside the repository.
    await assert.rejects(packageExtension(fileURLToPath(new URL("../extension/", import.meta.url))), /fuera del repositorio/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
