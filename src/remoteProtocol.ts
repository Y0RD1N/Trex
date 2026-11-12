/**
 * Lo que ve la app móvil de cada sesión (control remoto).
 *
 * El escritorio es la fuente de verdad: aquí se traduce el estado de un chat a un
 * resumen pequeño (lista de sesiones) y a un detalle acotado (la sesión abierta en el
 * móvil). Nada de esto se guarda: se recalcula y se publica mientras haya un móvil
 * conectado. Los tipos los comparte la PWA (`src/remote/`).
 */
import { describeTool, diffStats, questionsOf, questionsTitle, text, type ChatItem, type ChatState, type Json, type PermissionItem } from "./chatState";
import type { ChatTask } from "./chatTasks";
import type { AgentProvider } from "./types";

export type RemoteStatus = "needs" | "working" | "idle" | "exited";

/** Lo que una sesión espera de ti, en una línea. */
export type RemoteNeed = { kind: "permission" | "question" | "plan"; item: string; label: string };

export type RemoteSession = {
  id: string;
  title: string;
  project: { id: string; name: string };
  provider: AgentProvider;
  /** Perfil y modelo, para reconocer la sesión («Claude Code · Opus»). */
  agent: string;
  model: string | null;
  status: RemoteStatus;
  need: RemoteNeed | null;
  /** Qué hace ahora mismo («Editando remote.rs»). */
  activity: string | null;
  /** Último cambio visible (ms desde epoch), para ordenar y para «hace 3 min». */
  updatedAt: number;
};

export type RemoteItem =
  | { kind: "user"; id: string; text: string; images: number }
  | { kind: "text"; id: string; text: string; final: boolean }
  | { kind: "tool"; id: string; verb: string; target: string; status: "running" | "done" | "error"; added: number; removed: number }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  | { kind: "turn"; id: string; durationMs: number };

export type RemoteQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  other: boolean;
  secret: boolean;
  options: { label: string; title: string; description: string; recommended: boolean }[];
};

export type RemotePending =
  | { kind: "permission"; item: string; tool: string; verb: string; target: string; command: string | null; cwd: string; description: string;
      added: number; removed: number;
      /** Texto del botón «permitir siempre» que propone el propio asistente; null si no lo ofrece. */
      remember: string | null;
      /** Lo que pide, cuando no es un comando (rutas, URL, permisos extra). */
      detail: string | null }
  | { kind: "question"; item: string; title: string; questions: RemoteQuestion[] }
  | { kind: "plan"; item: string; plan: string };

export type RemoteDetail = {
  id: string;
  items: RemoteItem[];
  /** Elementos más antiguos que no se mandan (el móvil solo ve el final). */
  hidden: number;
  tasks: { done: number; total: number; current: string | null };
  pending: RemotePending | null;
  running: boolean;
  turnStartedAt: number | null;
  /** Lo que escribas ahora irá a la cola (el agente está trabajando). */
  queues: boolean;
  queued: number;
  /** La sesión nunca se abrió en el PC: aún no hay historial cargado. */
  dormant: boolean;
  /** No se puede escribir (un workflow la bloquea o hay un traspaso pendiente). */
  locked: string | null;
};

/** Cuántos elementos del final se mandan al móvil y cuánto texto por elemento. */
export const DETAIL_ITEMS = 60;
const MAX_TEXT = 6000;
const MAX_LINE = 160;

const clip = (value: string, max = MAX_TEXT): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const line = (value: string): string => clip(value.replace(/\s+/g, " ").trim(), MAX_LINE);

/** Herramientas que no son trabajo visible: listas de tareas y preguntas tienen su propio sitio. */
const QUIET_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "AskUserQuestion", "ExitPlanMode"]);

export function pendingItem(items: ChatItem[]): PermissionItem | null {
  for (const item of items) if (item.kind === "permission" && item.state === "pending") return item;
  return null;
}

