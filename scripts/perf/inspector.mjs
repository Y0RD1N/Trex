/**
 * Cliente mínimo del protocolo del Web Inspector de WebKit (WebKitGTK), a través del
 * servidor que abre `WEBKIT_INSPECTOR_HTTP_SERVER=host:puerto` en un binario compilado con
 * `--features tauri/devtools`.
 *
 * Da acceso a lo mismo que usa el inspector de Safari/Epiphany: evaluar JS en la página,
 * línea de tiempo (estilo, layout, pintado, temporizadores...), muestreo de JS y uso de CPU
 * por hilo del proceso web.
 */

export async function findTarget(host, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const html = await (await fetch(`http://${host}/`)).text();
      const match = /socket\/(\d+)\/(\d+)\/WebPage/.exec(html);
      if (match) return `ws://${host}/socket/${match[1]}/${match[2]}/WebPage`;
    } catch { /* todavía arrancando */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`No hay ninguna página inspeccionable en ${host}`);
}

export async function connect(url) {
  const ws = new WebSocket(url);
  let outer = 0, inner = 0, target = null;
  const pending = new Map();
  const listeners = new Map();
  let targetReady;
  const ready = new Promise(resolve => { targetReady = resolve; });
  ws.onmessage = (raw) => {
    const message = JSON.parse(String(raw.data));
    if (message.method === "Target.targetCreated") { target = message.params.targetInfo.targetId; targetReady(); return; }
    if (message.method !== "Target.dispatchMessageFromTarget") return;
    const event = JSON.parse(message.params.message);
    if (event.id !== undefined) {
      const waiter = pending.get(event.id);
      pending.delete(event.id);
      if (waiter) event.error ? waiter.reject(new Error(`${waiter.method}: ${event.error.message}`)) : waiter.resolve(event.result);
      return;
    }
    for (const listener of listeners.get(event.method) ?? []) listener(event.params);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await ready;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++inner;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id: ++outer, method: "Target.sendMessageToTarget", params: { targetId: target, message: JSON.stringify({ id, method, params }) } }));
  });
  const on = (method, listener) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(listener);
    return () => listeners.get(method).delete(listener);
  };
  // El cronómetro de las marcas de tiempo solo corre con el depurador activado.
  for (const domain of ["Inspector", "Runtime", "Page", "Debugger", "Console"]) await send(`${domain}.enable`).catch(() => {});
  await send("Inspector.initialized").catch(() => {});
  await send("Debugger.setBreakpointsActive", { active: false }).catch(() => {});

  /** Evalúa en la página y devuelve el valor; si es una promesa, espera a que se resuelva. */
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: false });
    if (result.wasThrown) throw new Error(`evaluate: ${JSON.stringify(result.result)}`);
    const value = result.result ?? {};
    if (!value.objectId) return value.value;
    if (value.className === "Promise") {
      // WebKit no admite `awaitPromise` en Runtime.evaluate: se espera aparte.
      const settled = await send("Runtime.awaitPromise", { promiseObjectId: value.objectId, returnByValue: true });
      if (settled.wasThrown) throw new Error(`evaluate: ${JSON.stringify(settled.result)}`);
      return settled.result?.value;
    }
    const plain = await send("Runtime.callFunctionOn", { objectId: value.objectId, functionDeclaration: "function () { return this; }", returnByValue: true });
    return plain.result?.value;
  };

  /** Graba `ms` milisegundos y resume dónde se fue el tiempo del proceso web. */
  const profile = async (ms) => {
    const records = [], samples = [], cpu = [];
    const offs = [
      on("Timeline.eventRecorded", params => records.push(params.record)),
      on("ScriptProfiler.trackingComplete", params => samples.push(...(params.samples?.stackTraces ?? []))),
      on("CPUProfiler.trackingUpdate", params => cpu.push(params.event)),
    ];
    const stopped = new Promise(resolve => { const off = on("Timeline.recordingStopped", () => { off(); resolve(); }); });
    const scriptDone = new Promise(resolve => { const off = on("ScriptProfiler.trackingComplete", () => { off(); resolve(); }); });
    await send("Timeline.setInstruments", { instruments: ["Timeline"] });
    await send("ScriptProfiler.startTracking", { includeSamples: true });
    await send("CPUProfiler.startTracking").catch(() => {});
    await send("Timeline.start", { maxCallStackDepth: 5 });
    await new Promise(resolve => setTimeout(resolve, ms));
    await send("Timeline.stop");
    await send("CPUProfiler.stopTracking").catch(() => {});
    await send("ScriptProfiler.stopTracking");
    await Promise.race([Promise.all([stopped, scriptDone]), new Promise(resolve => setTimeout(resolve, 5000))]);
    offs.forEach(off => off());
    return summarize(records, samples, cpu, ms);
  };

  /** Reparto de la memoria del proceso web según WebKit (MB por categoría: javascript, jit, layers...). */
  const memory = async ({ gc = false } = {}) => {
    if (gc) await send("Heap.gc").catch(() => {});
    const update = new Promise(resolve => {
      const off = on("Memory.trackingUpdate", params => { off(); resolve(params.event); });
      setTimeout(() => { off(); resolve(null); }, 3000);
    });
    await send("Memory.startTracking").catch(() => {});
    const event = await update;
    await send("Memory.stopTracking").catch(() => {});
    if (!event) return null;
    return Object.fromEntries((event.categories ?? []).map(category => [category.type, Number((category.size / 1048576).toFixed(1))]));
  };

  return { send, on, evaluate, profile, memory, close: () => ws.close() };
}

