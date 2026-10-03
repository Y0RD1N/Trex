import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const activity = url(compile(await readFile(new URL("../src/agentActivity.ts", import.meta.url), "utf8")));
const notices = compile(await readFile(new URL("../src/agentNotices.ts", import.meta.url), "utf8")).replace('"./agentActivity"', JSON.stringify(activity));
const { AgentNoticeTracker, NoticeScheduler, noticeSignal, READY_QUIET_MS, ATTENTION_QUIET_MS, MIN_WORK_MS } = await import(url(notices));

test("arrancar, permanecer en reposo y volver al prompt no produce avisos", () => {
  const tracker = new AgentNoticeTracker();
  assert.equal(tracker.transition("idle"), undefined);
  assert.equal(tracker.exit(0), undefined);
  for (const marker of ["A", "B", "D;0"]) assert.equal(noticeSignal(133, marker), undefined);
  for (const progress of ["4;0", "4;1;50", "4;3"]) assert.equal(noticeSignal(9, progress), undefined);
});

test("una tarea finalizada avisa una vez aunque lleguen varias señales", () => {
  const tracker = new AgentNoticeTracker();
  tracker.transition("working");
  assert.equal(tracker.transition("idle"), "ready");
  assert.equal(tracker.signal("ready"), undefined);
  assert.equal(tracker.transition("idle"), undefined);
  assert.equal(tracker.exit(0), undefined);
  tracker.transition("working");
  assert.equal(tracker.signal("ready"), "ready");
  assert.equal(tracker.transition("idle"), undefined);
});

test("una confirmación pide atención y no se anuncia como tarea terminada", () => {
  const tracker = new AgentNoticeTracker();
  tracker.transition("working");
  assert.equal(tracker.transition("waiting"), "attention");
  assert.equal(tracker.signal("attention"), undefined);
  tracker.transition("working");
  assert.equal(tracker.transition("waiting"), "attention");
  tracker.transition("working");
  assert.equal(tracker.transition("idle"), "ready");
});

test("cerrar, reiniciar o limpiar una sesión no produce una falsa finalización", () => {
  const tracker = new AgentNoticeTracker();
  tracker.transition("working");
  tracker.reset();
  assert.equal(tracker.transition("idle"), undefined);
  assert.equal(tracker.exit(0), undefined);
  tracker.transition("working");
  assert.equal(tracker.transition("idle"), "ready");
});

test("salir durante una tarea diferencia finalización e interrupción", () => {
  const completed = new AgentNoticeTracker();
  completed.transition("working");
  assert.equal(completed.exit(0), "ready");
  assert.equal(completed.exit(0), undefined);
  const failed = new AgentNoticeTracker();
  failed.transition("working");
  assert.equal(failed.exit(1), "error");
  assert.equal(failed.transition("idle"), undefined);
});

test("las notificaciones explícitas cubren tareas breves y nuevas confirmaciones", () => {
  const tracker = new AgentNoticeTracker();
  assert.equal(noticeSignal(9, "Codex task complete"), "ready");
  assert.equal(noticeSignal(777, "notify;Claude Code;Waiting for approval"), "attention");
  assert.equal(noticeSignal(777, "notify;Claude Code;Task complete"), "ready");
  assert.equal(noticeSignal(777, "unrelated"), undefined);
  assert.equal(tracker.signal("ready"), "ready");
  assert.equal(tracker.signal("ready"), undefined);
  assert.equal(tracker.signal("attention"), "attention");
  assert.equal(tracker.signal("ready"), "ready");
});

/** Reloj manual: `advance(ms)` dispara los temporizadores vencidos en orden. */
const fakeClock = () => {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    set: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; },
    clear: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
};

/** Conecta tracker y scheduler igual que TerminalView al cambiar la actividad. */
const rig = () => {
  const clock = fakeClock();
  const emitted = [];
  const scheduler = new NoticeScheduler(kind => emitted.push(kind), clock);
  const tracker = new AgentNoticeTracker();
  const drive = next => {
    if (next === "working") scheduler.working();
    else if (scheduler.cancel() === "ready") tracker.resume();
    const notice = tracker.transition(next);
    if (notice) scheduler.propose(notice);
  };
  return { clock, emitted, scheduler, tracker, drive };
};

