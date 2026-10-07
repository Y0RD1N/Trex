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
const { visibleSplit, clampSplitRatio } = await module("splitLayout");
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
test("los dos paneles conservan su orden al cambiar el foco y sobreviven al cierre de una sesión", () => {
  const layout = { first: "a", second: "b", direction: "columns", ratio: 0.5 };
  assert.strictEqual(visibleSplit(layout, ["a", "b", "c"], "b"), layout);
  assert.deepEqual(visibleSplit(layout, ["a", "b", "c"], "c"), {
    ...layout,
    first: "c",
  });
  assert.equal(visibleSplit(layout, ["a"], "a"), null);
  assert.equal(visibleSplit(layout, ["a", "b"], "z"), null);
  assert.equal(clampSplitRatio(NaN), 0.5);
  assert.equal(clampSplitRatio(-1), 0.25);
  assert.equal(clampSplitRatio(2), 0.75);
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
