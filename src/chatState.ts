/**
 * Estado del chat común a Claude Code y Codex.
 *
 * Cada proveedor traduce su protocolo a estos elementos (mensajes,
 * herramientas, permisos y avisos) y la interfaz solo conoce este modelo. Las
 * herramientas usan los nombres de Claude Code (Bash, Edit, Read…) para que
 * ambas conversaciones se pinten igual.
 */
import type { AgentInfo, CommandInfo, SkillInfo } from "./chatCommands";
import type { AgentActivity } from "./types";

export type ToolStatus = "running" | "done" | "error";
export type DiffLine = { kind: "add" | "del" | "ctx" | "gap"; text: string };
export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };
/** Imagen lista para enviar: base64 sin prefijo y su tipo. */
export type OutgoingImage = { mediaType: string; data: string };
export type Question = { id: string; question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };
/** Lo que eligió la persona en cada pregunta con opciones. */
export type QuestionChoice = { question: string; selected: string[]; other: string };
export type Json = Record<string, unknown>;

export type ChatItem =
  | { kind: "user"; id: string; text: string; images: number; previews: string[] }
  | { kind: "text"; id: string; messageId: string; text: string; final: boolean }
  | { kind: "thinking"; id: string; messageId: string; text: string; final: boolean }
  | { kind: "tool"; id: string; name: string; input: Json; status: ToolStatus; output: string | null; patch: DiffLine[] | null }
  | { kind: "permission"; id: string; toolName: string; toolUseId: string | null; input: Json;
      description: string; suggestions: unknown[]; state: "pending" | "allowed" | "denied";
      /** Cambios que se van a aplicar, cuando el proveedor no los manda en `input`. */
      patch?: DiffLine[] | null;
      /** Petición del proveedor a la que responde la tarjeta. */
      request?: { id: string | number; method: string } }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  | { kind: "turn"; id: string; durationMs: number };

export type PermissionItem = Extract<ChatItem, { kind: "permission" }>;
export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export type ChatState = {
  items: ChatItem[];
  /** Mensajes enviados cuya respuesta no ha terminado. */
  pendingTurns: number;
  turnStartedAt: number | null;
  /** Conversación del proveedor (sesión de Claude Code o hilo de Codex). */
  sessionId: string | null;
  /** Turno en curso, cuando el proveedor lo identifica (Codex). */
  turnId: string | null;
  /** Modelo real en uso (id completo, por ejemplo claude-opus-5-5). */
  model: string | null;
  /** Modelos que ofrece el CLI, con su descripción y sus niveles de esfuerzo. */
  models: ModelInfo[];
  /** Modelo, esfuerzo y modo elegidos en esta sesión: se repiten al reanudar el proceso. */
  modelChoice: string | null;
  effort: string | null;
  effortChoice: string | null;
  permissionMode: string | null;
  modeChoice: string | null;
  /** Comandos `/`, subagentes y skills que ofrece el asistente. */
  commands: CommandInfo[];
  agents: AgentInfo[];
  skills: SkillInfo[];
  /** Contexto usado en el último turno y tamaño de la ventana, si se conocen. */
  usage: { used: number; window: number | null } | null;
  costUsd: number | null;
  /** Bloques del mensaje en curso: índice del bloque → id del elemento. */
  stream: { messageId: string | null; blocks: Record<number, string> };
  /** Tras una interrupción, cuántos mensajes siguen en cola. */
  queuedAfterInterrupt: number | null;
  /** Elementos del principio que vienen del historial guardado. */
  historyCount: number;
  process: "starting" | "ready" | "exited" | "failed";
  exitCode: number | null;
  stderr: string[];
};

