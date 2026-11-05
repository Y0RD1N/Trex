import type { BrowserArtifact } from "./browser";
/**
 * Estado del chat común a Claude Code y Codex.
 *
 * Cada proveedor traduce su protocolo a estos elementos (mensajes,
 * herramientas, permisos y avisos) y la interfaz solo conoce este modelo. Las
 * herramientas usan los nombres de Claude Code (Bash, Edit, Read…) para que
 * ambas conversaciones se pinten igual.
 */
import type { AgentInfo, CommandInfo, SkillInfo } from "./chatCommands";
import type { PlanUsage } from "./planUsage";
import type { AgentActivity } from "./types";

export type ToolStatus = "running" | "done" | "error";
export type DiffLine = { kind: "add" | "del" | "ctx" | "gap"; text: string };
export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };
/** Imagen lista para enviar: base64 sin prefijo y su tipo. */
export type OutgoingImage = { mediaType: string; data: string };
export type QuestionOption = {
  /** Etiqueta tal como la escribió el asistente: es lo que se le responde. */
  label: string;
  /** Etiqueta para mostrar, sin la marca de recomendada. */
  title: string;
  description: string;
  /** Contenido para comparar opciones (Claude Code): código, un boceto… */
  preview: string;
  recommended: boolean;
};
export type Question = {
  id: string;
  question: string;
  header: string;
  /** «choice» elige entre opciones; «text» y «number» piden un valor. */
  kind: "choice" | "text" | "number";
  options: QuestionOption[];
  multiSelect: boolean;
  /** Línea de ayuda bajo la pregunta. */
  description: string;
  placeholder: string;
  /** Admite una respuesta propia además de las opciones. */
  other: boolean;
  /** La respuesta no debe verse (una contraseña que pide Codex). */
  secret: boolean;
  number: { min: number | null; max: number | null; step: number | null; initial: number | null; unit: string } | null;
};
/** Lo que eligió la persona en cada pregunta: opciones marcadas y texto propio. */
export type QuestionChoice = { question: string; selected: string[]; other: string };
export type Json = Record<string, unknown>;

export type ChatItem =
  | { kind: "user"; id: string; text: string; images: number; previews: string[]; providerTurnId?: string; fromQueue?: boolean; at?: number }
  | { kind: "text"; id: string; messageId: string; text: string; final: boolean }
  | { kind: "thinking"; id: string; messageId: string; text: string; final: boolean }
  | { kind: "tool"; id: string; name: string; input: Json; status: ToolStatus; output: string | null; patch: DiffLine[] | null;
      changeStats?: { added: number; removed: number }; artifacts?: BrowserArtifact[];
      /** When the call appeared (ms since epoch); measures task durations. */
      at?: number }
  | { kind: "permission"; id: string; toolName: string; toolUseId: string | null; input: Json;
      description: string; suggestions: unknown[]; state: "pending" | "allowed" | "denied";
      /** Cambios que se van a aplicar, cuando el proveedor no los manda en `input`. */
      patch?: DiffLine[] | null;
      /** Petición del proveedor a la que responde la tarjeta. */
      request?: { id: string | number; method: string } }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  | { kind: "turn"; id: string; durationMs: number; diff?: string;
      /** Start and end of the response (ms since epoch), when known. */
      startedAt?: number; endedAt?: number;
      /** Tokens the provider reported for this response. */
      usage?: import("./tokenUsage").ApiUsage | null };

export type PermissionItem = Extract<ChatItem, { kind: "permission" }>;
export type ToolItem = Extract<ChatItem, { kind: "tool" }>;
export type UserItem = Extract<ChatItem, { kind: "user" }>;

/** Resultado terminal de un envío en directo; el historial nunca publica uno. */
export type ChatCompletion = {
  /** Identidad estable: las notificaciones repetidas no producen otro resultado. */
  id: string;
  status: "completed" | "interrupted" | "failed";
  /** Envíos locales consumidos por esta respuesta (Claude puede agruparlos). */
  messageIds: string[];
  /** Textos, herramientas y permisos de esta respuesta; sobreviven a la hidratación del historial. */
  itemIds: string[];
};

/** Una parte fija de lo que ocupa el contexto: instrucciones, herramientas, skills… */
export type ContextPart = { name: string; tokens: number };
/** Lo que ocupa la conversación en la ventana de contexto del modelo. */
export type ContextUsage = {
  used: number;
  window: number | null;
  /** El límite puede conocerse antes de disponer de una medición de esta conversación. */
  measured?: boolean;
  /** Partes fijas medidas por el asistente (Claude Code); los mensajes son el resto hasta `used`. */
  parts: ContextPart[];
  /** Margen que se guarda para resumir la conversación antes de llenar la ventana. */
  reserve: number | null;
  /** Tokens procesados en toda la conversación (Codex). */
  total: number | null;
};