function summarize(records, samples, cpu, ms) {
  // Tiempo propio por tipo de registro (descontando hijos) para no contar dos veces.
  const byType = {};
  const counts = {};
  const walk = (record) => {
    const duration = Math.max(0, (record.endTime ?? record.startTime) - record.startTime) * 1000;
    const children = record.children ?? [];
    const childTime = children.reduce((sum, child) => sum + Math.max(0, ((child.endTime ?? child.startTime) - child.startTime) * 1000), 0);
    byType[record.type] = (byType[record.type] ?? 0) + Math.max(0, duration - childTime);
    counts[record.type] = (counts[record.type] ?? 0) + 1;
    children.forEach(walk);
  };
  records.forEach(walk);
  // Quién invalida estilo y layout: la cima de la pila de JS que lo provocó.
  const invalidators = {};
  const collect = (record) => {
    if (["ScheduleStyleRecalculation", "InvalidateLayout", "ScheduleLayout"].includes(record.type)) {
      const frames = record.stackTrace?.callFrames ?? [];
      const where = frames.slice(0, 3).map(f => `${f.functionName || "(anónima)"}:${String(f.url ?? "").replace(/^.*\//, "")}:${f.lineNumber ?? 0}`).join(" ← ") || "(sin JS: animación o motor)";
      const key = `${record.type} ${where}`;
      invalidators[key] = (invalidators[key] ?? 0) + 1;
    }
    (record.children ?? []).forEach(collect);
  };
  records.forEach(collect);
  // Funciones con más muestras: propias (cima de la pila) y totales (en cualquier punto de la pila).
  const self = {}, total = {};
  const frameName = (frame) => `${frame.name || "(anónima)"} ${String(frame.url ?? "").replace(/^.*\//, "")}:${frame.line ?? 0}`;
  for (const trace of samples) {
    const frames = trace.stackFrames ?? [];
    if (!frames.length) continue;
    const top = frameName(frames[0]);
    self[top] = (self[top] ?? 0) + 1;
    for (const name of new Set(frames.map(frameName))) total[name] = (total[name] ?? 0) + 1;
  }
  const top = (table, count = 15) => Object.entries(table).sort((a, b) => b[1] - a[1]).slice(0, count);
  // Para las funciones más calientes, quién las llama (pila resumida de 4 niveles).
  const callers = {};
  const hottest = new Set(top(self, 6).map(([name]) => name));
  for (const trace of samples) {
    const frames = trace.stackFrames ?? [];
    if (!frames.length || !hottest.has(frameName(frames[0]))) continue;
    const chain = frames.slice(0, 5).map(frameName).join(" ← ");
    callers[chain] = (callers[chain] ?? 0) + 1;
  }
  const threads = {};
  for (const event of cpu) for (const thread of event.threads ?? []) {
    const key = thread.type === "main" ? "main" : thread.name;
    threads[key] = (threads[key] ?? 0) + (thread.usage ?? 0) / Math.max(1, cpu.length);
  }
  const usage = cpu.length ? cpu.reduce((sum, event) => sum + (event.usage ?? 0), 0) / cpu.length : null;
  return {
    windowMs: ms,
    webProcessCpu: usage,
    threads: Object.fromEntries(Object.entries(threads).filter(([, value]) => value >= 0.05).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number(v.toFixed(2))])),
    timeMs: Object.fromEntries(Object.entries(byType).filter(([, value]) => value >= 0.5).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number(v.toFixed(1))])),
    counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    jsSamples: samples.length,
    hotSelf: top(self),
    hotTotal: top(total, 40),
    callers: top(callers, 25),
    invalidators: top(invalidators, 20),
  };
}
