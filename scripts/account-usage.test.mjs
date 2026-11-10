import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

// Almacenamiento del navegador simulado: el almacén guarda ahí el último dato.
const saved = new Map();
globalThis.localStorage = {
  getItem: key => saved.has(key) ? saved.get(key) : null,
  setItem: (key, value) => { saved.set(key, String(value)); },
  removeItem: key => { saved.delete(key); },
};
const HOUR = 3_600_000;
const profile = (id, provider = "claude", command = id) => ({ id, name: id, provider, command, args: "", shell: "", launchMode: "chat", configDir: "" });
// Un dato guardado antes de abrir la app se ve al momento.
const stored = profile("guardada");
const { usageKey: keyOf } = await load("accountUsageStore");
saved.set("trex.account-usage", JSON.stringify({
  [keyOf(stored)]: { at: Date.now() - 20 * 60_000, usage: { plan: "Max", windows: [{ id: "session", label: "Sesión (5 h)", percent: 40, resetsAt: null, severity: "normal", headline: true }], extra: null, resetCredits: 0 } },
  "claude:viejo": { at: Date.now() - 30 * 24 * HOUR, usage: null },
}));

const { parseClaudeUsage, windowPace, currentPercent, parseCodexUsage } = await load("planUsage");
const store = await load("accountUsageStore");

test("el límite semanal de un modelo se nombra con el modelo", () => {
  const usage = parseClaudeUsage({ rate_limits: { limits: [
    { kind: "weekly_all", group: "weekly", percent: 51, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 25, scope: { model: { display_name: "Fable", id: null }, surface: null } },
  ] } });
  assert.deepEqual(usage.windows.map(window => window.label), ["Semana", "Semana · Fable"]);
  assert.notEqual(usage.windows[0].id, usage.windows[1].id);
});

test("cada ventana sabe lo que dura, y con eso el ritmo de gasto", () => {
  const now = Date.UTC(2026, 10, 10, 18);
  const claude = parseClaudeUsage({ rate_limits: { limits: [
    { kind: "session", group: "session", percent: 3, resets_at: new Date(now + 4.75 * HOUR).toISOString() },
    { kind: "weekly_all", group: "weekly", percent: 51, resets_at: new Date(now + 77 * HOUR).toISOString() },
  ] } });
  assert.deepEqual(claude.windows.map(window => window.durationMs), [5 * HOUR, 168 * HOUR]);
  // Pronto para juzgar: solo la marca de tiempo.
  assert.deepEqual(windowPace(claude.windows[0], now), { elapsed: 5, tone: null });
  // 51 % usado con el 54 % de la semana pasado: va justo.
  assert.deepEqual(windowPace(claude.windows[1], now), { elapsed: 54, tone: "even" });
  const codex = parseCodexUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: (now + 20 * HOUR) / 1000 } } });
  assert.equal(windowPace(codex.windows[0], now).tone, "easy");
  const fast = { ...codex.windows[0], percent: 95 };
  assert.equal(windowPace(fast, now).tone, "fast");
});

test("una ventana que ya se reinició deja de contar lo guardado", () => {
  const window = { id: "session", label: "Sesión (5 h)", percent: 80, resetsAt: 1_000, severity: "warning", headline: true, durationMs: 5 * HOUR };
  assert.equal(currentPercent(window, 2_000), 0);
  assert.equal(windowPace(window, 2_000), null);
  assert.equal(currentPercent(window, 500), 80);
});

test("el último dato guardado se ve al abrir, y los muy antiguos se descartan", () => {
  const reading = store.usageReading(stored);
  assert.equal(reading.usage.plan, "Max");
  assert.equal(reading.loading, false);
  assert.ok(reading.at < Date.now() - 19 * 60_000);
});

test("lo que informa un chat abierto actualiza la cuenta sin perder sus otras ventanas", async () => {
  const account = profile("claude2");
  const full = parseClaudeUsage({ subscription_type: "pro", rate_limits: { limits: [
    { kind: "session", group: "session", percent: 3 },
    { kind: "weekly_all", group: "weekly", percent: 51 },
    { kind: "weekly_scoped", group: "weekly", percent: 25, scope: { model: { display_name: "Fable" } } },
  ] } });
  store.reportLiveUsage(account, full);
  const live = { plan: null, windows: [{ id: "session", label: "Sesión (5 h)", percent: 9, resetsAt: null, severity: "normal", headline: false }], extra: null, resetCredits: 0 };
  store.reportLiveUsage(account, live);
  const usage = store.usageReading(account).usage;
  assert.equal(usage.plan, "Pro");
  assert.deepEqual(usage.windows.map(window => [window.label, window.percent]), [["Sesión (5 h)", 9], ["Semana", 51], ["Semana · Fable", 25]]);
  // Reciente: no se arranca ningún CLI para releerla (aquí fallaría al intentarlo).
  assert.equal(await store.refreshAccount(account, { maxAge: 60_000 }), usage);
  assert.equal(store.usageReading(account).loading, false);
  // Y queda guardado para la próxima vez.
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(JSON.parse(saved.get("trex.account-usage"))[store.usageKey(account)]);
  assert.equal(JSON.parse(saved.get("trex.account-usage"))["claude:viejo"], undefined);
});

test("la cuenta más cargada sale de su ventana más alta", () => {
  const codex = profile("codex", "codex");
  store.reportLiveUsage(codex, { plan: "Pro Lite", windows: [
    { id: "codex:primary", label: "Semana", percent: 36, resetsAt: null, severity: "normal", headline: true },
  ], extra: null, resetCredits: 2 });
  const peaks = store.accountPeaks([profile("claude2"), codex, profile("sin-datos")], Date.now());
  assert.deepEqual(peaks.map(peak => [peak.profile.id, peak.percent, peak.window.label]), [["claude2", 51, "Semana"], ["codex", 36, "Semana"]]);
});

test("las cuentas de Trex no se leen y sin contexto no se lanza nada", async () => {
  assert.equal(await store.refreshAccount(profile("trex", "trex")), null);
  const never = profile("nunca-leida");
  assert.equal(await store.refreshAccount(never), null);
  assert.equal(store.usageReading(never).loading, false);
});

test("pedir la pestaña «Uso» la abre primero el chat con el foco", () => {
  const opened = [];
  const stopVisible = store.onUsagePanelRequest(focusedOnly => focusedOnly ? false : (opened.push("visible"), true));
  const stopFocused = store.onUsagePanelRequest(focusedOnly => (opened.push(focusedOnly ? "foco" : "otro"), true));
  assert.equal(store.requestUsagePanel(), true);
  assert.deepEqual(opened, ["foco"]);
  stopFocused(); stopVisible();
  assert.equal(store.requestUsagePanel(), false);
});