export type ChatState = {
  items: ChatItem[];
  /** Mensajes enviados cuya respuesta no ha terminado. */
  pendingTurns: number;
  /** Mensajes aún no consumidos; Claude puede agrupar varios en un solo turno. */
  pendingMessageIds: string[];
  /** Envíos ya escritos cuya interrupción aún espera el terminal del proveedor. */
  interruptedMessageIds: string[];
  activeMessageIds: string[];
  /** Terminales ya recibidos: una notificación tardía no vuelve a abrirlos. */
  completedTurnIds: string[];
  lastCompletion: ChatCompletion | null;
  /** Inicio de los elementos de la respuesta en curso, sin los de turnos anteriores. */
  turnItemStart: number | null;
  turnStartedAt: number | null;
  /** Conversación del proveedor (sesión de Claude Code o hilo de Codex). */
  sessionId: string | null;
  /** Turno en curso, cuando el proveedor lo identifica (Codex). */
  turnId: string | null;
  /** Diff neto del turno, cuando el proveedor lo informa. */
  turnDiff: string | null;
  /** Modelo real en uso (id completo, por ejemplo claude-opus-5-5). */
  model: string | null;
  /** Modelos que ofrece el CLI, con su descripción y sus niveles de esfuerzo. */
  models: ModelInfo[];
  /** Modelo, esfuerzo y modo elegidos en esta sesión: se repiten al reanudar el proceso. */
  modelChoice: string | null;
  effort: string | null;
  effortChoice: string | null;
  /** Velocidad rápida: Fast mode en Claude Code, nivel de servicio prioritario en Codex. */
  fast: boolean;
  fastChoice: boolean | null;
  permissionMode: string | null;
  modeChoice: string | null;
  /** Comandos `/`, subagentes y skills que ofrece el asistente. */
  commands: CommandInfo[];
  agents: AgentInfo[];
  skills: SkillInfo[];
  /** Contexto en uso y tamaño de la ventana, si se conocen. */
  usage: ContextUsage | null;
  /** Uso del plan de la cuenta (sesión de 5 horas, semana…), si el asistente lo da. */
  plan: PlanUsage | null;
  costUsd: number | null;
  /** Consumo informado por la API en esta conversación; no es el saldo de la cuenta. */
  apiUsage: import("./tokenUsage").ApiUsage | null;
  /** Consumption when the current response started; its difference is the response's usage. */
  turnUsageBase?: import("./tokenUsage").ApiUsage | null;
  /** Bloques del mensaje en curso: índice del bloque → id del elemento. */
  stream: { messageId: string | null; blocks: Record<number, string> };
  /** Mensajes que el CLI confirmó que sobrevivían a una interrupción. */
  queuedAfterInterrupt: string[] | null;
  /** Elementos del principio que vienen del historial guardado. */
  historyCount: number;
  process: "starting" | "ready" | "exited" | "failed";
  exitCode: number | null;
  stderr: string[];
};

/** Acciones que entienden todos los proveedores. */
export type BaseChatAction =
  | { type: "send"; id: string; text: string; previews?: string[]; now: number }
  /** Un envío local cancelado antes de que el proveedor confirme su recepción. */
  | { type: "cancelSend"; id: string }
  /** Conserva la atribución de un envío ya escrito hasta que llegue su terminal. */
  | { type: "interruptSend"; id: string }
  | { type: "queuedRead"; messages: { id: string; text: string; previews: string[] }[] }
  | { type: "bindTurn"; id: string; turnId: string }
  /** Conserva el prefijo anterior al mensaje reemplazado, en la conversación regenerada. */
  | { type: "rewind"; id: string; sessionId: string }
  | { type: "answer"; id: string; allowed: boolean }
  | { type: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  | { type: "model"; model: string }
  | { type: "effort"; effort: string }
  | { type: "fast"; fast: boolean }
  | { type: "mode"; mode: string }
  /** Conversación nueva: vacía el hilo y conserva modelo, modo y catálogos. */
  | { type: "reset" }
  | { type: "spawned" }
  | { type: "spawnFailed"; message: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null };

/** Un modelo guardado es un identificador del CLI, nunca argumentos ni texto de control. */
export const normalizeModelChoice = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value.trim())
    ? value.trim() : null;

/** Estado inicial con las elecciones guardadas antes de arrancar el proceso. */
export const initialChatState = (mode: string | null = null, model: string | null = null, effort: string | null = null): ChatState => ({
  items: [], pendingTurns: 0, pendingMessageIds: [], interruptedMessageIds: [], activeMessageIds: [], completedTurnIds: [],
  lastCompletion: null, turnItemStart: null,
  turnStartedAt: null, sessionId: null, turnId: null, turnDiff: null, model: null, models: [],
  modelChoice: normalizeModelChoice(model), effort: normalizeEffortChoice(effort), effortChoice: normalizeEffortChoice(effort), fast: false, fastChoice: null, permissionMode: mode, modeChoice: mode,
  commands: [], agents: [], skills: [], usage: null, plan: null, costUsd: null, apiUsage: null,
  stream: { messageId: null, blocks: {} }, queuedAfterInterrupt: null, historyCount: 0, process: "starting", exitCode: null, stderr: [],
});

// --- Lectura de datos sin tipo ------------------------------------------------

export const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
export const text = (value: unknown): string => typeof value === "string" ? value : "";
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/**
 * Índice del último elemento que cumple `test`, o -1. Los parsers de streaming
 * actualizan casi siempre el bloque más reciente: buscar desde el final evita
 * recorrer toda la conversación en cada fragmento (O(1) en vez de O(n)).
 */
export function lastIndexWhere<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return index;
  return -1;
}

/** Cierra los textos que seguían llegando por partes. */
export const finalize = (items: ChatItem[]): ChatItem[] =>
  items.map(item => (item.kind === "text" || item.kind === "thinking") && !item.final ? { ...item, final: true } : item);

