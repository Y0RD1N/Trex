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
  const functions = [page.collect, page.locate, page.ensureClicked, page.focusRef, page.fieldInfo, page.setValue, page.setChecked, page.chooseOption, page.probe, page.refElement, page.scrollPage,
    page.viewInfo, page.shieldResize, page.refArea, page.sensitiveRects, page.labelRects, page.watchChanges, page.changesQuiet, page.changesReport, page.pointAt, page.clickedAt];
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
  assert.equal(manifest.version, "0.3.0");
  assert.ok(manifest.description.length <= 132, "the stores cut longer descriptions");
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "debugger", "storage", "tabGroups", "tabs"]);
  // Only the local trex app: no access to sites through host permissions.
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.equal(manifest.content_scripts, undefined);
  for (const file of ["background.js", "popup.html", "popup.js", "popup.css", "lib.js", "page.js", "icons/32.png", "icons/64.png", "icons/128.png"]) await read(file);

  const background = await read("background.js");
  const tools = background.slice(background.indexOf("const TOOLS = {"), background.indexOf("async function run("));
  const bodies = [...tools.matchAll(/\n  async (\w+)\(([^)]*)\) \{([\s\S]*?)\n  \},/g)].map(([, name, args, body]) => ({ name, args, body }));
  assert.deepEqual(bodies.map(tool => tool.name), ["tabs_list", "read_page", "screenshot", "wait_for", "tab_open", "navigate", "click", "click_at", "type", "fill_form",
    "select_option", "key", "scroll", "upload_file", "handle_dialog", "tab_close"]);
  for (const tool of bodies) {
    assert.match(tool.args, /^chat\b/, `${tool.name} receives the chat first`);
    if (!tool.args.includes("tabId")) continue;
    assert.match(tool.body.trimStart(), /^(const tab = )?await ownTab\(chat, tabId\);/, `${tool.name} must check the chat's tabs first`);
  }
  // The tool names match the ones the app lists for the agents.
  const rust = lf(await readFile(new URL("../src-tauri/src/browser_bridge.rs", import.meta.url), "utf8"));
  const listed = name => {
    const start = rust.indexOf(`const ${name}:`), open = rust.indexOf("= [", start), close = rust.indexOf("];", open);
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

  // Captures only ever come from the chat's own tab through its debugger: nothing that sees
  // other tabs, the window or the screen, and no new permission for it.
  assert.doesNotMatch(background, /chrome\.(tabs\.captureVisibleTab|tabCapture|desktopCapture|offscreen)\b/);
  for (const name of ["screenshot", "click_at"]) assert.match(bodies.find(tool => tool.name === name).body.trimStart(), /^await ownTab\(chat, tabId\);/, name);
  // What changed after an action: the page is only watched after checking the tab is this chat's.
  const run = background.slice(background.indexOf("async function run("));
  assert.match(run, /await ownTab\(chat, args\.tabId\);\n    return withChanges\(/);
  // The image leaves the browser only if the tab is still this chat's once captured.
  assert.match(background, /if \(!await stillOwn\(chat, tabId\)\) throw/);
  // The tools that report what changed are the same in the extension and in the app.
  const observed = [...background.slice(background.indexOf("const OBSERVED = {"), background.indexOf("async function run(")).matchAll(/\n  (\w+): /g)].map(match => match[1]);
  assert.deepEqual(observed, listed("OBSERVED_TOOLS"));
});

