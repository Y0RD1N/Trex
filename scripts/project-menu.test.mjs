import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";

const helpers = Object.fromEntries(await Promise.all(["api", "shortcuts", "sidebarGroups", "sessionTitle", "agentActivity"].map(async name => [`../${name}`, await load(name)])));
const compiled = Object.fromEntries(await Promise.all(["Sidebar", "ProjectItem"].map(async name => {
  const source = await readFile(new URL(`../src/components/${name}.tsx`, import.meta.url), "utf8");
  return [name, new Function("require", "exports", "window", "document", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText)];
})));
const noop = () => {}, jsx = (type, props) => ({ type, props: props ?? {} });
let active;
const react = Object.fromEntries(["useState", "useRef", "useEffect", "useId"].map(name => [name, (...args) => active[name](...args)]));
function host() {
  const slots = [], effects = []; let cursor = 0, dirty = false;
  const hooks = {
    useState(initial) { const slot = slots[cursor++] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slot.value, next => { const value = typeof next === "function" ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; } }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || !deps?.every((value, at) => Object.is(value, slots[i].deps?.[at]))) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; }); },
    useId() { return hooks.useRef(`project-id-${cursor}`).current; },
    render(component, props) { let tree; for (let i = 0; i < 15; i++) { dirty = false; cursor = 0; active = hooks; tree = component(props); for (const effect of effects.splice(0)) effect(); if (!dirty) return tree; } throw Error("React fixture did not settle"); },
  };
  return hooks;
}
function* elements(node) {
  if (Array.isArray(node)) { for (const child of node) yield* elements(child); }
  else if (node && typeof node === "object" && node.props) { yield node; yield* elements(node.props.children); }
}
const find = (tree, predicate) => { const matches = [...elements(tree)].filter(predicate); assert.equal(matches.length, 1); return matches[0]; };
const label = node => Array.isArray(node.props.children) ? node.props.children.filter(child => typeof child === "string").join("") : node.props.children;

function harness({ peek = false, profiles = [] } = {}) {
  const actions = [], icons = new Proxy({}, { get: (_, key) => String(key) }); let hides = 0;
  const modules = { ...helpers, react, "react/jsx-runtime": { jsx, jsxs: jsx }, "./Icons": icons,
    "./AgentIcon": { __esModule: true, default: "AgentIcon" }, "./SessionItem": { __esModule: true, default: "SessionItem" },
    "./BrandMark": { __esModule: true, default: "BrandMark" }, "./ProjectCore": { __esModule: true, default: "ProjectCore" },
    "./DropdownMenu": { __esModule: true, default: "DropdownMenu" }, "./ProfileMenuItems": { __esModule: true, default: "ProfileMenuItems" },
    "./ProjectFilter": { __esModule: true, default: "ProjectFilter" },
    "../projectIcons": { useProjectIcon: () => null },
    "../hooks/usePresence": { usePresence: value => ({ value, entering: false, leaving: value === null }) },
    "../hooks/useHoverReveal": { useHoverReveal: () => ({ ref: { current: null }, revealed: peek, handlers: {}, hide: () => hides++ }) } };
  const envWindow = { addEventListener: noop, removeEventListener: noop }, envDocument = { body: { classList: { add: noop, remove: noop } } };
  const component = name => { const exports = {}; compiled[name](specifier => { assert.ok(modules[specifier], `Unexpected dependency ${specifier}`); return modules[specifier]; }, exports, envWindow, envDocument); return exports.default; };
  const ProjectItem = component("ProjectItem"); modules["./ProjectItem"] = { __esModule: true, default: ProjectItem };
  const Sidebar = component("Sidebar"), parent = host(), child = host();
  const props = { projects: [{ id: "target", name: "Other project", path: "D:/other" }, { id: "active", name: "Current project", path: "D:/current" }],
    allProjects: [], projectFilter: { mode: "all", projectIds: [] }, onProjectFilterChange: noop,
    profiles, activeProjectId: "active", activeTabId: null, tabs: [], sidebarWidth: 260, sidebarCollapsed: peek,
    claudeInfo: { found: true }, search: "", shortcuts: helpers["../shortcuts"].DEFAULT_SHORTCUTS, themeMode: "light", searchInputRef: { current: null }, updates: [],
    onNewShell: projectId => actions.push(["terminal", projectId]), onWorkflow: projectId => actions.push(["workflow", projectId]),
    onQuickOpen: (projectId, profileId) => actions.push(["profile", projectId, profileId]), onSelect: projectId => actions.push(["select", projectId]),
    onSearchChange: noop, onAdd: noop, onSelectSession: noop, onCloseSession: noop, onRenameSession: noop, onRename: noop, onToggleFavorite: noop,
    onDelete: noop, onReveal: noop, onCopyPath: noop, onOpenSettings: noop, onOpenUsage: noop, onToggleTheme: noop, onToggleSidebar: noop, onResize: noop, onUpdateCli: noop, onDismissUpdate: noop };
  const target = () => find(parent.render(Sidebar, props), node => node.type === ProjectItem && node.props.project.id === "target");
  let tree;
  const render = () => tree = child.render(ProjectItem, target().props);
  render();
  const open = () => { find(tree, node => node.props["aria-label"] === "Opciones de Other project").props.onClick({ currentTarget: {}, stopPropagation: noop }); render(); };
  return { actions, props, target, render, open, get tree() { return tree; }, get hides() { return hides; },
    choose(text) { find(tree, node => node.props.role === "menuitem" && label(node) === text).props.onClick(); render(); },
    get menu() { return find(tree, node => node.type === "DropdownMenu"); } };
}

test("terminal from an inactive project's menu targets that project and expands its sessions", () => {
  const h = harness(); h.open(); h.choose("Nueva terminal");
  assert.deepEqual(h.actions, [["terminal", "target"]]);
  assert.equal(h.target().props.expanded, true); assert.equal(h.menu.props.anchor, null);
  assert.equal(h.props.activeProjectId, "active");
});

test("workflow from an inactive project's menu keeps its identity and closes the floating sidebar", () => {
  const h = harness({ peek: true }); h.open(); h.choose("Configurar flujo de agentes…");
  assert.deepEqual(h.actions, [["workflow", "target"]]); assert.equal(h.menu.props.anchor, null); assert.equal(h.hides, 1);
});

test("new project actions coexist with profile shortcuts, including a project with no open tabs", () => {
  const h = harness({ profiles: [{ id: "claude", name: "Claude", provider: "claude", command: "claude" }] }); h.open();
  for (const text of ["Configurar flujo de agentes…", "Nueva terminal"]) assert.ok([...elements(h.tree)].some(node => node.props.role === "menuitem" && label(node) === text));
  find(h.tree, node => node.type === "ProfileMenuItems").props.onOpen("claude"); h.render();
  assert.deepEqual(h.actions, [["profile", "target", "claude"]]); assert.equal(h.menu.props.anchor, null);
});
