import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// El módulo de perfiles es puro. Usa el compilador del proyecto, sin otro runner.
const source = await readFile(new URL("../src/profiles.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { initialProfiles, normalizeProfiles, defaultProfile, launchForProfile, restoreLaunch, normalizeLaunch, profilesError } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const legacy = { claudeCommand: "claude1", claudeArgs: "--continue", launchMode: "inject" };
const settings = () => ({ ...legacy, shell: "zsh", autoRunClaude: true, profiles: initialProfiles(legacy), defaultProfileId: "codex-default" });
const second = { id: "claude-2", name: "Claude 2", provider: "claude", command: "claude2", args: "--resume", shell: "bash", launchMode: "arg", configDir: "~/.claude-2" };

test("la migración conserva el comando personalizado y añade Codex", () => {
  const profiles = normalizeProfiles(undefined, legacy);
  assert.equal(profiles[0].command, "claude1");
  assert.equal(profiles[0].args, "--continue");
  assert.equal(profiles[0].launchMode, "inject");
  assert.equal(profiles[1].provider, "codex");
  assert.equal(profiles[1].command, "codex");
  assert.equal(profiles[1].args, "");
});

test("la normalización no mezcla perfiles de Claude y Codex ni duplica sus ids", () => {
  const profiles = normalizeProfiles([...initialProfiles(legacy), second, { ...second, command: "wrong-account" }, null], legacy);
  assert.deepEqual(profiles.map(profile => profile.command), ["claude1", "codex", "claude2"]);
});

test("cada lanzamiento conserva su comando, shell y carpeta de cuenta", () => {
  const config = settings();
  const first = { ...config.profiles[0], configDir: "~/.claude-1" };
  const one = launchForProfile(config, first), two = launchForProfile(config, second);
  assert.equal(one.command, "claude1");
  assert.equal(one.shell, "zsh");
  assert.deepEqual(one.env, { CLAUDE_CONFIG_DIR: "~/.claude-1" });
  assert.equal(two.command, "claude2");
  assert.equal(two.shell, "bash");
  assert.deepEqual(two.env, { CLAUDE_CONFIG_DIR: "~/.claude-2" });
  first.command = "another-account";
  first.configDir = "~/.other";
  config.shell = "fish";
  assert.equal(one.command, "claude1");
  assert.equal(one.shell, "zsh");
  assert.deepEqual(one.env, { CLAUDE_CONFIG_DIR: "~/.claude-1" });
});

test("Codex recibe CODEX_HOME y un shell limpio no hereda el perfil", () => {
  const config = settings();
  assert.equal(defaultProfile(config).provider, "codex");
  const codex = launchForProfile(config, { ...defaultProfile(config), configDir: "~/.codex-work", args: "resume --last" });
  assert.equal(codex.command, "codex");
  assert.equal(codex.args, "resume --last");
  assert.deepEqual(codex.env, { CODEX_HOME: "~/.codex-work" });
  assert.equal(launchForProfile(config, null).command, null);
  assert.equal(launchForProfile(config, null).env, null);
});

test("restaurar una sesión de un perfil eliminado conserva la cuenta original", () => {
  const config = settings();
  const original = launchForProfile(config, second);
  const persisted = { projectId: "p1", kind: "claude", subtitle: "Trabajo", launch: original };
  const restored = restoreLaunch(persisted, config);
  assert.deepEqual(restored, original);
  assert.equal(restored.command, "claude2");
  assert.notEqual(restored.command, defaultProfile(config).command);
});

test("las pestañas antiguas de Claude no pasan a Codex al cambiar el predeterminado", () => {
  const config = settings();
  const tab = { projectId: "p1", kind: "claude", subtitle: "claude" };
  assert.equal(restoreLaunch(tab, config).command, "claude1");
  config.autoRunClaude = false;
  assert.equal(restoreLaunch(tab, config).command, null);
});

test("un lanzamiento persistido incompleto se rechaza para evitar cambiar de cuenta", () => {
  assert.equal(normalizeLaunch({ shell: "zsh", profileId: "claude-2" }, "claude"), undefined);
  const launch = launchForProfile(settings(), second);
  assert.deepEqual(normalizeLaunch(JSON.parse(JSON.stringify(launch)), "claude"), launch);
});

test("la validación impide comandos vacíos, nombres confusos y rutas relativas", () => {
  assert.equal(profilesError([second]), null);
  assert.ok(profilesError([{ ...second, command: " " }]));
  assert.ok(profilesError([second, { ...second, id: "another", name: "claude 2" }]));
  assert.ok(profilesError([{ ...second, configDir: "relative/config" }]));
  assert.ok(profilesError([{ ...second, args: "--resume\nclaude1" }]));
});
