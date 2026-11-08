import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { createBatchScheduler, createOrderedQueue, BATCH_MS } = await load("lineBatch");

/** Reloj y temporizadores falsos: las pruebas avanzan el tiempo a mano. */
function environment({ hidden = false } = {}) {
  const state = { time: 1000, hidden, timers: new Map(), next: 1, errors: [] };
  const env = {
    now: () => state.time,
    hidden: () => state.hidden,
    setTimer: (callback, ms) => { const id = state.next++; state.timers.set(id, { callback, at: state.time + ms }); return id; },
    clearTimer: id => { state.timers.delete(id); },
    onError: error => state.errors.push(error),
  };
  const advance = ms => {
    const target = state.time + ms;
    for (;;) {
      const due = [...state.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      state.time = due[1].at; state.timers.delete(due[0]); due[1].callback();
    }
    state.time = target;
  };
  return { state, env, advance };
}

test("la primera línea tras un silencio se procesa al momento y las siguientes se agrupan", () => {
  const { env, advance, state } = environment();
  const scheduler = createBatchScheduler(env);
  const seen = [];
  const queue = createOrderedQueue(scheduler, item => seen.push(item), () => true, env.onError);
  queue.push("a");
  assert.deepEqual(seen, ["a"], "sin espera tras el silencio");
  queue.push("b"); queue.push("c");
  assert.deepEqual(seen, ["a"], "dentro del intervalo se acumula");
  assert.equal(state.timers.size, 1, "un único temporizador");
  advance(BATCH_MS);
  assert.deepEqual(seen, ["a", "b", "c"], "se entregan juntas y en orden");
});

test("varias sesiones comparten un temporizador y se vacían en la misma tarea", () => {
  const { env, advance, state } = environment();
  const scheduler = createBatchScheduler(env);
  const order = [];
  const one = createOrderedQueue(scheduler, item => order.push(`1:${item}`), () => true, env.onError);
  const two = createOrderedQueue(scheduler, item => order.push(`2:${item}`), () => true, env.onError);
  one.push("x"); // inmediata (silencio previo)
  two.push("y"); one.push("z"); two.push("w");
  assert.equal(state.timers.size, 1, "un solo temporizador para las dos");
  assert.equal(order.length, 1);
  advance(BATCH_MS);
  assert.deepEqual(order.slice(1).sort(), ["1:z", "2:w", "2:y"]);
});

test("con la ventana oculta no se retrasa nada", () => {
  const { env, state } = environment({ hidden: true });
  const scheduler = createBatchScheduler(env);
  const seen = [];
  const queue = createOrderedQueue(scheduler, item => seen.push(item), () => true, env.onError);
  queue.push(1); queue.push(2); queue.push(3);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(state.timers.size, 0);
});

test("la salida del proceso conserva el orden respecto a las líneas pendientes", () => {
  const { env } = environment();
  const scheduler = createBatchScheduler(env);
  const seen = [];
  const queue = createOrderedQueue(scheduler, item => seen.push(item), () => true, env.onError);
  queue.push("line-1"); // inmediata
  queue.push("line-2"); queue.push("stderr-1");
  queue.push("exit"); queue.drainNow();
  assert.deepEqual(seen, ["line-1", "line-2", "stderr-1", "exit"]);
  assert.equal(scheduler.pending, 0);
});

test("lo que llega de un proceso que ya no es el vigente se descarta", () => {
  const { env, advance } = environment();
  const scheduler = createBatchScheduler(env);
  let current = true;
  const seen = [];
  const queue = createOrderedQueue(scheduler, item => seen.push(item), () => current, env.onError);
  queue.push("a");
  queue.push("b"); queue.push("c");
  current = false;
  advance(BATCH_MS * 2);
  assert.deepEqual(seen, ["a"], "b y c no se entregan al proceso sustituido");
  queue.push("d");
  assert.deepEqual(seen, ["a"]);
});

test("un manejador que falla no impide procesar el resto", () => {
  const { env, advance, state } = environment();
  const scheduler = createBatchScheduler(env);
  const seen = [];
  const queue = createOrderedQueue(scheduler, item => { if (item === "boom") throw new Error("x"); seen.push(item); }, () => true, env.onError);
  queue.push("a");
  queue.push("boom"); queue.push("c");
  advance(BATCH_MS);
  assert.deepEqual(seen, ["a", "c"]);
  assert.equal(state.errors.length, 1);
});

test("flush ejecuta lo pendiente sin esperar al temporizador", () => {
  const { env, state } = environment();
  const scheduler = createBatchScheduler(env);
  const seen = [];
  const queue = createOrderedQueue(scheduler, item => seen.push(item), () => true, env.onError);
  queue.push("a"); queue.push("b");
  scheduler.flush();
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(state.timers.size, 0);
});

test("a ritmo sostenido se procesa una tanda por intervalo, no una por línea", () => {
  const { env, advance } = environment();
  const scheduler = createBatchScheduler(env);
  let batches = 0, lines = 0;
  const queue = createOrderedQueue(scheduler, () => { lines++; }, () => true, env.onError);
  // Cuenta las tandas con una tarea propia que se agrega junto a la cola.
  const counter = () => { batches++; };
  for (let ms = 0; ms < 1000; ms += 5) { queue.push(ms); scheduler.schedule(counter); advance(5); }
  advance(BATCH_MS);
  assert.equal(lines, 200, "no se pierde ninguna línea");
  assert.ok(batches <= 1000 / BATCH_MS + 2, `tandas: ${batches}`);
});