/** Aviso nuevo, salvo que acabe de mostrarse el mismo. */
export function addNotice(items: ChatItem[], tone: "info" | "warn" | "error", value: string, prefix = "n"): ChatItem[] {
  const recent = items.slice(-6).some(item => item.kind === "notice" && item.text === value);
  return recent ? items : [...items, { kind: "notice", id: `${prefix}-${items.length}`, tone, text: value }];
}

/** Solo atribuye terminales a envíos aún pendientes, nunca a turnos reproducidos. */
export function liveCompletion(state: ChatState, id: string, status: ChatCompletion["status"], messageIds: string[],
  items: ChatItem[] = state.items): ChatCompletion | null {
  const consumed = [...new Set(messageIds.filter(messageId => state.pendingMessageIds.includes(messageId)))];
  const previous = state.lastCompletion;
  if (!consumed.length || previous?.id === id) return previous;
  if (consumed.some(messageId => state.interruptedMessageIds.includes(messageId))) status = "interrupted";
  // Un resultado contradictorio posterior no convierte una cancelación o fallo en éxito.
  if (status === "completed" && previous && previous.status !== "completed"
    && consumed.some(messageId => previous.messageIds.includes(messageId))) return previous;
  return { id, status, messageIds: consumed, itemIds: items.slice(state.turnItemStart ?? state.historyCount)
    .filter(item => item.kind === "text" || item.kind === "thinking" || item.kind === "tool" || item.kind === "permission")
    .map(item => item.id) };
}

/** Acciones comunes; cada proveedor añade las suyas encima. */
export function baseReducer(state: ChatState, action: BaseChatAction): ChatState {
  switch (action.type) {
    case "queuedRead": {
      const ids = new Set(state.items.map(item => item.id));
      return { ...state, items: [...state.items, ...action.messages.filter(message => {
        if (ids.has(message.id)) return false;
        ids.add(message.id);
        return true;
      }).map(message => ({
        kind: "user" as const, id: message.id, text: message.text, images: message.previews.length, previews: message.previews, fromQueue: true,
      }))] };
    }
    case "send":
      if (state.pendingMessageIds.includes(action.id)) return state;
      return {
        ...state,
        items: [...state.items, { kind: "user", id: action.id, text: action.text,
          images: action.previews?.length ?? 0, previews: action.previews ?? [] }],
        pendingTurns: state.pendingTurns + 1,
        pendingMessageIds: [...state.pendingMessageIds, action.id],
        interruptedMessageIds: state.interruptedMessageIds.filter(id => state.pendingMessageIds.includes(id)),
        turnItemStart: state.turnItemStart ?? state.items.length + 1,
        queuedAfterInterrupt: state.queuedAfterInterrupt === null ? null : [...state.queuedAfterInterrupt, action.id],
        turnStartedAt: state.turnStartedAt ?? action.now,
      };
    case "bindTurn":
      return { ...state, items: state.items.map(item => item.kind === "user" && item.id === action.id
        ? { ...item, providerTurnId: action.turnId } : item) };
    case "cancelSend": {
      if (!state.pendingMessageIds.includes(action.id)) return state;
      const pendingMessageIds = state.pendingMessageIds.filter(id => id !== action.id);
      return { ...state, pendingMessageIds, pendingTurns: Math.min(state.pendingTurns, pendingMessageIds.length),
        interruptedMessageIds: state.interruptedMessageIds.filter(id => id !== action.id),
        activeMessageIds: state.activeMessageIds.filter(id => id !== action.id),
        queuedAfterInterrupt: state.queuedAfterInterrupt?.filter(id => id !== action.id) ?? null,
        lastCompletion: liveCompletion(state, `cancel:${action.id}`, "interrupted", [action.id]),
        turnItemStart: pendingMessageIds.length ? state.turnItemStart : null,
        turnStartedAt: pendingMessageIds.length ? state.turnStartedAt : null };
    }
    case "interruptSend":
      if (!state.pendingMessageIds.includes(action.id) || state.interruptedMessageIds.includes(action.id)) return state;
      return { ...state, interruptedMessageIds: [...state.interruptedMessageIds, action.id],
        lastCompletion: liveCompletion(state, `cancel:${action.id}`, "interrupted", [action.id]) };
    case "rewind": {
      const index = state.items.findIndex(item => item.kind === "user" && item.id === action.id);
      if (index < 0) return state;
      return { ...state, items: state.items.slice(0, index), historyCount: Math.min(state.historyCount, index),
        sessionId: action.sessionId, pendingTurns: 0, pendingMessageIds: [], interruptedMessageIds: [], activeMessageIds: [], completedTurnIds: [],
        turnStartedAt: null, turnId: null, turnDiff: null, lastCompletion: null, turnItemStart: null,
        usage: null, costUsd: null, apiUsage: null, stream: { messageId: null, blocks: {} }, queuedAfterInterrupt: null };
    }
    case "answer":
      return { ...state, items: state.items.map(item => item.kind === "permission" && item.id === action.id
        ? { ...item, state: action.allowed ? "allowed" : "denied" } : item) };
    case "notice":
      return { ...state, items: [...state.items, { kind: "notice", id: action.id, tone: action.tone, text: action.text }] };
    case "model":
      return { ...state, modelChoice: action.model,
        model: state.models.find(model => model.value === action.model)?.resolvedModel ?? state.model };
    case "effort":
      return { ...state, effort: action.effort, effortChoice: action.effort };
    case "fast":
      return { ...state, fast: action.fast, fastChoice: action.fast };
    case "mode":
      return { ...state, permissionMode: action.mode, modeChoice: action.mode };
    case "reset":
      return { ...initialChatState(), process: state.process, models: state.models, model: state.model, modelChoice: state.modelChoice,
        effort: state.effort, effortChoice: state.effortChoice, fast: state.fast, fastChoice: state.fastChoice, permissionMode: state.permissionMode, modeChoice: state.modeChoice,
        commands: state.commands, agents: state.agents, skills: state.skills, plan: state.plan };
    case "spawned":
      return { ...state, process: "ready", exitCode: null, stderr: [],
        lastCompletion: state.lastCompletion?.status === "interrupted" ? state.lastCompletion : null,
        turnItemStart: state.pendingTurns ? state.turnItemStart : null };
    case "spawnFailed":
      return { ...state, process: "failed", pendingTurns: 0, pendingMessageIds: [], activeMessageIds: [], turnStartedAt: null, turnId: null,
        lastCompletion: liveCompletion(state, `spawn:${JSON.stringify(state.pendingMessageIds)}`, "failed", state.pendingMessageIds), turnItemStart: null,
        items: [...state.items, { kind: "notice", id: `f-${state.items.length}`, tone: "error", text: action.message }] };
    case "stderr":
      return { ...state, stderr: [...state.stderr, action.line].slice(-40) };
    case "exit": {
      // Las peticiones pendientes ya no pueden responderse.
      const items = finalize(state.items).map(item =>
        item.kind === "permission" && item.state === "pending" ? { ...item, state: "denied" as const }
          : item.kind === "tool" && item.status === "running" ? { ...item, status: "error" as const } : item);
      return { ...state, items, process: "exited", exitCode: action.code, pendingTurns: 0, pendingMessageIds: [], activeMessageIds: [], turnStartedAt: null, turnId: null,
        lastCompletion: liveCompletion(state, `exit:${JSON.stringify(state.pendingMessageIds)}`, action.code ? "failed" : "interrupted", state.pendingMessageIds, items),
        turnItemStart: null,
        queuedAfterInterrupt: null };
    }
  }
}