/** Acciones que entienden todos los proveedores. */
export type BaseChatAction =
  | { type: "send"; id: string; text: string; previews?: string[]; now: number }
  | { type: "answer"; id: string; allowed: boolean }
  | { type: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  | { type: "model"; model: string }
  | { type: "effort"; effort: string }
  | { type: "mode"; mode: string }
  /** Conversación nueva: vacía el hilo y conserva modelo, modo y catálogos. */
  | { type: "reset" }
  | { type: "spawned" }
  | { type: "spawnFailed"; message: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null };

export const initialChatState = (): ChatState => ({
  items: [], pendingTurns: 0, turnStartedAt: null, sessionId: null, turnId: null, model: null, models: [],
  modelChoice: null, effort: null, effortChoice: null, permissionMode: null, modeChoice: null,
  commands: [], agents: [], skills: [], usage: null, costUsd: null,
  stream: { messageId: null, blocks: {} }, queuedAfterInterrupt: null, historyCount: 0, process: "starting", exitCode: null, stderr: [],
});

// --- Lectura de datos sin tipo ------------------------------------------------

export const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
export const text = (value: unknown): string => typeof value === "string" ? value : "";
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Cierra los textos que seguían llegando por partes. */
export const finalize = (items: ChatItem[]): ChatItem[] =>
  items.map(item => (item.kind === "text" || item.kind === "thinking") && !item.final ? { ...item, final: true } : item);

/** Aviso nuevo, salvo que acabe de mostrarse el mismo. */
export function addNotice(items: ChatItem[], tone: "info" | "warn" | "error", value: string, prefix = "n"): ChatItem[] {
  const recent = items.slice(-6).some(item => item.kind === "notice" && item.text === value);
  return recent ? items : [...items, { kind: "notice", id: `${prefix}-${items.length}`, tone, text: value }];
}

/** Acciones comunes; cada proveedor añade las suyas encima. */
export function baseReducer(state: ChatState, action: BaseChatAction): ChatState {
  switch (action.type) {
    case "send":
      return {
        ...state,
        items: [...state.items, { kind: "user", id: action.id, text: action.text,
          images: action.previews?.length ?? 0, previews: action.previews ?? [] }],
        pendingTurns: state.pendingTurns + 1,
        turnStartedAt: state.turnStartedAt ?? action.now,
      };
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
    case "mode":
      return { ...state, permissionMode: action.mode, modeChoice: action.mode };
    case "reset":
      return { ...initialChatState(), process: state.process, models: state.models, model: state.model, modelChoice: state.modelChoice,
        effort: state.effort, effortChoice: state.effortChoice, permissionMode: state.permissionMode, modeChoice: state.modeChoice,
        commands: state.commands, agents: state.agents, skills: state.skills };
    case "spawned":
      return { ...state, process: "ready", exitCode: null, stderr: [] };
    case "spawnFailed":
      return { ...state, process: "failed", pendingTurns: 0, turnStartedAt: null, turnId: null,
        items: [...state.items, { kind: "notice", id: `f-${state.items.length}`, tone: "error", text: action.message }] };
    case "stderr":
      return { ...state, stderr: [...state.stderr, action.line].slice(-40) };
    case "exit": {
      // Las peticiones pendientes ya no pueden responderse.
      const items = finalize(state.items).map(item =>
        item.kind === "permission" && item.state === "pending" ? { ...item, state: "denied" as const }
          : item.kind === "tool" && item.status === "running" ? { ...item, status: "error" as const } : item);
      return { ...state, items, process: "exited", exitCode: action.code, pendingTurns: 0, turnStartedAt: null, turnId: null,
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

/** Preguntas con opciones (AskUserQuestion de Claude o las preguntas de Codex). */
export function questionsOf(input: Json): Question[] {
  return list(input.questions).map(record).filter((question): question is Json => !!question && typeof question.question === "string")
    .map((question, index) => ({
      id: text(question.id) || String(index),
      question: text(question.question),
      header: text(question.header),
      multiSelect: question.multiSelect === true,
      options: list(question.options).map(record).filter((option): option is Json => !!option && typeof option.label === "string")
        .map(option => ({ label: text(option.label), description: text(option.description) })),
    }));
}

/** Respuesta elegida en una pregunta: opciones marcadas y texto libre. */
export const choiceAnswers = (choice: QuestionChoice): string[] => [...choice.selected, choice.other.trim()].filter(Boolean);

// --- Datos derivados ----------------------------------------------------------

export const pendingPermissions = (state: ChatState): number =>
  state.items.filter(item => item.kind === "permission" && item.state === "pending").length;

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

/** Frase corta para la fila de una herramienta, en presente o en pasado. */
export function describeTool(name: string, input: Json, cwd: string, running: boolean): ToolSummary {
  const path = (key: string): string => relativePath(text(input[key]), cwd);
  const verb = (live: string, done: string): string => running ? live : done;
  switch (name) {
    case "Read": return { icon: "read", verb: verb("Leyendo", "Leyó"), target: path("file_path") };
    case "Edit": case "MultiEdit": return { icon: "edit", verb: verb("Editando", "Editó"), target: path("file_path") };
    case "Write": return { icon: "edit", verb: verb("Escribiendo", "Escribió"), target: path("file_path") };
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

/** Niveles de esfuerzo que admite el modelo en uso. */
export const supportedEfforts = (models: ModelInfo[], model: string | null, choice: string | null): string[] =>
  (currentModel(models, model, choice)?.efforts ?? []).filter(level => EFFORT_LEVELS[level]);

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