test("las pausas breves de una tarea larga no producen avisos intermedios", () => {
  const { clock, emitted, drive } = rig();
  drive("working"); clock.advance(3000);
  drive("idle"); clock.advance(900);
  drive("working"); clock.advance(2000);
  drive("idle"); clock.advance(READY_QUIET_MS - 1);
  drive("working"); clock.advance(5000);
  drive("idle");
  clock.advance(READY_QUIET_MS - 1);
  assert.deepEqual(emitted, []);
  clock.advance(1);
  assert.deepEqual(emitted, ["ready"]);
  clock.advance(120000);
  assert.deepEqual(emitted, ["ready"]);
});

test("la tarea termina aunque su última racha de trabajo sea muy corta", () => {
  const { clock, emitted, drive } = rig();
  drive("working"); clock.advance(10000);
  drive("idle"); clock.advance(400);
  drive("working"); clock.advance(300);
  drive("idle");
  clock.advance(READY_QUIET_MS);
  assert.deepEqual(emitted, ["ready"]);
});

test("un parpadeo del detector no cuenta como tarea", () => {
  const { clock, emitted, drive } = rig();
  drive("working"); clock.advance(MIN_WORK_MS - 1);
  drive("idle");
  clock.advance(READY_QUIET_MS * 3);
  assert.deepEqual(emitted, []);
  drive("working"); clock.advance(MIN_WORK_MS);
  drive("idle"); clock.advance(READY_QUIET_MS);
  assert.deepEqual(emitted, ["ready"]);
});

test("pedir respuesta solo avisa si la petición se mantiene", () => {
  const { clock, emitted, drive } = rig();
  drive("working"); clock.advance(3000);
  drive("waiting"); clock.advance(ATTENTION_QUIET_MS - 1);
  drive("working"); clock.advance(10000);
  assert.deepEqual(emitted, []);
  drive("waiting"); clock.advance(ATTENTION_QUIET_MS);
  assert.deepEqual(emitted, ["attention"]);
});

test("una petición de respuesta cancela la finalización pendiente", () => {
  const { clock, emitted, drive } = rig();
  drive("working"); clock.advance(4000);
  drive("idle"); clock.advance(READY_QUIET_MS - 500);
  drive("waiting"); clock.advance(ATTENTION_QUIET_MS);
  assert.deepEqual(emitted, ["attention"]);
  clock.advance(READY_QUIET_MS * 2);
  assert.deepEqual(emitted, ["attention"]);
});

test("las notificaciones explícitas del agente avisan al instante", () => {
  const { clock, emitted, scheduler, drive } = rig();
  drive("working"); clock.advance(4000);
  drive("idle");
  scheduler.emitNow("ready");
  assert.deepEqual(emitted, ["ready"]);
  clock.advance(READY_QUIET_MS * 2);
  assert.deepEqual(emitted, ["ready"]);
});

test("al salir el proceso se anuncia ya lo que estaba pendiente, una sola vez", () => {
  const { clock, emitted, scheduler, drive } = rig();
  drive("working"); clock.advance(4000);
  drive("idle"); clock.advance(500);
  scheduler.flush();
  assert.deepEqual(emitted, ["ready"]);
  scheduler.flush();
  clock.advance(READY_QUIET_MS * 2);
  assert.deepEqual(emitted, ["ready"]);
});

test("cerrar o reiniciar la sesión descarta los avisos pendientes", () => {
  const { clock, emitted, scheduler, tracker, drive } = rig();
  drive("working"); clock.advance(4000);
  drive("idle");
  scheduler.reset(); tracker.reset();
  clock.advance(READY_QUIET_MS * 2);
  assert.deepEqual(emitted, []);
  drive("idle"); clock.advance(READY_QUIET_MS * 2);
  assert.deepEqual(emitted, []);
});