export function remoteNeed(item: PermissionItem | null, cwd: string): RemoteNeed | null {
  if (!item) return null;
  if (item.toolName === "AskUserQuestion") {
    const questions = questionsOf(item.input);
    const first = questions[0]?.question ?? "Te hace una pregunta";
    return { kind: "question", item: item.id, label: line(questions.length > 1 ? `${first} (+${questions.length - 1})` : first) };
  }
  if (item.toolName === "ExitPlanMode") return { kind: "plan", item: item.id, label: "Propone un plan" };
  const tool = describeTool(item.toolName, item.input, cwd, true);
  return { kind: "permission", item: item.id, label: line(`${tool.verb} ${tool.target}`.trim() || item.toolName) };
}

/** La herramienta en curso más reciente, en una frase. */
export function currentActivity(items: ChatItem[], cwd: string): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "user") return null;
    if (item.kind === "tool" && item.status === "running" && !QUIET_TOOLS.has(item.name)) {
      const tool = describeTool(item.name, item.input, cwd, true);
      return line(`${tool.verb} ${tool.target}`.trim());
    }
  }
  return null;
}

export function remoteStatus(state: Pick<ChatState, "items" | "pendingTurns" | "process">): RemoteStatus {
  if (pendingItem(state.items)) return "needs";
  if (state.pendingTurns > 0) return "working";
  if (state.process === "exited" || state.process === "failed") return "exited";
  return "idle";
}

const toolItem = (item: Extract<ChatItem, { kind: "tool" }>, cwd: string): RemoteItem => {
  const tool = describeTool(item.name, item.input, cwd, item.status === "running");
  const stats = item.changeStats ?? diffStats(item.patch);
  return { kind: "tool", id: item.id, verb: tool.verb, target: line(tool.target), status: item.status, added: stats.added, removed: stats.removed };
};

/** Los elementos que el móvil sabe pintar; lo demás (pensamiento, permisos ya resueltos) se omite. */
export function remoteItems(items: ChatItem[], cwd: string): RemoteItem[] {
  const out: RemoteItem[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user": out.push({ kind: "user", id: item.id, text: clip(item.text), images: item.images }); break;
      case "text": if (item.text.trim()) out.push({ kind: "text", id: item.id, text: clip(item.text), final: item.final }); break;
      case "tool": if (!QUIET_TOOLS.has(item.name)) out.push(toolItem(item, cwd)); break;
      case "notice": out.push({ kind: "notice", id: item.id, tone: item.tone, text: clip(item.text, 600) }); break;
      case "turn": out.push({ kind: "turn", id: item.id, durationMs: item.durationMs }); break;
      default: break;
    }
  }
  return out;
}

export function remotePending(item: PermissionItem | null, cwd: string): RemotePending | null {
  if (!item) return null;
  if (item.toolName === "AskUserQuestion") {
    return { kind: "question", item: item.id, title: questionsTitle(item.input), questions: questionsOf(item.input).map(question => ({
      question: question.question, header: question.header, multiSelect: question.multiSelect, other: question.other, secret: question.secret,
      options: question.options.map(option => ({ label: option.label, title: option.title, description: option.description, recommended: option.recommended })),
    })) };
  }
  if (item.toolName === "ExitPlanMode") return { kind: "plan", item: item.id, plan: clip(text(item.input.plan), 12_000) };
  const tool = describeTool(item.toolName, item.input, cwd, true);
  const input: Json = item.input;
  const command = text(input.command) || (Array.isArray(input.command) ? (input.command as unknown[]).map(String).join(" ") : "");
  const stats = diffStats(item.patch);
  return { kind: "permission", item: item.id, tool: item.toolName, verb: tool.verb, target: tool.target, command: command ? clip(command, 4000) : null,
    cwd: text(input.cwd) || cwd, description: clip(item.description || text(input.description), 600), added: stats.added, removed: stats.removed,
    remember: rememberLabel(item.suggestions), detail: command ? null : clip(permissionDetail(item.toolName, input, tool.target), 1500) };
}

/** Mismo texto que la tarjeta del escritorio (ChatItems.tsx). */
export function rememberLabel(suggestions: unknown[]): string | null {
  if (!suggestions.length) return null;
  const first = suggestions[0] as Record<string, unknown>;
  if (typeof first?.label === "string") return first.label;
  if (first?.type === "setMode" && first.mode === "acceptEdits") return "Aceptar ediciones en esta sesión";
  return "Permitir siempre";
}

