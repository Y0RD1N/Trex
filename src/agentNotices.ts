import type { AgentActivity, AgentNoticeKind } from "./types";
import { activitySignal } from "./agentActivity";

/** Notificaciones de atención de la CLI, distintas del progreso y del prompt. */
export function noticeSignal(osc: number, data: string): AgentNoticeKind | undefined {
  if ((osc === 9 && data.trim() && !data.startsWith("4;")) || (osc === 777 && data.startsWith("notify;"))) {
    return activitySignal(osc, data) === "waiting" ? "attention" : "ready";
  }
  return undefined;
}

/** Una tarea puede pedir atención varias veces, pero termina una sola vez. */
export class AgentNoticeTracker {
  private worked = false;
  private completed = false;
  private waiting = false;

  begin(): void { this.worked = true; this.completed = false; this.waiting = false; }

  /** Un "terminó" que no llegó a publicarse: la tarea sigue abierta. */
  resume(): void { this.worked = true; this.completed = false; }

  transition(next: AgentActivity): AgentNoticeKind | undefined {
    if (next === "working") { this.begin(); return undefined; }
    if (!this.worked) return undefined;
    return this.signal(next === "waiting" ? "attention" : "ready");
  }

  signal(kind: AgentNoticeKind): AgentNoticeKind | undefined {
    if (kind === "attention") {
      if (this.waiting) return undefined;
      this.completed = false;
      this.waiting = true;
      return kind;
    }
    if (this.completed) return undefined;
    this.completed = true;
    this.worked = false;
    this.waiting = false;
    return kind;
  }

  exit(code: number | null): AgentNoticeKind | undefined {
    return this.worked ? this.signal(code === 0 ? "ready" : "error") : undefined;
  }

  reset(): void { this.worked = this.completed = this.waiting = false; }
}

/** Cuánto debe llevar quieto el agente para anunciar que terminó la tarea. */
export const READY_QUIET_MS = 5000;
/** Una petición de respuesta debe mantenerse este tiempo para avisar. */
export const ATTENTION_QUIET_MS = 1200;
/** Una tarea más corta que esto es un parpadeo del detector, no trabajo real. */
export const MIN_WORK_MS = 1500;

type Clock = {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const systemClock: Clock = {
  now: () => performance.now(),
  set: (callback, ms) => globalThis.setTimeout(callback, ms),
  clear: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Confirma los avisos deducidos de la pantalla antes de publicarlos.
 *
 * El detector de actividad lee el pie de la TUI, y ese indicador "trabajando"
 * se apaga unos instantes entre pasos de una misma tarea (esperando una
 * herramienta, repintando la pantalla…). Cada apagón parecía una tarea
 * terminada y el aviso sonaba una y otra vez. Aquí un "terminó" solo se publica
 * si el agente se queda quieto `READY_QUIET_MS`: cualquier señal de trabajo en
 * ese intervalo lo cancela y la cuenta empieza de nuevo. Las notificaciones
 * explícitas del propio agente y la salida del proceso no esperan.
 */
export class NoticeScheduler {
  private handle: unknown = null;
  private pending: AgentNoticeKind | null = null;
  /** Inicio de la tarea en curso; se conserva entre pausas hasta publicar o descartar. */
  private workStart: number | null = null;

  constructor(
    private readonly emit: (kind: AgentNoticeKind) => void,
    private readonly clock: Clock = systemClock,
  ) {}

  /** El agente trabaja: lo pendiente deja de valer y se cuenta el trabajo. */
  working(): void {
    this.cancel();
    this.workStart ??= this.clock.now();
  }

  /** Aviso deducido de la pantalla: se publica si nada cambia durante la espera. */
  propose(kind: AgentNoticeKind): void {
    this.cancel();
    if (kind === "ready") {
      const worked = this.workStart === null ? 0 : this.clock.now() - this.workStart;
      if (worked < MIN_WORK_MS) { this.workStart = null; return; }
    }
    this.pending = kind;
    this.handle = this.clock.set(() => this.publish(kind), kind === "ready" ? READY_QUIET_MS : ATTENTION_QUIET_MS);
  }

  /** Aviso fiable (notificación del agente, fallo del proceso): sin espera. */
  emitNow(kind: AgentNoticeKind): void {
    this.cancel();
    this.publish(kind);
  }

  /** El proceso terminó: lo que estuviera esperando se publica ya. */
  flush(): void {
    const kind = this.pending;
    this.cancel();
    if (kind) this.publish(kind);
  }

  /** Descarta lo pendiente (cambió el estado del agente) y devuelve qué era. */
  cancel(): AgentNoticeKind | null {
    const kind = this.pending;
    if (this.handle !== null) this.clock.clear(this.handle);
    this.handle = null;
    this.pending = null;
    return kind;
  }

  /** Sesión cerrada o reiniciada: ni aviso pendiente ni tarea en curso. */
  reset(): void {
    this.cancel();
    this.workStart = null;
  }

  private publish(kind: AgentNoticeKind): void {
    this.handle = null;
    this.pending = null;
    if (kind === "ready" || kind === "error") this.workStart = null;
    this.emit(kind);
  }
}

export const noticeLabel = (kind: AgentNoticeKind): string =>
  kind === "ready" ? "Tarea terminada" : kind === "attention" ? "Necesita tu respuesta" : "El proceso se interrumpió";
