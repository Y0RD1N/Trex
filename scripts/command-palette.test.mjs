import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

const source = await readFile(new URL("../src/components/CommandPalette.tsx", import.meta.url), "utf8");
const compiled = new Function("require", "exports", "document", "requestAnimationFrame", ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText);
const helpers = { "../commandPalette": await load("commandPalette"), "../shortcuts": await load("shortcuts") };
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
function* elements(node) {
  if (Array.isArray(node)) { for (const child of node) yield* elements(child); }
  else if (node && typeof node === "object" && node.props) { yield node; yield* elements(node.props.children); }
}

function harness() {
  const slots = [], effects = [], frames = [], calls = [];
  let cursor = 0, dirty = false, closes = 0, tree;
  const hooks = {
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useState(initial) {
      const slot = slots[cursor++] ??= { value: initial };
      return [slot.value, next => { const value = typeof next === "function" ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; } }];
    },
    useMemo(work) { return work(); },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
    useId() { return hooks.useRef("palette-fixture").current; },
  };
  const exports = {}, modules = { ...helpers, react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx },
    "./FeatureDialog": { __esModule: true, default: "FeatureDialog" }, "./Icons": new Proxy({}, { get: () => () => null }),
    "./CommandPalette.css": {}, "../motion": { waitForMotion: (_surface, finish) => finish() } };
  compiled(name => { assert.ok(modules[name], `Unexpected palette dependency: ${name}`); return modules[name]; }, exports,
    { getElementById: () => null }, callback => { frames.push(callback); return frames.length; });
  const commands = [
    { id: "first", label: "Primera acción", group: "Acciones" },
    { id: "disabled", label: "Deshabilitada", group: "Acciones", disabled: true },
    { id: "project", label: "Proyecto", group: "Proyectos" },
    { id: "last", label: "Última acción", group: "Acciones" },
  ].map(command => ({ ...command, run: () => calls.push(command.id) }));
  const render = () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      cursor = 0; dirty = false;
      tree = exports.default({ commands, onClose: () => closes++ });
      for (const effect of effects.splice(0)) effect();
      if (!dirty) return tree;
    }
    throw Error("Palette fixture did not settle");
  };
  const find = predicate => { const matches = [...elements(tree)].filter(predicate); assert.equal(matches.length, 1); return matches[0]; };
  const flush = () => { for (const callback of frames.splice(0)) callback(); };
  render();
  return { calls, render, flush, unmount() { for (const slot of slots) slot?.cleanup?.(); },
    get closes() { return closes; },
    get selected() { return find(node => node.props.role === "option" && node.props["aria-selected"]); },
    key(key) { find(node => node.props.role === "combobox").props.onKeyDown({ key, preventDefault() {} }); render(); },
    dismiss() { tree.props.onClose(); },
  };
}

test("palette actions wait for actual dismissal before opening the next surface, and run once", () => {
  const h = harness();
  h.selected.props.onClick(); h.selected.props.onClick(); h.flush();
  assert.equal(h.closes, 1);
  assert.deepEqual(h.calls, [], "finishing an animation alone must not execute while the old dialog still owns focus");
  h.unmount(); assert.deepEqual(h.calls, []);
  h.flush(); h.flush(); assert.deepEqual(h.calls, ["first"]);
});

test("palette keyboard selection follows the existing flat order across grouped results and skips disabled actions", () => {
  const h = harness();
  h.key("ArrowDown"); assert.equal(h.selected.props.id, "palette-fixture-1");
  h.key("Enter"); h.flush(); assert.deepEqual(h.calls, []);
  h.unmount(); h.flush(); assert.deepEqual(h.calls, ["project"]);
});

test("dismissing the palette without choosing an action never executes a highlighted result", () => {
  const h = harness(); h.key("ArrowUp");
  assert.equal(h.selected.props.id, "palette-fixture-2");
  h.dismiss(); h.unmount(); h.flush();
  assert.equal(h.closes, 1); assert.deepEqual(h.calls, []);
});