// --- Contenido de las herramientas --------------------------------------------

/** Texto de un resultado de herramienta (cadena o lista de bloques). */
export function resultText(content: unknown, limit = 20_000): string {
  const value = typeof content === "string" ? content
    : list(content).map(part => {
      const block = record(part);
      return block?.type === "text" ? text(block.text) : block?.type === "image" ? "[imagen]" : "";
    }).filter(Boolean).join("\n");
  return clip(value, limit);
}

export const clip = (value: string, limit = 20_000): string => value.length > limit ? `${value.slice(0, limit)}…` : value;

export const splitLines = (value: string): string[] => value.replace(/\n$/, "").split("\n");

const limitLines = (lines: DiffLine[], maxLines: number): DiffLine[] =>
  lines.length > maxLines ? [...lines.slice(0, maxLines), { kind: "gap", text: `… ${lines.length - maxLines} líneas más` }] : lines;

/** Vista previa de una edición de Claude Code antes de tener el parche (permisos, historial). */
export function inputDiff(name: string, input: Json, maxLines = 400): DiffLine[] | null {
  if (name === "TrexPatch") {
    const lines = list(input.files).flatMap(value => {
      const file = record(value);
      if (!file) return [];
      return [{ kind: "gap" as const, text: text(file.file_path) }, ...(inputDiff("Edit", file, maxLines) ?? [])];
    });
    return lines.length ? limitLines(lines, maxLines) : null;
  }
  const edits = name === "MultiEdit" ? list(input.edits).map(record).filter((edit): edit is Json => !!edit)
    : name === "Edit" ? [input] : [];
  const lines: DiffLine[] = [];
  edits.forEach((edit, index) => {
    if (index > 0) lines.push({ kind: "gap", text: "…" });
    for (const line of splitLines(text(edit.old_string))) lines.push({ kind: "del", text: line });
    for (const line of splitLines(text(edit.new_string))) lines.push({ kind: "add", text: line });
  });
  if (name === "Write" && typeof input.content === "string") {
    for (const line of splitLines(input.content)) lines.push({ kind: "add", text: line });
  }
  return lines.length ? limitLines(lines, maxLines) : null;
}

/**
 * Diff unificado (`@@ … @@`) en líneas. Sin cabeceras de bloque es el
 * contenido entero de un archivo nuevo o eliminado.
 */
