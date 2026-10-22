import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { createProfileModelLoader } = await load("profileModels");
const settings = { shell: "powershell", claudeCommand: "claude", claudeArgs: "", launchMode: "arg" };
const profile = (provider = "claude", extra = {}) => ({ id: `${provider}-2`, name: `${provider} 2`, provider, command: `${provider}-work`,
  args: "", shell: "", launchMode: "arg", configDir: `~/.${provider}-work`, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const claudeModel = value => ({ value, displayName: `Modelo ${value}`, resolvedModel: `${value}-version`, supportedEffortLevels: ["low", "high"] });
const codexModel = value => ({ id: value, model: value, displayName: `Modelo ${value}`, supportedReasoningEfforts: [{ reasoningEffort: "medium" }] });

function harness(extra = {}, timeoutMs = 1_000) {
  const state = { spawned: [], written: [], killed: [], removed: 0, active: 0, line: null, exit: null };
  const transport = {
    listenLine: async (_id, callback) => { state.line = callback; state.active++; return () => { state.active--; state.removed++; }; },
    listenExit: async (_id, callback) => { state.exit = callback; state.active++; return () => { state.active--; state.removed++; }; },
    spawn: async request => { assert.equal(state.active, 2); state.spawned.push(request); },
    write: async (id, line) => { const message = JSON.parse(line); state.written.push({ id, message }); extra.reply?.(message, state); },
    kill: async id => { state.killed.push(id); },
    ...extra.transport,
  };
  return { state, loadModels: createProfileModelLoader(transport, { timeoutMs }) };
}

test("Claude consulta solo initialize con el comando, argumentos, shell y cuenta del destino", async () => {
  const { state, loadModels } = harness({ reply(message, state) {
    assert.equal(message.type, "control_request");
    assert.deepEqual(message.request, { subtype: "initialize" });
    state.line("ruido previo del shell");
    state.line(JSON.stringify({ type: "control_response", response: { request_id: "otra-consulta", subtype: "success", response: { models: [claudeModel("otra-cuenta")] } } }));
    state.line(JSON.stringify({ type: "control_response", response: { request_id: message.request_id, subtype: "success", response: { models: [claudeModel("modelo-cuenta-2")] } } }));
  } });
  const result = await loadModels(profile("claude", { args: '--model mi-alias --add-dir "D:\\shared"', shell: "bash" }), settings, "D:\\project");
  await flush();
  assert.deepEqual(result.map(model => model.value), ["modelo-cuenta-2"]);
  assert.deepEqual(result[0].efforts, ["low", "high"]);
  const request = state.spawned[0];
  assert.equal(request.command, "claude-work");
  assert.equal(request.profileArgs, '--model mi-alias --add-dir "D:\\shared"');
  assert.equal(request.shell, "bash");
  assert.equal(request.cwd, "D:\\project");
  assert.deepEqual(request.env, { CLAUDE_CONFIG_DIR: "~/.claude-work" });
  assert.ok(request.flags.includes("stream-json"));
  assert.ok(!request.flags.includes("--resume"));
  assert.equal(state.written.length, 1);
  assert.equal(state.killed.length, 1);
  assert.equal(state.active, 0);
});

test("Codex inicializa y pagina model/list sin crear hilos ni consumir turnos", async () => {
  const { state, loadModels } = harness({ reply(message, state) {
    if (message.method === "initialize") state.line(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === "model/list") state.line(JSON.stringify({ id: message.id, result: message.params.cursor
      ? { data: [codexModel("modelo-a"), codexModel("modelo-b"), { ...codexModel("oculto"), hidden: true }], nextCursor: null }
      : { data: [codexModel("modelo-a")], nextCursor: "segunda-pagina" } }));
  } });
  const result = await loadModels(profile("codex", { args: '-c model_provider="cuenta2" --model modelo-perfil' }), settings, "D:\\project");
  await flush();
  assert.deepEqual(result.map(model => model.value), ["modelo-a", "modelo-b"]);
  assert.deepEqual(state.written.map(entry => entry.message.method), ["initialize", "initialized", "model/list", "model/list"]);
  assert.deepEqual(state.written.at(-1).message.params, { cursor: "segunda-pagina" });
  assert.deepEqual(state.spawned[0].flags, ["app-server", "-c", "model_provider=cuenta2", "--enable", "default_mode_request_user_input"]);
  assert.equal(state.spawned[0].profileArgs, null);
  assert.equal(state.spawned[0].shell, "powershell");
  assert.deepEqual(state.spawned[0].env, { CODEX_HOME: "~/.codex-work" });
  assert.equal(state.killed.length, 1);
  assert.equal(state.active, 0);
});

test("un catálogo vacío permite que la interfaz ofrezca el predeterminado del perfil", async () => {
  const { state, loadModels } = harness({ reply(message, state) {
    state.line(JSON.stringify({ type: "control_response", response: { request_id: message.request_id, subtype: "success", response: {} } }));
  } });
  assert.deepEqual(await loadModels(profile(), settings, "D:\\project"), []);
  await flush();
  assert.equal(state.active, 0);
});

test("rechaza perfiles especiales antes de arrancar un proceso", async () => {
  const { state, loadModels } = harness();
  for (const target of [profile("claude", { args: "--continue" }), profile("codex", { args: "resume --last" }), profile("codex", { args: "--remote ws://example" })]) {
    await assert.rejects(loadModels(target, settings, "D:\\project"), /perfil/i);
  }
  assert.equal(state.spawned.length, 0);
  assert.equal(state.active, 0);
});

test("los errores de protocolo liberan todos los recursos y conservan la explicación", async () => {
  for (const provider of ["claude", "codex"]) {
    const { state, loadModels } = harness({ reply(message, state) {
      state.line(JSON.stringify(provider === "claude"
        ? { type: "control_response", response: { request_id: message.request_id, subtype: "error", error: "Cuenta sin acceso" } }
        : { id: message.id, error: { message: "Cuenta sin acceso" } }));
    } });
    await assert.rejects(loadModels(profile(provider), settings, "D:\\project"), /Cuenta sin acceso/);
    await flush();
    assert.equal(state.active, 0);
    assert.equal(state.killed.length, 1);
  }
});

test("un cursor repetido falla en vez de consultar indefinidamente", async () => {
  const { state, loadModels } = harness({ reply(message, state) {
    if (message.method === "initialize") state.line(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === "model/list") state.line(JSON.stringify({ id: message.id, result: { data: [codexModel("modelo")], nextCursor: "repetido" } }));
  } });
  await assert.rejects(loadModels(profile("codex"), settings, "D:\\project"), /página.*repetida/);
  await flush();
  assert.equal(state.active, 0);
  assert.equal(state.written.filter(entry => entry.message.method === "model/list").length, 2);
});

test("el cierre del CLI y los fallos de escritura no dejan el selector esperando", async () => {
  for (const behavior of ["exit", "write-error"]) {
    const { state, loadModels } = harness({ reply(_message, state) {
      if (behavior === "exit") state.exit(1); else throw new Error("No se pudo escribir");
    } });
    await assert.rejects(loadModels(profile(), settings, "D:\\project"), behavior === "exit" ? /se cerró/ : /No se pudo escribir/);
    await flush();
    assert.equal(state.active, 0);
    assert.equal(state.killed.length, 1);
  }
});

test("el límite de tiempo cierra el proceso aunque el CLI no responda", async () => {
  const { state, loadModels } = harness({}, 20);
  await assert.rejects(loadModels(profile(), settings, "D:\\project"), /tardó demasiado/);
  await flush();
  assert.equal(state.spawned.length, 1);
  assert.equal(state.active, 0);
  assert.equal(state.killed.length, 1);
});

test("una consulta cancelada antes de empezar no registra listeners ni arranca asistentes", async () => {
  const controller = new AbortController();
  controller.abort();
  const { state, loadModels } = harness();
  await assert.rejects(loadModels(profile(), settings, "D:\\project", controller.signal), /canceló/);
  assert.equal(state.spawned.length, 0);
  assert.equal(state.active, 0);
  assert.equal(state.killed.length, 0);
});

test("cancelar durante el registro cierra también los listeners que llegan tarde", async () => {
  const registration = deferred();
  let removed = 0;
  const { state, loadModels } = harness({ transport: { listenLine: () => registration.promise } });
  const controller = new AbortController();
  const pending = loadModels(profile(), settings, "D:\\project", controller.signal);
  controller.abort();
  await assert.rejects(pending, /canceló/);
  registration.resolve(() => { removed++; });
  await flush();
  assert.equal(removed, 1);
  assert.equal(state.active, 0);
  assert.equal(state.spawned.length, 0);
  assert.equal(state.killed.length, 0);
});

test("cancelar durante spawn vuelve a cerrar el proceso si el backend termina de crearlo después", async () => {
  const spawned = deferred();
  const { state, loadModels } = harness({ transport: { spawn: request => { state.spawned.push(request); return spawned.promise; } } });
  const controller = new AbortController();
  const pending = loadModels(profile(), settings, "D:\\project", controller.signal);
  await flush();
  controller.abort();
  await assert.rejects(pending, /canceló/);
  await flush();
  assert.equal(state.killed.length, 1);
  spawned.resolve({});
  await flush();
  assert.equal(state.killed.length, 2);
  assert.equal(state.active, 0);
  assert.equal(state.written.length, 0);
});

test("fallar un registro limpia los listeners que ya se registraron y los que llegan tarde", async () => {
  const registration = deferred();
  let removed = 0;
  const { state, loadModels } = harness({ transport: {
    listenLine: () => registration.promise,
    listenExit: async () => { throw new Error("No se pudo registrar el evento"); },
  } });
  await assert.rejects(loadModels(profile(), settings, "D:\\project"), /registrar/);
  registration.resolve(() => { removed++; });
  await flush();
  assert.equal(removed, 1);
  assert.equal(state.spawned.length, 0);
});

test("un error de spawn cierra listeners y no envía inicialización", async () => {
  const { state, loadModels } = harness({ transport: { spawn: async () => { throw new Error("No se encontró el comando"); } } });
  await assert.rejects(loadModels(profile(), settings, "D:\\project"), /comando/);
  await flush();
  assert.equal(state.active, 0);
  assert.equal(state.written.length, 0);
  assert.equal(state.killed.length, 1);
});
