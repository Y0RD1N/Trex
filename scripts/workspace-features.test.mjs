import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const stub = `data:text/javascript;base64,${Buffer.from('export const invoke = () => {throw new Error("Unexpected native call")}; export const listen = invoke; export const getCurrentWindow = invoke; export const isPermissionGranted = invoke; export const requestPermission = invoke;').toString("base64")}`;
const cache = new Map();
async function compiled(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  let { outputText } = ts.transpileModule(await readFile(url, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  for (const match of outputText.matchAll(/from "([^"]+)"/g)) {
    const specifier = match[1];
    const target = specifier.startsWith("@tauri-apps/")
      ? stub
      : await compiled(new URL(`${specifier}.ts`, url));
    outputText = outputText.replace(`from "${specifier}"`, `from "${target}"`);
  }
  const result = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
  cache.set(url.href, result);
  return result;
}
const module = async (name) =>
  import(await compiled(new URL(`../src/${name}.ts`, import.meta.url)));
const { DEFAULT_SHORTCUTS, bindingError, normalizeShortcuts, matchesShortcut } =
  await module("shortcuts");
const { parseShortcut } = await module("paste");
const { visibleSplit, clampSplitRatio, normalizeSplitLayout, createSplitLayout, replaceSplitPane, splitPaneStyle } = await module("splitLayout");
const { canResume, resumedLaunch, validConversationId } =
  await module("conversations");
const { normalizeConfig } = await module("api");
const { filterCommands } = await module("commandPalette");
const { shouldNotify } = await module("desktopNotifications");
const key = (value, code, extra = {}) => ({
  key: value,
  code,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
  ...extra,
});

test("todos los atajos predeterminados son distintos y mantienen Ctrl+V", () => {
  assert.equal(bindingError(DEFAULT_SHORTCUTS, "Ctrl+V"), null);
  assert.match(
    bindingError({ ...DEFAULT_SHORTCUTS, toggleSplit: "Ctrl+K" }, "Ctrl+V"),
    /usan Ctrl\+K/,
  );
  assert.match(
    bindingError({ ...DEFAULT_SHORTCUTS, toggleSplit: "Ctrl+C" }, "Ctrl+V"),
    /reserva/,
  );
  assert.match(
    bindingError({ ...DEFAULT_SHORTCUTS, toggleSplit: "Meta+K" }, "Ctrl+V"),
    /usan Ctrl\+K/,
  );
  assert.match(
    bindingError({ ...DEFAULT_SHORTCUTS, toggleSplit: "Meta+D" }, "Ctrl+V"),
    /reserva/,
  );
  assert.deepEqual(normalizeShortcuts({ commandPalette: "Ctrl+Y" }, "Ctrl+V"), {
    ...DEFAULT_SHORTCUTS,
    commandPalette: "Ctrl+Y",
  });
  assert.equal(bindingError(DEFAULT_SHORTCUTS, "Ctrl+Shift+V"), null);
});
test("los atajos comprueban Alt, Shift y la tecla física en teclados distintos", () => {
  assert.equal(parseShortcut("ctrl+tab"), "Ctrl+Tab");
  assert.equal(parseShortcut("Ctrl+,"), "Ctrl+,");
  assert(matchesShortcut(key("k", "KeyK"), "Ctrl+K"));
  assert(!matchesShortcut(key("k", "KeyK", { altKey: true }), "Ctrl+K"));
  assert(matchesShortcut(key("=", "Equal"), "Ctrl+Equal"));
  assert(
    matchesShortcut(
      key("k", "KeyK", { ctrlKey: false, metaKey: true }),
      "Ctrl+K",
    ),
  );
});
test("los paneles conservan su orden al cambiar el foco y un cierre deja un hueco", () => {
  const layout = { panes: ["a", "b"], direction: "columns", ratio: 0.5, rowRatio:0.5 };
  assert.strictEqual(visibleSplit(layout, ["a", "b", "c"], "b"), layout);
  assert.deepEqual(visibleSplit(layout, ["a", "b", "c"], "c"), {
    ...layout,
    panes: ["c", "b"],
  });
  assert.deepEqual(visibleSplit(layout, ["a"], "a").panes, ["a",null]);
  assert.equal(visibleSplit(layout, ["a", "b"], "z"), null);
  assert.equal(clampSplitRatio(NaN), 0.5);
  assert.equal(clampSplitRatio(-1), 0.25);
  assert.equal(clampSplitRatio(2), 0.75);
});
test("cuatro paneles permiten cualquier combinación, conservan su posición y no duplican sesiones", () => {
  // Los IDs pueden corresponder a cuatro Claude, cuatro Codex o perfiles distintos.
  const ids = ["claude-1", "claude-2", "claude-3", "claude-4", "extra"];
  const layout = createSplitLayout("grid", ids, ids[0], null);
  assert.deepEqual(layout.panes, ids.slice(0,4));
  for (const id of layout.panes) assert.strictEqual(visibleSplit(layout,ids,id),layout);
  assert.strictEqual(replaceSplitPane(layout,0,ids[2]),layout);
  assert.strictEqual(replaceSplitPane(layout,4,"extra"),layout);
  const replacement = replaceSplitPane(layout,2,"extra");
  assert.deepEqual(replacement.panes,[ids[0],ids[1],"extra",ids[3]]);
  assert.deepEqual(layout.panes,ids.slice(0,4));
  const closed = visibleSplit(layout, [ids[0],ids[2],ids[3]], ids[3]);
  assert.deepEqual(closed.panes,[ids[0],null,ids[2],ids[3]]);
  assert.strictEqual(createSplitLayout("grid",[ids[0],ids[2],ids[3]],ids[3],closed),closed);
  assert.deepEqual(visibleSplit(closed,ids,"extra").panes,[ids[0],"extra",ids[2],ids[3]]);
  const anotherProject = visibleSplit(layout,["another-project"],"another-project");
  assert.deepEqual(anotherProject.panes,["another-project",null,null,null]);
  const smaller = createSplitLayout("rows",ids,ids[3],layout);
  assert.equal(smaller.panes.length,2);
  assert(smaller.panes.includes(ids[3]));
});
test("se puede elegir cuatro paneles con una sola sesión y rellenarlos después", () => {
  const layout = createSplitLayout("grid",["a"],"a",null);
  assert.deepEqual(layout.panes,["a",null,null,null]);
  assert.deepEqual(replaceSplitPane(layout,3,"b").panes,["a",null,null,"b"]);
  const two = createSplitLayout("columns",["a","b"],"b",null);
  assert.deepEqual(createSplitLayout("grid",["a","b","c","d"],"b",two).panes,["b","a","c","d"]);
});
test("migra los dos paneles anteriores y limita la cuadrícula a cuatro IDs únicos", () => {
  assert.deepEqual(normalizeSplitLayout({first:"a",second:"b",direction:"rows",ratio:0.6}),{
    panes:["a","b"],direction:"rows",ratio:0.6,rowRatio:0.5,
  });
  assert.deepEqual(normalizeSplitLayout({panes:["a","a",null,"b","c"],direction:"grid",ratio:1,rowRatio:0}).panes,["a",null,null,"b"]);
  assert.equal(normalizeSplitLayout({panes:[null,null],direction:"rows"}),null);
  assert.equal(normalizeSplitLayout({first:"a",second:"b",ratio:"invalid"}).ratio,0.5);
});
test("los cuatro cuadrantes usan márgenes simétricos y dos ejes independientes", () => {
  const layout = createSplitLayout("grid",["a"],"a",null);
  const styles = Array.from({length:4},(_,index)=>splitPaneStyle(layout,index));
  assert.equal(styles[0].right,styles[2].right);
  assert.equal(styles[1].left,styles[3].left);
  assert.equal(styles[0].bottom,styles[1].bottom);
  assert.equal(styles[2].top,styles[3].top);
  assert.equal(styles[0].right,styles[1].left);
  assert.equal(styles[0].bottom,styles[2].top);
  const resized = splitPaneStyle({...layout,ratio:0.6,rowRatio:0.4},3);
  assert.match(resized.left,/60%/);
  assert.match(resized.top,/40%/);
  assert.equal(splitPaneStyle({...layout,direction:"rows"},1).left,undefined);
});
test("recuperar por ID conserva la cuenta, el shell y las opciones del perfil", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const launch = {
    command: "claude-work",
    args: "--model sonnet",
    shell: "zsh",
    launchMode: "inject",
    env: { CLAUDE_CONFIG_DIR: "~/.claude-work" },
  };
  assert.equal(
    resumedLaunch(launch, "claude", id).args,
    `--model sonnet --resume ${id}`,
  );
  assert.strictEqual(resumedLaunch(launch, "claude", id).env, launch.env);
  assert.equal(
    resumedLaunch(
      { ...launch, command: "codex-work", args: "-m model" },
      "codex",
      id,
    ).args,
    `-m model resume ${id}`,
  );
  assert(!canResume({ ...launch, args: "--continue" }, "claude"));
  assert(!canResume({ ...launch, args: "resume --last" }, "codex"));
  assert.throws(() => resumedLaunch(launch, "claude", "id; rm -rf /"));
  assert(!validConversationId("../../session"));
});
test("la configuración antigua migra y la nueva conserva atajos, paneles e IDs de conversaciones", () => {
  const old = normalizeConfig({});
  assert.equal(old.settings.pasteShortcut, "Ctrl+V");
  assert.equal(old.settings.imagePastePreview, true);
  assert.deepEqual(old.ui.splitLayouts, {});
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const config = normalizeConfig({
    settings: {
      shortcuts: { commandPalette: "Ctrl+Y" },
      pasteShortcut: "Ctrl+K",
      desktopNotifications: false,
    },
    ui: {
      lastTabs: [
        {
          id: "t-123-abcd",
          projectId: "p",
          kind: "claude",
          conversationId: id,
        },
      ],
      splitLayouts: {
        p: { first: "a", second: "b", direction: "rows", ratio: 0.6 },
      },
    },
  });
  assert.equal(config.settings.shortcuts.commandPalette, "Ctrl+Y");
  assert.equal(config.settings.pasteShortcut, "Ctrl+K");
  assert.equal(config.settings.desktopNotifications, false);
  assert.equal(config.ui.lastTabs[0].conversationId, id);
  assert.equal(config.ui.lastTabs[0].id, "t-123-abcd");
  assert.equal(config.ui.splitLayouts.p.direction, "rows");
  assert.deepEqual(config.ui.splitLayouts.p.panes,["a","b"]);
  assert.equal(
    normalizeConfig({ settings: { pasteShortcut: "Ctrl+K" } }).settings
      .pasteShortcut,
    "Ctrl+V",
  );
});
test("la paleta busca sin acentos y excluye acciones que no están disponibles", () => {
  const commands = [
    { id: "1", label: "Recuperar conversación", group: "Acciones", run() {} },
    {
      id: "2",
      label: "Terminal",
      detail: "Proyecto Océano",
      group: "Sesiones",
      run() {},
    },
    {
      id: "3",
      label: "Dividir terminal",
      group: "Acciones",
      disabled: true,
      run() {},
    },
  ];
  assert.deepEqual(
    filterCommands(commands, "recuperar conversacion").map((x) => x.id),
    ["1"],
  );
  assert.deepEqual(
    filterCommands(commands, "terminal oceano").map((x) => x.id),
    ["2"],
  );
  assert.equal(filterCommands(commands, "dividir").length, 0);
});
test("los avisos del escritorio respetan silencio y foco sin duplicar los avisos internos", () => {
  assert(!shouldNotify(false, true, false));
  assert(!shouldNotify(true, false, true));
  assert(shouldNotify(true, false, false));
  assert(shouldNotify(true, true, true));
});