export function unifiedDiffLines(diff: string, whole: "add" | "del" = "add", maxLines = 2000): DiffLine[] | null {
  if (!diff.trim()) return null;
  const raw = splitLines(diff);
  if (!raw.some(line => line.startsWith("@@"))) return limitLines(raw.map(line => ({ kind: whole, text: line })), maxLines);
  const lines: DiffLine[] = [];
  let inHunk = false, hunks = 0;
  for (const line of raw) {
    if (line.startsWith("diff --git")) { inHunk = false; continue; }
    if (line.startsWith("@@")) {
      if (hunks++ > 0) lines.push({ kind: "gap", text: "…" });
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    lines.push(line.startsWith("+") ? { kind: "add", text: line.slice(1) }
      : line.startsWith("-") ? { kind: "del", text: line.slice(1) } : { kind: "ctx", text: line.slice(1) });
  }
  return lines.length ? limitLines(lines, maxLines) : null;
}

export const diffStats = (lines: DiffLine[] | null | undefined): { added: number; removed: number } => ({
  added: lines?.filter(line => line.kind === "add").length ?? 0,
  removed: lines?.filter(line => line.kind === "del").length ?? 0,
});

export function todoItems(input: Json): TodoItem[] {
  return list(input.todos).map(record).filter((todo): todo is Json => !!todo && typeof todo.content === "string")
    .map(todo => ({
      content: text(todo.content),
      status: todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending",
      activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined,
    }));
}

/** Marca con la que el asistente señala la opción que recomienda. */
const RECOMMENDED = /\s*\((recommended|recomendad[oa])\)\s*$/i;
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Preguntas de AskUserQuestion (Claude Code) o de request_user_input (Codex).
 * Codex marca si admite otra respuesta (`isOther`) y si es secreta (`isSecret`).
 */
export function questionsOf(input: Json): Question[] {
  return list(input.questions).map(record).filter((question): question is Json => !!question && typeof question.question === "string")
    .map((question, index) => {
      const options = list(question.options).map(record).filter((option): option is Json => !!option && typeof option.label === "string")
        .map(option => {
          const label = text(option.label);
          return { label, title: label.replace(RECOMMENDED, "") || label, description: text(option.description),
            preview: text(option.preview), recommended: RECOMMENDED.test(label) };
        });
      const kind = question.kind === "text" || question.kind === "number" ? question.kind : options.length ? "choice" : "text";
      return {
        id: text(question.id) || String(index),
        question: text(question.question),
        header: text(question.header),
        kind,
        options: kind === "choice" ? options : [],
        multiSelect: kind === "choice" && question.multiSelect === true,
        description: text(question.description),
        placeholder: text(question.placeholder),
        other: kind !== "choice" || question.isOther !== false,
        secret: question.isSecret === true,
        number: kind === "number" ? { min: numberOrNull(question.min), max: numberOrNull(question.max), step: numberOrNull(question.step),
          initial: numberOrNull(question.defaultValue), unit: text(question.unit) } : null,
      };
    });
}

/** Encabezado opcional sobre las preguntas («Antes de preparar la presentación»). */
export const questionsTitle = (input: Json): string => text(input.title);

/** Respuesta elegida en una pregunta: opciones marcadas y texto libre. */
export const choiceAnswers = (choice: QuestionChoice): string[] => [...choice.selected, choice.other.trim()].filter(Boolean);

/** Respuestas que ya conoce el hilo: pregunta → respuesta (texto o lista). */
export function answersOf(input: Json): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(record(input.answers) ?? {})) {
    const value = Array.isArray(answer) ? answer.filter((part): part is string => typeof part === "string").join(", ") : text(answer);
    if (value) answers[question] = value;
  }
  return answers;
}

// --- Datos derivados ----------------------------------------------------------

export const pendingPermissions = (state: ChatState): number =>
  state.items.filter(item => item.kind === "permission" && item.state === "pending").length;

/** Modos en los que se permite todo: Claude Code sin permisos y Codex con acceso total. */
const ALLOW_ALL_MODES = new Set(["bypassPermissions", "full"]);
export const allowsAll = (mode: string | null): boolean => mode !== null && ALLOW_ALL_MODES.has(mode);
/** Preguntas y planes esperan una respuesta, no un permiso: nunca se aceptan solos. */
export const needsAnswer = (toolName: string): boolean => toolName === "AskUserQuestion" || toolName === "ExitPlanMode";
/** Permisos pendientes que se aceptan solos al pasar a un modo que lo permite todo. */
export const autoAllowed = (items: ChatItem[]): PermissionItem[] =>
  items.filter((item): item is PermissionItem => item.kind === "permission" && item.state === "pending" && !needsAnswer(item.toolName));

/**
 * Contexto que se muestra: el medido o, antes del primer mensaje, una
 * conversación vacía en la ventana del modelo elegido.
 */
export function shownUsage(state: ChatState): ContextUsage | null {
  const size = currentModel(state.models, state.model, state.modelChoice)?.contextWindow;
  if (state.usage) return state.usage.window || !size ? state.usage : { ...state.usage, window: size };
  return size ? { used: 0, window: size, parts: [], reserve: null, total: null } : null;
}

/** Parte de la ventana de contexto en uso (0–100), si se conoce la ventana. */
export const contextPercent = (usage: ContextUsage | null): number | null =>
  usage?.window && usage.measured !== false ? Math.min(100, Math.max(0, (usage.used / usage.window) * 100)) : null;

/** Etiqueta compartida por el visor, su nombre accesible y el estado del chat. */
export const contextTokensLabel = (usage: ContextUsage): string => usage.measured === false
  ? usage.window ? `Límite: ${formatTokens(usage.window)} tokens` : "Límite de contexto no disponible"
  : `${formatTokens(usage.used)}${usage.window ? ` de ${formatTokens(usage.window)}` : ""} tokens`;

export const formatTokens = (count: number): string =>
  count >= 999_500 ? `${(count / 1_000_000).toLocaleString("es", { maximumFractionDigits: 1 })} M`
    : count >= 1000 ? `${(count / 1000).toLocaleString("es", { maximumFractionDigits: count >= 100_000 ? 0 : 1 })} k` : String(count);

