import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/WindowControls.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const compile = new Function("require", "exports", "document", code);
const flush = () => new Promise(resolve => setImmediate(resolve));
const jsx = (type, props) => ({ type, props: props ?? {} });
function* elements(node) {
  if (Array.isArray(node)) { for (const child of node) yield* elements(child); }
  else if (node && typeof node === "object" && node.props) { yield node; yield* elements(node.props.children); }
}
function harness(t, extra = {}) {
  const slots = [], effects = [], calls = [], body = {};
  let cursor = 0, resize, nativeMaximized = false, mounted = true, unlistened = false;
  const react = {
    useState(initial) { const i = cursor++, slot = slots[i] ??= { value: initial }; return [slot.value, value => { if (mounted) slot.value = value; }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffect(effect) { const i = cursor++; if (!slots[i]) { const slot = slots[i] = {}; effects.push(() => { slot.cleanup = effect(); }); } },
  };
  const icons = new Proxy({}, { get: (_, key) => String(key) });
  const native = { closeWindow: () => calls.push("close"), minimizeWindow: () => calls.push("minimize"), toggleMaximizeWindow: () => calls.push("maximize"),
    isWindowMaximized: async () => nativeMaximized, onWindowResized: handler => { resize = handler; return () => { unlistened = true; }; } };
  const exports = {};
  compile(name => ({ react,
    "react/jsx-runtime": { jsx, jsxs: jsx }, "./Icons": icons, "./DropdownMenu": { __esModule: true, default: "DropdownMenu" }, "../window": native, "../platform": { MOD_LABEL: "Ctrl" } })[name], exports, { body });
  const props = { onOpenSettings: () => calls.push("settings"), onRevealProject: () => calls.push("folder"), autoHideTopBar: false, onToggleTopBar: () => calls.push("auto-hide"), ...extra };
  const render = () => { cursor = 0; const tree = exports.default(props); for (const effect of effects.splice(0)) effect(); return tree; };
  const unmount = () => { if (!mounted) return; mounted = false; for (const slot of slots) slot?.cleanup?.(); };
  t.after(unmount);
  return { body, calls, props, render, unmount, get unlistened() { return unlistened; }, async maximize(value) { nativeMaximized = value; resize(); await flush(); } };
}
const find = (tree, predicate) => { const matches = [...elements(tree)].filter(predicate); assert.equal(matches.length, 1); return matches[0]; };
const button = (tree, label) => find(tree, node => node.type === "button" && node.props["aria-label"] === label);

for (const autoHideTopBar of [false, true]) test(`caption controls remain inside the auto-hiding header (${autoHideTopBar}) in standard order`, async t => {
  const h = harness(t, { autoHideTopBar }), tree = h.render(); await flush();
  const group = find(tree, node => node.props["aria-label"] === "Controles de ventana");
  assert.equal([...elements(tree)].some(node => node.type === "portal"), false);
  assert.deepEqual([...elements(group)].filter(node => node.type === "button").map(node => node.props["aria-label"]), ["Minimizar ventana", "Maximizar ventana", "Cerrar ventana"]);
  assert.equal(find(tree, node => node.type === "DropdownMenu").props.children.find(node => node?.props?.role === "menuitemcheckbox").props["aria-checked"], autoHideTopBar);
});

test("window menu omits duplicate exit actions while the caption retains close", t => {
  const h = harness(t), tree = h.render();
  const menu = find(tree, node => node.type === "DropdownMenu");
  const menuText = [...elements(menu)].filter(node => node.props.role === "menuitem").flatMap(node => node.props.children).filter(value => typeof value === "string");
  assert.ok(!menuText.includes("Salir de trex")); assert.ok(!menuText.includes("Cerrar ventana"));
  assert.ok(button(tree, "Cerrar ventana"));
});

test("each visible caption button calls only its corresponding native action", async t => {
  const h = harness(t), tree = h.render(); await flush();
  for (const label of ["Minimizar ventana", "Maximizar ventana", "Cerrar ventana"]) button(tree, label).props.onClick();
  assert.deepEqual(h.calls, ["minimize", "maximize", "close"]);
});

test("native maximize and resize changes keep the restore action accurate", async t => {
  const h = harness(t); h.render(); await flush();
  await h.maximize(true);
  const restored = button(h.render(), "Restaurar ventana"); assert.equal(restored.props.children.type, "RestoreIcon"); restored.props.onClick();
  assert.deepEqual(h.calls, ["maximize"]);
  await h.maximize(false); assert.equal(button(h.render(), "Maximizar ventana").props.children.type, "MaximizeIcon");
});

test("the application menu still opens settings and closes itself", async t => {
  const h = harness(t); h.render(); await flush();
  button(h.render(), "Más opciones").props.onClick({ currentTarget: { id: "menu" } });
  const menu = find(h.render(), node => node.type === "DropdownMenu"); assert.ok(menu.props.anchor);
  const settings = [...elements(menu)].find(node => node.props.role === "menuitem" && node.props.children.includes("Ajustes"));
  settings.props.onClick();
  assert.deepEqual(h.calls, ["settings"]); assert.equal(find(h.render(), node => node.type === "DropdownMenu").props.anchor, null);
});

test("unmount releases the native resize listener", async t => {
  const h = harness(t); h.render(); await flush(); h.unmount(); assert.equal(h.unlistened, true);
});
