import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const launcher = await load("projectLauncher");
const { normalizeConfig } = await load("api");
const { normalizeShortcuts, DEFAULT_SHORTCUTS, bindingError } = await load("shortcuts");
const { normalizeProjectLauncher, addLauncherRoot, launcherProfileId, launchCandidates, rankCandidates, launchScore, MAX_LAUNCHER_ROOTS } = launcher;

test("el lanzador nace sin carpetas, vuelve al chat abierto y limpia raíces repetidas o inválidas", () => {
  assert.deepEqual(normalizeConfig({}).settings.projectLauncher, { roots: [], profileId: "", reuseChat: true });
  for (const raw of [undefined, null, "D:\\projects", [], 4]) assert.deepEqual(normalizeProjectLauncher(raw), { roots: [], profileId: "", reuseChat: true });
  const config = normalizeConfig({ settings: { projectLauncher: {
    roots: [" D:\\projects ", "d:/projects/", 7, "", "E:\\clientes"], profileId: "codex-default", reuseChat: false,
  } } });
  assert.deepEqual(config.settings.projectLauncher, { roots: ["D:\\projects", "E:\\clientes"], profileId: "codex-default", reuseChat: false });
  const many = normalizeProjectLauncher({ roots: Array.from({ length: MAX_LAUNCHER_ROOTS + 5 }, (_, i) => `C:\\r${i}`) });
  assert.equal(many.roots.length, MAX_LAUNCHER_ROOTS);
});

test("añadir una carpeta raíz rechaza la misma ruta escrita de otra forma y respeta el tope", () => {
  const base = { roots: ["D:\\projects"], profileId: "", reuseChat: true };
  assert.equal(addLauncherRoot(base, "d:/PROJECTS/"), null);
  assert.equal(addLauncherRoot(base, "   "), null);
  const next = addLauncherRoot(base, "E:\\clientes");
  assert.deepEqual(next.roots, ["D:\\projects", "E:\\clientes"]);
  assert.deepEqual(base.roots, ["D:\\projects"], "no muta los ajustes guardados");
  const full = { ...base, roots: Array.from({ length: MAX_LAUNCHER_ROOTS }, (_, i) => `C:\\r${i}`) };
  assert.equal(addLauncherRoot(full, "C:\\otra"), null);
});

test("el agente elegido en Ajustes se usa mientras exista; si no, el predeterminado", () => {
  const ids = ["claude-default", "codex-default"];
  assert.equal(launcherProfileId({ roots: [], profileId: "codex-default", reuseChat: true }, ids, "claude-default"), "codex-default");
  assert.equal(launcherProfileId({ roots: [], profileId: "borrado", reuseChat: true }, ids, "claude-default"), "claude-default");
  assert.equal(launcherProfileId({ roots: [], profileId: "", reuseChat: true }, ids, "claude-default"), "claude-default");
});

test("los proyectos de trex y las carpetas se unen sin repetir la misma ruta", () => {
  const projects = [
    { id: "p1", name: "Trex (app)", path: "D:\\projects\\trex", createdAt: 10, lastOpenedAt: 500 },
    { id: "p2", name: "Suelto", path: "C:\\otros\\suelto", createdAt: 20, lastOpenedAt: null },
  ];
  const folders = [
    { name: "trex", path: "d:/projects/trex/", root: "D:\\projects", git: true, modified: 900 },
    { name: "mangi", path: "D:\\projects\\mangi", root: "D:\\projects", git: false, modified: 300 },
  ];
  const candidates = launchCandidates(projects, folders);
  assert.equal(candidates.length, 3);
  const trex = candidates.find(item => item.projectId === "p1");
  assert.equal(trex.name, "Trex (app)", "conserva el nombre que tiene en trex");
  assert.equal(trex.root, "D:\\projects");
  assert.equal(trex.git, true);
  assert.equal(trex.recent, 900, "lo más reciente entre abrirlo en trex y tocar la carpeta");
  assert.equal(candidates.find(item => item.name === "mangi").projectId, null);
  assert.equal(candidates.find(item => item.projectId === "p2").root, null);
});

test("la búsqueda prefiere el nombre exacto, luego el principio, una palabra, contenerlo y las letras en orden", () => {
  const item = (name, recent = 0, path = `D:\\projects\\${name}`) => ({ key: path.toLowerCase(), name, path, root: "D:\\projects", projectId: null, git: false, recent });
  const list = [item("mi-trex", 5), item("trex-cli", 1), item("trex", 0), item("tierra-roja-ex", 9), item("contrexto", 3), item("otro", 50, "D:\\trex\\otro")];
  assert.deepEqual(rankCandidates(list, "trex").map(c => c.name), ["trex", "trex-cli", "mi-trex", "contrexto", "tierra-roja-ex", "otro"]);
  assert.deepEqual(rankCandidates(list, "").map(c => c.name), ["otro", "tierra-roja-ex", "mi-trex", "contrexto", "trex-cli", "trex"], "sin búsqueda manda lo reciente");
  assert.equal(launchScore(item("Árbol"), "arbol"), 0, "sin acentos ni mayúsculas");
  assert.equal(launchScore(item("trex"), "trx"), 4);
  assert.equal(launchScore(item("trex"), "tx"), 4, "letras sueltas pero en orden");
  assert.equal(launchScore(item("trex"), "xt"), null, "en otro orden no casa");
  assert.equal(launchScore(item("mangi"), "zzz"), null);
  assert.equal(launchScore(item("cliente app web"), "web cliente"), 3, "varias palabras en cualquier orden");
});

test("el atajo nuevo no le quita Ctrl+Space a un atajo ya elegido ni reinicia los demás", () => {
  assert.equal(DEFAULT_SHORTCUTS.openProject, "Ctrl+Space");
  const shortcuts = normalizeShortcuts({ toggleSplit: "Ctrl+Space", commandPalette: "Ctrl+Y" }, "Ctrl+V");
  assert.equal(shortcuts.toggleSplit, "Ctrl+Space");
  assert.equal(shortcuts.commandPalette, "Ctrl+Y", "los demás atajos personalizados se conservan");
  assert.equal(shortcuts.openProject, "Ctrl+Shift+Space");
  assert.equal(bindingError(shortcuts, "Ctrl+V"), null);
  const custom = normalizeShortcuts({ openProject: "Ctrl+Alt+P" }, "Ctrl+V");
  assert.equal(custom.openProject, "Ctrl+Alt+P");
  assert.equal(normalizeConfig({ settings: { shortcuts: { openProject: "Ctrl+Shift+O" } } }).settings.shortcuts.openProject, "Ctrl+Shift+O");
});