export function chatActivity(state: ChatState): AgentActivity {
  if (pendingPermissions(state) > 0) return "waiting";
  return state.pendingTurns > 0 ? "working" : "idle";
}

/** Título de la conversación a partir del primer mensaje. */
export function conversationTitle(value: string, max = 60): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Ruta relativa al proyecto cuando el archivo está dentro de él. */
export function relativePath(path: string, cwd: string): string {
  const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = normalize(path), root = normalize(cwd);
  return root && file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : path;
}

export type ToolSummary = { icon: "read" | "edit" | "run" | "search" | "web" | "task" | "todo" | "plan" | "question" | "tool"; verb: string; target: string };

const firstLine = (value: string, max = 120): string => {
  const line = value.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Herramienta del control por accesibilidad (`a11y_click`…) sin el prefijo de
 * cada proveedor: `mcp__trex_a11y__a11y_click` (Claude, Codex) o
 * `mcp_trex_a11y_a11y_click_1a2b3c4d` (Trex CLI). null si es otra.
 */
export function a11yToolName(name: string): string | null {
  return /trex_a11y.*?a11y_([a-z_]+?)(?:_[0-9a-f]{8})?$/.exec(name)?.[1] ?? null;
}

/** Si la respuesta de una acción del control por accesibilidad confirma que se comprobó. */
export function a11yVerified(name: string, output: string | null | undefined): boolean {
  return a11yToolName(name) !== null && /^(Value verified|Now (checked|unchecked|mixed) \(verified\)|Selected .*\(verified\)|(Expanded|Collapsed) \(verified\)|Window w[0-9A-F]+ is now .* \(verified\))/.test(output ?? "");
}

function describeA11y(tool: string, input: Json, running: boolean): ToolSummary {
  const verb = (live: string, done: string): string => running ? live : done;
  const quoted = (value: unknown): string => text(value) ? `«${text(value)}»` : "";
  const window = text(input.app) || "una ventana";
  const characters = (value: unknown): string => {
    const count = text(value).length;
    return count === 1 ? "1 carácter" : `${count.toLocaleString("es")} caracteres`;
  };
  const labels: Record<string, [ToolSummary["icon"], string, string, string]> = {
    list_windows: ["search", "Revisando", "Revisó", "las ventanas abiertas"],
    snapshot: ["read", "Leyendo", "Leyó", text(input.app) || "la ventana"],
    find: ["search", "Buscando", "Buscó", quoted(input.name) || text(input.role) || "en la ventana"],
    get: ["read", "Leyendo", "Leyó", "un elemento"],
    wait: ["tool", "Esperando", "Esperó", typeof input.ms === "number" ? `${input.ms} ms` : "a que cambie la ventana"],
    status: ["tool", "Comprobando", "Comprobó", "el control por accesibilidad"],
    click: ["tool", "Pulsando", "Pulsó", "un elemento"],
    right_click: ["tool", "Abriendo", "Abrió", "un menú contextual"],
    set_value: ["edit", "Escribiendo", "Escribió", characters(input.value)],
    type: ["edit", "Escribiendo", "Escribió", characters(input.text)],
    clear: ["edit", "Vaciando", "Vació", "un campo"],
    toggle: ["tool", "Cambiando", "Cambió", "una casilla"],
    check: ["tool", "Marcando", "Marcó", "una casilla"],
    uncheck: ["tool", "Desmarcando", "Desmarcó", "una casilla"],
    expand: ["tool", "Desplegando", "Desplegó", "un menú"],
    collapse: ["tool", "Plegando", "Plegó", "un menú"],
    select: ["tool", "Eligiendo", "Eligió", quoted(input.value) || "una opción"],
    scroll: ["tool", "Desplazando", "Desplazó", text(input.direction) === "up" ? "hacia arriba" : text(input.direction) === "down" ? "hacia abajo" : "la vista"],
    scroll_to: ["tool", "Desplazando", "Desplazó", "hasta un elemento"],
    launch: ["run", "Abriendo", "Abrió", text(input.app) || "una aplicación"],
    close_app: ["tool", "Cerrando", "Cerró", window],
    minimize: ["tool", "Minimizando", "Minimizó", window],
    maximize: ["tool", "Maximizando", "Maximizó", window],
    restore: ["tool", "Restaurando", "Restauró", window],
    press: ["run", "Pulsando", "Pulsó", text(input.keys) || "un atajo"],
    focus: ["tool", "Enfocando", "Enfocó", "un elemento"],
    focus_window: ["tool", "Trayendo al frente", "Trajo al frente", window],
  };
  const [icon, live, done, target] = labels[tool] ?? ["tool", "Usando", "Usó", `el control por accesibilidad (${tool})`];
  return { icon, verb: verb(live, done), target };
}

/**
 * La aplicación que el agente está manejando, si lo último que hizo en este
 * turno fue usar el control por accesibilidad; null si no. Se saca de la
 * respuesta del propio motor (`(notepad.exe)`) o, si no, de lo que pidió.
 */
export function a11yActivity(items: readonly ChatItem[]): { app: string | null } | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "user") return null;
    if (item.kind !== "tool") continue;
    if (!a11yToolName(item.name)) return null;
    // La app: la más reciente que nombre alguna respuesta o petición del turno.
    for (let back = index; back >= 0; back--) {
      const tool = items[back];
      if (tool.kind === "user") break;
      if (tool.kind !== "tool" || !a11yToolName(tool.name)) continue;
      const output = typeof tool.output === "string" ? tool.output : "";
      const app = /^(?:window|New window) w[0-9A-F]+ (?:"[^"]*" \(([^)\s]+)\)|([^\s"]+) ")/m.exec(output);
      const named = app?.[1] ?? app?.[2] ?? (text(tool.input.app) || null);
      if (named) return { app: named.replace(/\.exe$/i, "") };
    }
    return { app: null };
  }
  return null;
}

