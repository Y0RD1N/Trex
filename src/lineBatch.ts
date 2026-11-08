/**
 * Agrupa los eventos que llegan de los asistentes en tandas.
 *
 * Con `--include-partial-messages` un asistente escribe una línea por fragmento de texto, y cada
 * línea llegaba a React como una actualización propia. En un chat eso es una renderización por
 * fragmento; en un equipo, además, cada una recomponía el hilo mezclado de todos los miembros
 * (coste proporcional al historial total), de modo que varios agentes escribiendo a la vez
 * saturaban el hilo principal y la ventana dejaba de responder.
 *
 * Todas las sesiones comparten un único temporizador: al dispararse, vacía las colas de todas en la
 * misma tarea y React las agrupa en una sola renderización. La primera línea tras un rato en silencio
 * se procesa sin esperar, y con la ventana oculta no se retrasa nada (los temporizadores se frenan).
 */
export const BATCH_MS = 50;

export type BatchEnvironment = {
  now: () => number;
  hidden: () => boolean;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Un fallo en un manejador no debe impedir que se procesen los demás. */
  onError: (error: unknown) => void;
};

export type BatchScheduler = {
  /** Programa la tarea para la próxima tanda; la misma función no se duplica. */
  schedule: (job: () => void) => void;
  /** Ejecuta ya todo lo pendiente. */
  flush: () => void;
  cancel: (job: () => void) => void;
  readonly pending: number;
};

export function createBatchScheduler(env: BatchEnvironment, interval = BATCH_MS): BatchScheduler {
  const jobs = new Set<() => void>();
  let timer: unknown = null;
  let last = Number.NEGATIVE_INFINITY;
  const run = (): void => {
    if (timer !== null) { env.clearTimer(timer); timer = null; }
    last = env.now();
    const batch = [...jobs];
    jobs.clear();
    for (const job of batch) {
      try { job(); } catch (error) { env.onError(error); }
    }
  };
  return {
    schedule(job) {
      jobs.add(job);
      if (env.hidden()) { run(); return; }
      if (timer !== null) return;
      const wait = interval - (env.now() - last);
      if (wait <= 0) run();
      else timer = env.setTimer(() => { timer = null; run(); }, wait);
    },
    flush() { if (jobs.size) run(); },
    cancel(job) { jobs.delete(job); },
    get pending() { return jobs.size; },
  };
}

export type OrderedQueue<T> = {
  push: (item: T) => void;
  /** Procesa ya lo acumulado, en orden (p. ej. al salir el proceso). */
  drainNow: () => void;
  clear: () => void;
};

/**
 * Cola de una sesión: conserva el orden entre tipos de evento y descarta lo que quede cuando la
 * sesión deja de estar vigente (`alive`), como hacía la entrega directa.
 */
export function createOrderedQueue<T>(scheduler: BatchScheduler, handle: (item: T) => void, alive: () => boolean, onError: (error: unknown) => void): OrderedQueue<T> {
  const items: T[] = [];
  const drain = (): void => {
    const batch = items.splice(0);
    for (const item of batch) {
      if (!alive()) return;
      try { handle(item); } catch (error) { onError(error); }
    }
  };
  return {
    push(item) {
      if (!alive()) return;
      items.push(item);
      scheduler.schedule(drain);
    },
    drainNow() { scheduler.cancel(drain); drain(); },
    clear() { items.length = 0; scheduler.cancel(drain); },
  };
}