function permissionDetail(tool: string, input: Json, target: string): string {
  if (tool === "Permissions") {
    const permissions = (input.permissions ?? {}) as { network?: { enabled?: boolean | null } | null; fileSystem?: { read?: string[] | null; write?: string[] | null } | null };
    return [
      ...(permissions.network?.enabled ? ["Acceso a la red"] : []),
      ...(permissions.fileSystem?.write ?? []).map(path => `Escribir en ${path}`),
      ...(permissions.fileSystem?.read ?? []).map(path => `Leer ${path}`),
    ].join("\n") || "Permisos adicionales";
  }
  if (target) return target;
  return Object.keys(input).length ? JSON.stringify(input, null, 2) : "";
}

export function remoteTasks(tasks: ChatTask[]): RemoteDetail["tasks"] {
  const done = tasks.filter(task => task.status === "completed").length;
  const current = tasks.find(task => task.status === "in_progress")?.title ?? null;
  return { done, total: tasks.length, current: current ? line(current) : null };
}

/** Momento del último cambio visible: el inicio del turno o el último mensaje. */
export function lastActivityAt(state: Pick<ChatState, "items" | "turnStartedAt">, fallback: number): number {
  for (let index = state.items.length - 1; index >= 0; index--) {
    const item = state.items[index];
    if (item.kind === "turn" && item.endedAt) return item.endedAt;
    if (item.kind === "user" && item.at) return item.at;
    if (item.kind === "tool" && item.at) return item.at;
  }
  return state.turnStartedAt ?? fallback;
}

export type DetailInput = {
  id: string;
  state: ChatState;
  cwd: string;
  tasks: ChatTask[];
  queues: boolean;
  queued: number;
  dormant: boolean;
  locked: string | null;
};

export function remoteDetail(input: DetailInput): RemoteDetail {
  const all = remoteItems(input.state.items, input.cwd);
  const items = all.slice(-DETAIL_ITEMS);
  return {
    id: input.id, items, hidden: all.length - items.length, tasks: remoteTasks(input.tasks),
    pending: remotePending(pendingItem(input.state.items), input.cwd),
    running: input.state.pendingTurns > 0, turnStartedAt: input.state.turnStartedAt,
    queues: input.queues, queued: input.queued, dormant: input.dormant, locked: input.locked,
  };
}

// --- Órdenes que llegan del móvil ---------------------------------------------------

export type RemoteChoice = { question: string; selected: string[]; other: string };
export type RemoteAction =
  | { kind: "send"; text: string }
  | { kind: "answer"; item: string; allowed: boolean; remember: boolean; choices: RemoteChoice[] | null }
  | { kind: "interrupt" };
export type RemoteCommand = { command: number; device: string; session: string; action: RemoteAction };

/** Valida lo que llega del backend (ya filtrado allí): nunca se confía en la forma. */
export function parseRemoteCommand(value: unknown): RemoteCommand | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const action = raw.action as Record<string, unknown> | undefined;
  if (typeof raw.command !== "number" || typeof raw.session !== "string" || !action || typeof action !== "object") return null;
  const base = { command: raw.command, device: typeof raw.device === "string" ? raw.device : "", session: raw.session };
  if (action.kind === "send" && typeof action.text === "string" && action.text.trim()) return { ...base, action: { kind: "send", text: action.text } };
  if (action.kind === "interrupt") return { ...base, action: { kind: "interrupt" } };
  if (action.kind === "answer" && typeof action.item === "string") {
    const choices = Array.isArray(action.choices) ? action.choices.map(choice => {
      const c = (choice ?? {}) as Record<string, unknown>;
      return { question: typeof c.question === "string" ? c.question : "", selected: Array.isArray(c.selected) ? c.selected.filter((s): s is string => typeof s === "string") : [],
        other: typeof c.other === "string" ? c.other : "" };
    }) : null;
    return { ...base, action: { kind: "answer", item: action.item, allowed: action.allowed === true, remember: action.remember === true, choices } };
  }
  return null;
}

/** «ahora», «3 min», «2 h», «ayer», «5 d»: corto, para listas en el móvil y en Ajustes. */
export function timeAgo(at: number, now: number): string {
  if (!at) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "ahora";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "ayer" : `${days} d`;
}