/** Frase corta para la fila de una herramienta, en presente o en pasado. */
export function describeTool(name: string, input: Json, cwd: string, running: boolean): ToolSummary {
  const path = (key: string): string => relativePath(text(input[key]), cwd);
  const verb = (live: string, done: string): string => running ? live : done;
  const a11y = a11yToolName(name);
  if (a11y) return describeA11y(a11y, input, running);
  const browser = name.replace(/^mcp__trex_browser__/, "");
  const browserLabels: Record<string, [string, string, string]> = {
    browser_batch: ["Ejecutando", "Ejecutó", "un flujo del navegador"],
    browser_navigate: ["Abriendo", "Abrió", text(input.url) || "una página"],
    browser_navigate_back: ["Volviendo", "Volvió", "a la página anterior"],
    browser_reload: ["Recargando", "Recargó", "la página"],
    browser_snapshot: ["Revisando", "Revisó", "el contenido de la página"],
    browser_take_screenshot: ["Capturando", "Capturó", "la página"],
    browser_start_video: ["Iniciando", "Inició", "una grabación"],
    browser_stop_video: ["Guardando", "Guardó", "el vídeo"],
    browser_click: ["Haciendo clic", "Hizo clic", text(input.name) || text(input.selector) || "en la página"],
    browser_console_messages: ["Revisando", "Revisó", "la consola del navegador"],
    browser_network_requests: ["Revisando", "Revisó", "las solicitudes de red"],
    browser_network_body: ["Leyendo", "Leyó", "una respuesta de red"],
    browser_perf_start: ["Iniciando", "Inició", "la medición de rendimiento"],
    browser_perf_stop: ["Guardando", "Guardó", "la medición de rendimiento"],
    browser_start_trace: ["Iniciando", "Inició", "el registro de acciones"],
    browser_stop_trace: ["Guardando", "Guardó", "el registro de acciones"],
    browser_cpu_profile_start: ["Midiendo", "Midió", "el uso de CPU"],
    browser_cpu_profile_stop: ["Guardando", "Guardó", "el perfil de CPU"],
    browser_heap_snapshot: ["Revisando", "Revisó", "la memoria de la página"],
  };
  if (Object.prototype.hasOwnProperty.call(browserLabels, browser)) {
    const [live, done, target] = browserLabels[browser];
    return { icon: "web", verb: verb(live, done), target };
  }
  switch (name) {
    case "Read": return { icon: "read", verb: verb("Leyendo", "Leyó"), target: path("file_path") };
    case "Edit": case "MultiEdit": return { icon: "edit", verb: verb("Editando", "Editó"), target: path("file_path") };
    case "Write": return { icon: "edit", verb: verb("Escribiendo", "Escribió"), target: path("file_path") };
    case "TrexPatch": return { icon: "edit", verb: verb("Editando", "Editó"), target: list(input.files).map(value => relativePath(text(record(value)?.file_path), cwd)).filter(Boolean).join(", ") };
    case "Delete": return { icon: "edit", verb: verb("Eliminando", "Eliminó"), target: path("file_path") };
    case "Move": return { icon: "edit", verb: verb("Moviendo", "Movió"), target: `${path("file_path")} → ${path("destination")}` };
    case "NotebookEdit": return { icon: "edit", verb: verb("Editando", "Editó"), target: path("notebook_path") };
    case "Bash": return { icon: "run", verb: verb("Ejecutando", "Ejecutó"), target: firstLine(text(input.command)) };
    case "Grep": return { icon: "search", verb: verb("Buscando", "Buscó"), target: [text(input.pattern), text(input.path) && `en ${path("path")}`].filter(Boolean).join(" ") };
    case "Glob": return { icon: "search", verb: verb("Buscando archivos", "Buscó archivos"), target: text(input.pattern) };
    case "LS": return { icon: "search", verb: verb("Listando archivos", "Listó archivos"), target: text(input.path) === "." ? "" : path("path") };
    case "ViewImage": return { icon: "read", verb: verb("Viendo", "Vio"), target: path("file_path") };
    case "WebFetch": {
      let host = text(input.url);
      try { host = new URL(host).host; } catch { /* se muestra tal cual */ }
      return { icon: "web", verb: verb("Abriendo", "Abrió"), target: host };
    }
    case "WebSearch": return { icon: "web", verb: verb("Buscando en la web", "Buscó en la web"), target: text(input.query) };
    case "Task": case "Agent": return { icon: "task", verb: verb("Delegando", "Delegó"), target: text(input.description) };
    case "TodoWrite": return { icon: "todo", verb: "Actualizó las tareas", target: "" };
    case "ExitPlanMode": return { icon: "plan", verb: "Propuso un plan", target: "" };
    case "AskUserQuestion": return { icon: "question", verb: verb("Preguntando", "Preguntó"), target: questionsOf(input)[0]?.question ?? "" };
    case "Skill": return { icon: "tool", verb: verb("Usando", "Usó"), target: text(input.skill) || text(input.command) };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return { icon: "tool", verb: verb("Usando", "Usó"), target: mcp ? `${mcp[1]} · ${mcp[2]}` : name };
    }
  }
}

