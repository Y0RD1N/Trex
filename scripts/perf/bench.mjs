#!/usr/bin/env node
/**
 * Banco de rendimiento de Trex: arranca una instancia aislada en un compositor sin pantalla
 * (mutter --headless), con un Claude falso, la recorre por escenarios y mide cada uno con
 * /proc (CPU y memoria de cada proceso) y con el perfilador de WebKit.
 *
 * Uso (ver docs/optimizacion/plan.md para compilar el binario con el inspector):
 *   dbus-run-session -- node scripts/perf/bench.mjs <binario-trex> [salida.json] [escenarios,separados]
 *
 * Variables:
 *   BENCH_NO_PROFILE=1   solo /proc (el perfilador de WebKit añade su propio coste: úsalo para las cifras)
 *   BENCH_BLUR=1         ventana sin foco (por defecto se simula que lo tiene)
 *   BENCH_TERMINAL=1     escenario de terminal (pestaña de shell con salida continua) en lugar del chat
 *   BENCH_INJECT_CSS=f   CSS extra antes de medir (experimentos sin recompilar)
 *   BENCH_WINDOW_MS      duración de cada medida (10000 por defecto)
 *   BENCH_LONG_TURNS     turnos del chat largo (40 por defecto)
 *   FAKE_REPEAT          longitud de cada respuesta del Claude falso (8 por defecto aquí)
 *
 * Nunca toca la configuración ni los datos reales: HOME y XDG_* apuntan a un directorio temporal.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findTarget, connect } from "./inspector.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [binary, output = "", only = ""] = process.argv.slice(2);
if (!binary) { console.error("Falta el binario de trex"); process.exit(2); }
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 10000);
const PORT = 9400 + Math.floor(Math.random() * 400);
const root = `/tmp/trex-perf/run-${process.pid}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Entorno aislado -----------------------------------------------------------
rmSync(root, { recursive: true, force: true });
const home = join(root, "home"), project = join(root, "proyecto");
for (const dir of [home, join(root, "config/com.trex.app"), join(root, "data"), join(root, "cache"), project]) mkdirSync(dir, { recursive: true });
writeFileSync(join(project, "README.md"), "# Proyecto de prueba\n");
// Sin estos archivos, zsh abre su asistente de primera configuración y se come la entrada.
for (const rc of [".zshrc", ".bashrc"]) writeFileSync(join(home, rc), "");
execFileSync("git", ["init", "-q"], { cwd: project });
const fake = resolve(here, "fake-claude.mjs");
chmodSync(fake, 0o755);
const now = Date.now();
const config = {
  version: 1,
  projects: [{ id: "p-bench", name: "proyecto", path: project, color: "#e8834a", createdAt: now, lastOpenedAt: null, defaultCommand: null, defaultArgs: null }],
  settings: {
    shell: "default", claudeCommand: fake, claudeArgs: "", autoRunClaude: true, fontSize: 14, fontFamily: "", scrollback: 10000,
    cursorBlink: true, copyOnSelect: false, confirmCloseTab: false, restoreOnStart: true, launchMode: "arg", theme: "#e8834a",
    browserEnabled: false, desktopEnabled: false, a11yEnabled: false,
    profiles: [{ id: "claude-default", name: "Claude Code", provider: "claude", command: fake, args: "", shell: "", launchMode: "arg", configDir: "" }],
    defaultProfileId: "claude-default",
  },
  // BENCH_TERMINAL: en lugar del chat se abre una pestaña de shell (escenario de la terminal).
  ui: { lastProjectId: "p-bench", activeProjectId: "p-bench", sidebarWidth: 268,
    lastTabs: process.env.BENCH_TERMINAL ? [{ id: "t-bench", projectId: "p-bench", kind: "shell", subtitle: "shell" }] : [] },
};
writeFileSync(join(root, "config/com.trex.app/config.json"), JSON.stringify(config, null, 2));

// --- Compositor sin pantalla y Trex ---------------------------------------------
const display = `trex-perf-${process.pid}`;
const mutter = spawn("mutter", ["--headless", "--wayland", "--no-x11", "--virtual-monitor", "1920x1080@60", "--wayland-display", display], { stdio: "ignore" });
await sleep(2500);
const env = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
  WAYLAND_DISPLAY: display, GDK_BACKEND: "wayland", WEBKIT_INSPECTOR_HTTP_SERVER: `127.0.0.1:${PORT}`,
  FAKE_REPEAT: process.env.FAKE_REPEAT ?? "8",
};
delete env.DISPLAY;
const started = Date.now();
const app = spawn(resolve(binary), [], { env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
app.stderr.on("data", chunk => { stderr += chunk; });

// --- Medidas de /proc -------------------------------------------------------------
function processTree(rootPid) {
  const children = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(entry));
    } catch { /* terminó */ }
  }
  const all = [rootPid];
  for (let i = 0; i < all.length; i++) all.push(...(children.get(all[i]) ?? []));
  return all;
}
const comm = (pid) => { try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return "?"; } };
const ticks = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); const f = s.slice(s.lastIndexOf(")") + 2).split(" "); return Number(f[11]) + Number(f[12]); } catch { return 0; } };
const pss = (pid) => { try { return Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))[1]); } catch { return 0; } };
const written = (pid) => { try { return Number(/^wchar:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/io`, "utf8"))[1]); } catch { return 0; } };
const threads = (pid) => { try { return readdirSync(`/proc/${pid}/task`).length; } catch { return 0; } };
const groupOf = (name, pid) => pid === app.pid ? "trex" : name.startsWith("WebKitWeb") ? "webkit-web" : name.startsWith("WebKitNet") ? "webkit-net" : name === "trex" ? "trex" : name === "node" || name === "MainThread" ? "agente-falso" : "otros";

/** CPU por hilo (nombre del hilo) de un proceso: dice qué parte del motor trabaja. */
const threadTicks = (pid) => {
  const table = new Map();
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const s = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
        const name = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
        const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
        table.set(`${tid}`, { name, ticks: Number(f[11]) + Number(f[12]) });
      } catch { /* hilo terminado */ }
    }
  } catch { /* proceso terminado */ }
  return table;
};

async function measure(ms, inspector) {
  if (inspector) await inspector.evaluate("window.__perfInvokes = {}");
  const pids = processTree(app.pid);
  const before = new Map(pids.map(pid => [pid, ticks(pid)]));
  const threadsBefore = new Map(pids.map(pid => [pid, threadTicks(pid)]));
  // Caudal de la terminal: lo que escribe el productor (`yes`), frenado por el control de flujo.
  const producers = pids.filter(pid => comm(pid) === "yes");
  const writtenBefore = new Map(producers.map(pid => [pid, written(pid)]));
  const profiling = inspector && !process.env.BENCH_NO_PROFILE ? inspector.profile(ms) : null;
  await sleep(ms);
  const cpu = {}, memory = {}, threadCount = {}, byThread = {};
  for (const pid of pids) {
    const group = groupOf(comm(pid), pid);
    cpu[group] = (cpu[group] ?? 0) + (ticks(pid) - before.get(pid)) / (ms / 1000);
    memory[group] = (memory[group] ?? 0) + pss(pid) / 1024;
    threadCount[group] = (threadCount[group] ?? 0) + threads(pid);
    const old = threadsBefore.get(pid);
    for (const [tid, now] of threadTicks(pid)) {
      const spent = (now.ticks - (old.get(tid)?.ticks ?? 0)) / (ms / 1000);
      if (spent <= 0) continue;
      const key = `${group}/${now.name}`;
      byThread[key] = (byThread[key] ?? 0) + spent;
    }
  }
  const round = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, Number(v.toFixed(1))]));
  const hotThreads = Object.fromEntries(Object.entries(byThread).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, Number(v.toFixed(1))]));
  const throughput = producers.length ? producers.reduce((sum, pid) => sum + written(pid) - writtenBefore.get(pid), 0) / 1048576 / (ms / 1000) : null;
  return { cpuPercent: round(cpu), pssMB: round(memory), threads: threadCount, hotThreads, terminalMBps: throughput === null ? null : Number(throughput.toFixed(2)), webkit: profiling ? await profiling : null };
}

// --- Escenarios -----------------------------------------------------------------
const results = { binary: resolve(binary), date: new Date().toISOString(), windowMs: WINDOW_MS, scenarios: {} };
let inspector;
const want = (name) => !only || only.split(",").includes(name);
const composer = `document.querySelector('textarea[aria-label^="Mensaje para"]')`;
async function send(text) {
  await inspector.evaluate(`(() => {
    const field = ${composer};
    if (!field) throw new Error("sin compositor");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  await inspector.evaluate(`(() => { ${composer}.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })); return true; })()`);
}
const domCount = () => inspector.evaluate("document.getElementsByTagName('*').length");
const working = () => inspector.evaluate("!!document.querySelector('.chat-working')");
async function waitIdle(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(500);
  while (Date.now() < deadline && await working()) await sleep(300);
}
/** Cuenta las llamadas de la interfaz al backend (comando, veces y bytes enviados). */
const INVOKE_PROBE = `(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || internals.__perfWrapped) return;
  const original = internals.invoke.bind(internals);
  window.__perfInvokes = {};
  internals.invoke = (cmd, args, options) => {
    const entry = window.__perfInvokes[cmd] ??= { calls: 0, bytes: 0 };
    entry.calls += 1;
    if (cmd === "pty_ack") entry.acked = (entry.acked ?? 0) + (args?.bytes ?? 0);
    try { entry.bytes += args instanceof Uint8Array ? args.length : JSON.stringify(args ?? null).length; } catch {}
    return original(cmd, args, options);
  };
  internals.__perfWrapped = true;
})()`;
async function scenario(name, run) {
  if (!want(name)) return;
  process.stderr.write(`· ${name}\n`);
  const result = await run();
  result.invokes = await inspector.evaluate("(() => { const r = window.__perfInvokes; window.__perfInvokes = {}; return Object.fromEntries(Object.entries(r ?? {}).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)); })()");
  result.domNodes = await domCount();
  result.animations = await inspector.evaluate("document.getAnimations().filter(a => a.playState === 'running').map(a => (a.animationName || a.transitionProperty || a.constructor.name) + '@' + (a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '')).slice(0, 20)");
  results.scenarios[name] = result;
}

async function terminalBench() {
  // Pestaña de shell restaurada: se busca su PTY y se le escribe directamente.
  let id = null;
  for (let i = 0; i < 100 && !id; i++) {
    id = await inspector.evaluate("window.__TAURI_INTERNALS__.invoke('pty_list').then(list => list.find(s => s.alive)?.id ?? null)").catch(() => null);
    if (!id) await sleep(200);
  }
  if (!id) throw new Error("sin PTY");
  results.startupToComposerMs = Date.now() - started;
  await inspector.evaluate(INVOKE_PROBE);
  await inspector.evaluate("document.hasFocus = () => true; window.dispatchEvent(new Event('focus'))");
  await sleep(3000);
  if (process.env.BENCH_DEBUG) console.error("DEBUG", id, await inspector.evaluate("JSON.stringify({ xterm: document.querySelectorAll('.xterm').length, text: document.body.innerText.slice(0, 400) })"));
  const write = (text) => inspector.evaluate(`window.__TAURI_INTERNALS__.invoke('pty_write', { id: ${JSON.stringify(id)}, data: ${JSON.stringify(text)} })`);
  await scenario("terminal-reposo", () => measure(WINDOW_MS, inspector));
  await write("yes '\\033[32mok\\033[0m compilando módulo 1234 de 5678: src/components/chat/Markdown.tsx -> dist/assets/markdown.js'\r");
  await sleep(2000);
  await scenario("terminal-salida", async () => {
    const result = await measure(WINDOW_MS, inspector);
    return result;
  });
  await write("\u0003");
  await sleep(3000);
  await scenario("terminal-tras-salida", () => measure(WINDOW_MS, inspector));
}

try {
  inspector = await connect(await findTarget(`127.0.0.1:${PORT}`));
  if (process.env.BENCH_TERMINAL) { await terminalBench(); throw null; }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !(await inspector.evaluate(`!!${composer}`).catch(() => false))) await sleep(200);
  results.startupToComposerMs = Date.now() - started;
  await inspector.evaluate(INVOKE_PROBE);
  // Experimentos: CSS extra inyectado antes de medir (BENCH_INJECT_CSS=archivo).
  if (process.env.BENCH_INJECT_CSS) {
    const css = readFileSync(process.env.BENCH_INJECT_CSS, "utf8");
    await inspector.evaluate(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
  }
  // Ventana sin foco (como cuando se trabaja en otra aplicación con Trex a la vista).
  // Sin pantalla la ventana nunca tiene el foco: por defecto se simula que sí (el caso exigente).
  await inspector.evaluate(process.env.BENCH_BLUR ? "document.hasFocus = () => false; window.dispatchEvent(new Event('blur'))"
    : "document.hasFocus = () => true; window.dispatchEvent(new Event('focus'))");
  await sleep(4000);

  await scenario("reposo-chat-vacio", () => measure(WINDOW_MS, inspector));
  await scenario("trabajando-sin-texto", async () => { await send("Espera [wait 40]"); await sleep(3000); return measure(WINDOW_MS, inspector); });
  if (want("trabajando-sin-texto")) await waitIdle();
  await scenario("streaming", async () => { await send("Explica los cambios"); await sleep(4000); return measure(WINDOW_MS, inspector); });
  await waitIdle();
  await scenario("reposo-con-historial", async () => { await sleep(2000); return measure(WINDOW_MS, inspector); });
  await scenario("streaming-chat-largo", async () => {
    for (let i = 0; i < Number(process.env.BENCH_LONG_TURNS ?? 40); i++) { await send(`Turno ${i} [fast]`); await sleep(120); }
    await waitIdle();
    await sleep(2000);
    await send("Explica los cambios otra vez");
    await sleep(4000);
    return measure(WINDOW_MS, inspector);
  });
  await waitIdle();
  await scenario("reposo-chat-largo", async () => { await sleep(2000); return measure(WINDOW_MS, inspector); });
  // Memoria al final: lo que retiene el proceso web y lo que queda tras recoger basura.
  results.memoryEnd = await inspector.memory();
  results.memoryAfterGc = await inspector.memory({ gc: true });
  await sleep(2000);
  results.pssAfterGc = (await measure(1000, null)).pssMB;
  // Reparto real (no estimado) de la memoria del proceso web, por tipo de mapeo.
  const web = processTree(app.pid).find(pid => comm(pid).startsWith("WebKitWeb"));
  if (web) {
    const groups = {};
    let name = "";
    for (const line of readFileSync(`/proc/${web}/smaps`, "utf8").split("\n")) {
      const header = /^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*(.*)$/.exec(line);
      if (header) { const path = header[1].trim(); name = !path ? "anónima" : path.startsWith("/dev/dri") ? "gpu (dri)" : path.startsWith("memfd:") ? path.replace(/\s*\(deleted\)$/, "") : path.startsWith("[") ? path : path.endsWith(".so") || path.includes(".so.") ? "bibliotecas" : "archivos"; continue; }
      const pss = /^Pss:\s+(\d+)/.exec(line);
      if (pss) groups[name] = (groups[name] ?? 0) + Number(pss[1]) / 1024;
    }
    results.webSmaps = Object.fromEntries(Object.entries(groups).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number(v.toFixed(1))]));
  }
} catch (error) {
  if (error !== null) results.error = String(error?.stack ?? error);
} finally {
  inspector?.close();
  // Todo el árbol (agentes incluidos): un agente huérfano metería ruido en la siguiente medida.
  const tree = processTree(app.pid);
  app.kill("SIGTERM");
  for (const pid of tree.slice(1)) { try { process.kill(pid, "SIGTERM"); } catch { /* ya terminó */ } }
  await sleep(1500);
  try { process.kill(app.pid, "SIGKILL"); } catch { /* ya terminó */ }
  mutter.kill("SIGTERM");
  results.stderrTail = stderr.split("\n").filter(Boolean).slice(-15);
}

const json = JSON.stringify(results, null, 2);
if (output) writeFileSync(output, json);
for (const [name, scenarioResult] of Object.entries(results.scenarios)) {
  const w = scenarioResult.webkit ?? {};
  console.log(`\n## ${name}\n hilos calientes: ${JSON.stringify(scenarioResult.hotThreads)}\n CPU %: ${JSON.stringify(scenarioResult.cpuPercent)}\n PSS MB: ${JSON.stringify(scenarioResult.pssMB)}\n hilos: ${JSON.stringify(scenarioResult.threads)}  DOM: ${scenarioResult.domNodes}`);
  console.log(` invokes: ${JSON.stringify(scenarioResult.invokes)}`);
  if (scenarioResult.terminalMBps !== null && scenarioResult.terminalMBps !== undefined) {
    const total = Object.values(scenarioResult.cpuPercent).reduce((a, b) => a + b, 0);
    console.log(` caudal terminal: ${scenarioResult.terminalMBps} MB/s · CPU por MB/s: ${(total / Math.max(0.01, scenarioResult.terminalMBps)).toFixed(1)} %`);
  }
  console.log(` WebKit CPU: ${w.webProcessCpu?.toFixed?.(1)}  hilos: ${JSON.stringify(w.threads)}\n tiempo (ms): ${JSON.stringify(w.timeMs)}\n muestras JS: ${w.jsSamples}  animaciones: ${JSON.stringify(scenarioResult.animations)}`);
  for (const [fn, n] of (w.hotSelf ?? []).slice(0, 8)) console.log(`   ${String(n).padStart(5)}  ${fn}`);
}
if (results.memoryEnd) console.log(`\nMemoria WebKit (MB): ${JSON.stringify(results.memoryEnd)}\nTras GC: ${JSON.stringify(results.memoryAfterGc)}  PSS tras GC: ${JSON.stringify(results.pssAfterGc)}`);
if (results.webSmaps) console.log(`Proceso web por mapeo (MB PSS): ${JSON.stringify(results.webSmaps)}`);
if (results.startupToComposerMs) console.log(`\nArranque hasta el compositor: ${results.startupToComposerMs} ms`);
if (results.error) console.log(`\nERROR: ${results.error}`);
process.exit(0);