test("captures pick their scale, map zones and points back to the page, and describe what changed", () => {
  // Defaults, limits and the zone of a previous capture.
  assert.deepEqual(lib.captureSpec({}), { ref: null, region: null, maxEdge: 1280, labels: false });
  assert.deepEqual(lib.captureSpec({ ref: " ref_7 ", maxEdge: 768, labels: true }), { ref: "ref_7", region: null, maxEdge: 768, labels: true });
  assert.equal(lib.captureSpec({ fullResolution: true }).maxEdge, 2576);
  assert.deepEqual(lib.captureSpec({ region: { x: 10.4, y: 0, width: 100, height: 40.6 } }).region, { x: 10, y: 0, width: 100, height: 41 });
  for (const bad of [{ ref: "ref_1", region: { x: 0, y: 0, width: 10, height: 10 } }, { ref: "boton" }, { region: { x: 0, y: 0, width: 4, height: 50 } },
    { region: { x: -1, y: 0, width: 50, height: 50 } }, { region: { x: 0, y: 0 } }, { maxEdge: 100 }, { maxEdge: 4000 }, { maxEdge: 900.5 }, { labels: "sí" }]) {
    assert.throws(() => lib.captureSpec(bad), Error, JSON.stringify(bad));
  }

  // The view is never enlarged; at 125 % a 1920-wide view is reduced to 1280.
  const view = lib.captureScale({ width: 1536, height: 730 }, 1.25, 1280);
  assert.equal(view.width, 1280);
  assert.ok(Math.abs(view.height - 608) <= 1, String(view.height));
  assert.deepEqual(lib.captureScale({ width: 800, height: 600 }, 1, 2576), { scale: 1, pxPerCss: 1, width: 800, height: 600 }, "full resolution is the screen's");
  // A small element is never enlarged: that adds no detail, only tokens.
  const small = lib.captureScale({ width: 120, height: 40 }, 1.25, 1280);
  assert.deepEqual([small.scale, small.width, small.height], [1, 150, 50]);

  // Zones and points in the pixels of the last capture map back to the page.
  const shot = { x: 0, y: 800, pxPerCss: 0.5, width: 640, height: 360, url: "https://a.test/" };
  const current = { x: 0, y: 800, width: 1280, height: 720, url: "https://a.test/" };
  assert.deepEqual(lib.regionArea({ x: 100, y: 50, width: 200, height: 1000 }, shot, current), { x: 200, y: 900, width: 400, height: 620 });
  assert.deepEqual(lib.capturePoint(100, 50, shot, current), { x: 200, y: 100 });
  assert.throws(() => lib.capturePoint(100, 50, shot, { ...current, y: 2000 }), /se desplazó/);
  assert.throws(() => lib.capturePoint(100, 50, shot, { ...current, url: "https://b.test/" }), /Aún no hay ninguna captura/);
  assert.throws(() => lib.capturePoint(700, 50, shot, current), /fuera de la captura/);
  assert.throws(() => lib.regionArea({ x: 0, y: 0, width: 10, height: 10 }, null, current), /Aún no hay ninguna captura/);

  // What changed: the box around the changes inside the view, and how much of it.
  const area = lib.changedArea([{ x: 100, y: 100, width: 200, height: 40 }, { x: 150, y: 2000, width: 10, height: 10 }, { x: 120, y: 160, width: 50, height: 20 }], { width: 1000, height: 800 });
  assert.deepEqual(area, { x: 88, y: 88, width: 224, height: 104, fraction: (224 * 104) / (1000 * 800) });
  assert.equal(lib.changedArea([{ x: 0, y: 900, width: 10, height: 10 }], { width: 1000, height: 800 }), null, "outside the view");
  const report = { url: "https://a.test/?q=1", title: "A", urlChanged: true, titleChanged: false, scrolled: true, scrollY: 0, rects: [], added: ["Pedido recibido"], removed: [], focus: "text «Buscar»" };
  const said = lib.describeChange(report, area, { width: 1000, height: 800 });
  assert.match(said, /^Qué cambió: la dirección es ahora https:\/\/a\.test\/\?q=1; apareció «Pedido recibido»; el foco está en text «Buscar»; cambió una zona de 224×104/);
  assert.equal(lib.describeChange({ ...report, urlChanged: false, added: [], focus: null }, null, { width: 1, height: 1 }), "Qué cambió: nada visible en la página.",
    "bringing a clicked element into view is not news");
  assert.equal(lib.describeChange({ ...report, urlChanged: false, added: [], focus: null, scrollY: 640 }, null, { width: 1, height: 1 }, { scroll: true }),
    "Qué cambió: la vista se desplazó (ahora en 640 px).");
  assert.match(lib.describeChange(null, null, { title: "Otra", url: "https://b.test/" }), /cargó otra página: «Otra» · https:\/\/b\.test\//);
  assert.deepEqual(lib.CAPTURE_MODES, ["changed", "full", "none"]);

  // The capture's own text says what it is and how to point into it.
  const text = lib.describeCapture({ title: "Tienda", url: "https://a.test/", tabId: 4, width: 1280, height: 608, view: { y: 1200, height: 730, docHeight: 5400 }, masked: 2, labels: ["3 = ref_3 button «Comprar»"] });
  assert.match(text, /^Captura 1280×608 de «Tienda» \(tabId 4 · https:\/\/a\.test\/\): la zona visible, desplazada 1200 de 4670 px\./);
  assert.match(text, /2 campos sensibles tapados/);
  assert.match(text, /3 = ref_3 button «Comprar»/);
  assert.match(text, /Coordenadas para region y click_at: píxeles de esta imagen\.$/);

  // The size of a JPEG comes from its header.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x60, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00]).toString("base64");
  assert.deepEqual(lib.jpegSize(jpeg), { width: 1280, height: 608 });
  assert.equal(lib.jpegSize("iVBORw0KGgo="), null, "not a JPEG");
  assert.equal(lib.jpegSize(""), null);
});

test("what the page hides in a capture and how it reports changes stays private", () => {
  // Masks cover passwords, payment and code fields, and payment frames, like the typing refusals.
  const masks = page.sensitiveRects.toString();
  for (const rule of ['element.type === "password"', 'token.startsWith("cc-")', '"one-time-code"', "allow", "stripe\\.com"]) assert.ok(masks.includes(rule), rule);
  // Neither the change report nor the point under a click ever read what is typed in a field.
  for (const fn of [page.changesReport, page.pointAt, page.viewInfo, page.labelRects]) assert.doesNotMatch(fn.toString(), /\.value\b/, fn.name);
});

test("the store package holds only the extension files", async () => {
  const { packageExtension, zipEntries } = await import("./package-extension.mjs");
  const out = await mkdtemp(join(tmpdir(), "trex-extension-test-"));
  try {
    const { file, entries } = await packageExtension(out);
    assert.match(file, /trex-extension-0\.3\.0\.zip$/);
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