// --- Modelos y esfuerzo -------------------------------------------------------

export type ModelInfo = {
  value: string; resolvedModel: string; displayName: string; description: string; efforts: string[];
  /** Se muestra en la lista principal; el resto va en «Otras versiones». */
  featured: boolean;
  /** Esfuerzo que usa el modelo si no se elige otro. */
  defaultEffort?: string;
  /** Tokens que caben en su ventana de contexto, si se conocen antes de usarlo. */
  contextWindow?: number;
  contextWindowSource?: "remote" | "documented";
  inputModalities?: string[];
  /** Velocidad rápida, si el modelo la admite: el nivel que la activa y qué supone. */
  fast?: { tier: string; hint: string };
};

const FAMILY_DESCRIPTIONS: Record<string, string> = {
  fable: "Para los retos más difíciles",
  opus: "Para trabajo complejo y del día a día",
  sonnet: "El más eficiente para tareas sencillas",
  haiku: "El más rápido para respuestas breves",
};

/** Los modelos destacados van primero; las versiones concretas, aparte. */
export function splitModels(models: ModelInfo[]): { main: ModelInfo[]; others: ModelInfo[] } {
  return { main: models.filter(model => model.featured), others: models.filter(model => !model.featured) };
}

/** Modelo del catálogo que corresponde a lo que está en uso. */
export function currentModel(models: ModelInfo[], resolved: string | null, choice: string | null): ModelInfo | null {
  return (choice ? models.find(model => model.value === choice) : null)
    ?? models.find(model => model.value !== "default" && model.resolvedModel === resolved)
    ?? models.find(model => model.resolvedModel === resolved) ?? null;
}

export function modelName(model: ModelInfo): string {
  return model.value === "default" ? "Predeterminado" : model.displayName;
}

export function modelDescription(model: ModelInfo, models: ModelInfo[] = []): string {
  if (model.value === "default") {
    const target = models.find(item => item.value !== "default" && item.resolvedModel === model.resolvedModel);
    return `Recomendado · ${target?.displayName ?? model.description.split(" · ")[0] ?? ""}`.replace(/ · $/, "");
  }
  const family = /(fable|opus|sonnet|haiku)/i.exec(`${model.value} ${model.displayName}`)?.[1]?.toLowerCase();
  return family ? FAMILY_DESCRIPTIONS[family] : model.description;
}

export const EFFORT_LEVELS: Record<string, { label: string; short: string; hint: string; bars: number }> = {
  none: { label: "Sin razonamiento", short: "Ninguno", hint: "Responde directamente, sin pensar antes.", bars: 0 },
  minimal: { label: "Mínimo", short: "Mínimo", hint: "Apenas razona; el más rápido.", bars: 1 },
  low: { label: "Bajo", short: "Bajo", hint: "Responde rápido, con poco razonamiento.", bars: 1 },
  medium: { label: "Medio", short: "Medio", hint: "Equilibrio entre rapidez y calidad.", bars: 2 },
  high: { label: "Alto", short: "Alto", hint: "Razona a fondo antes de actuar.", bars: 3 },
  xhigh: { label: "Muy alto", short: "Muy alto", hint: "Para problemas difíciles; tarda más.", bars: 4 },
  max: { label: "Máximo", short: "Máx.", hint: "Todo el razonamiento posible; el más lento.", bars: 5 },
  ultra: { label: "Ultra", short: "Ultra", hint: "Razona al máximo y reparte el trabajo entre varios agentes.", bars: 5 },
};

export const effortLabel = (effort: string | null): string => (effort && EFFORT_LEVELS[effort]?.label) || effort || "";
/** Solo niveles reconocidos del protocolo, nunca argumentos ni opciones arbitrarias. */
export const normalizeEffortChoice = (value: unknown): string | null =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(EFFORT_LEVELS, value.trim()) ? value.trim() : null;

/** Niveles de esfuerzo que admite el modelo en uso. */
export const supportedEfforts = (models: ModelInfo[], model: string | null, choice: string | null): string[] =>
  (currentModel(models, model, choice)?.efforts ?? []).filter(level => EFFORT_LEVELS[level]);

/** Velocidad rápida del modelo en uso, o null si no la admite. */
export const fastSpeed = (models: ModelInfo[], model: string | null, choice: string | null): ModelInfo["fast"] | null =>
  currentModel(models, model, choice)?.fast ?? null;

/** Descripción de la velocidad rápida en español: «2x speed, increased usage» → «2× más rápido; gasta más uso del plan.». */
export function speedHint(description: string): string {
  const factor = /(\d+(?:\.\d+)?)\s*x\s+speed/i.exec(description)?.[1];
  if (!factor) return "Respuestas más rápidas.";
  const costly = /increased usage|more usage|higher (cost|usage)/i.test(description);
  return `${factor.replace(".", ",")}× más rápido${costly ? "; gasta más uso del plan" : ""}.`;
}

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60 ? `${seconds % 60} s` : ""}`.trim();
};

/** Nombre corto del modelo para el selector. */
export function modelLabel(model: string | null): string {
  if (!model) return "Modelo";
  const family = /(fable|opus|sonnet|haiku)/i.exec(model)?.[1];
  return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : model;
}
