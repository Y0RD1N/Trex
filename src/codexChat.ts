import { browserResultArtifacts, browserToolResultText } from "./browser";
import { taskToolInput } from "./taskTools";
/**
 * Protocolo de Codex en modo chat (`codex app-server`).
 *
 * Codex habla JSON-RPC por líneas: trex abre o reanuda un hilo, empieza
 * turnos y responde a las peticiones de permiso; Codex avisa de cada elemento
 * del turno (mensajes, comandos, ediciones, planes). Este módulo traduce esos
 * mensajes al estado común del chat (`chatState`) y construye las líneas de
 * vuelta. No toca la interfaz ni el backend, así que se prueba sin Tauri.
 */
import {
  addNotice, baseReducer, choiceAnswers, clip, diffStats, finalize, list, liveCompletion, questionsOf, record, speedHint, text, unifiedDiffLines,
  type BaseChatAction, type ChatItem, type ChatState, type Json, type ModelInfo, type OutgoingImage,
  type PermissionItem, type QuestionChoice, type ToolItem, type ToolStatus,
} from "./chatState";
import { parseCodexSkills } from "./chatCommands";
import { parseCodexUsage } from "./planUsage";
import { imageReference, withoutImageLabels } from "./imageReferences";

export type CodexAction =
  | BaseChatAction
  /** Reserva local: todavía no participa en el turno del proveedor. */
  | (Extract<BaseChatAction, { type: "send" }> & { deferred: true })
  | { type: "sendIssued"; id: string; turnId?: string; now: number }
  | { type: "sendFailed"; id: string; message: string }
  | { type: "interruptIssued" }
  /** Notificación o petición del servidor. `scope` distingue procesos sucesivos. */
  | { type: "rpc"; message: unknown; scope: string; now: number }
  /** Respuesta a `thread/start` o `thread/resume`. */
  | { type: "thread"; response: unknown }
  | { type: "history"; turns: unknown[] }
  | { type: "models"; data: unknown; windows?: Record<string, number> }
  | { type: "skills"; data: unknown }
  | { type: "turnStarted"; turnId: string }
  /** Respuesta a `account/rateLimits/read`: el uso del plan de la cuenta. */
  | { type: "plan"; data: unknown }
  | { type: "turnFailed"; message: string }
  /** Preguntas respondidas: quedan en el hilo como en Claude Code. */
  | { type: "answered"; id: string; choices: QuestionChoice[] };

// --- Lanzamiento --------------------------------------------------------------

export type CodexLaunch = {
  /** Argumentos del proceso: el subcomando y las opciones de configuración. */
  flags: string[];
  /** Conversación indicada en el perfil (`resume <id>`). */
  resumeId: string | null;
  /** Ajustes del hilo que en la terminal serían opciones del CLI. */
  thread: Json;
  /** Opciones del perfil que el chat no usa. */
  ignored: string[];
};

/**
 * Sin esta función, Codex solo pregunta con opciones en el modo planificar; con
 * ella, también al trabajar. Codex la marca «en desarrollo» y avisa al arrancar.
 */
export const QUESTIONS_FEATURE = "default_mode_request_user_input";

const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
const APPROVALS = ["untrusted", "on-failure", "on-request", "never"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Separa los argumentos libres de un perfil respetando comillas, como el
 * backend. La barra invertida solo escapa dentro de comillas dobles (fuera es
 * parte de las rutas de Windows). Devuelve null si una comilla queda abierta.
 */
export function splitProfileArgs(input: string): string[] | null {
  const args: string[] = [];
  let current = "", started = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === "'") {
      const end = input.indexOf("'", index + 1);
      if (end === -1) return null;
      current += input.slice(index + 1, end);
      started = true;
      index = end;
    } else if (char === '"') {
      let end = index + 1;
      for (; end < input.length && input[end] !== '"'; end++) {
        if (input[end] === "\\" && (input[end + 1] === '"' || input[end + 1] === "\\")) end++;
        current += input[end];
      }
      if (end >= input.length) return null;
      started = true;
      index = end;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/**
 * Traduce los argumentos del perfil al servidor de Codex. Devuelve null si el
 * perfil pide algo que solo existe en la terminal (otro subcomando, un
 * servidor remoto, perfiles de configuración…).
 */
export function codexLaunch(profileArgs: string | null): CodexLaunch | null {
  const args = splitProfileArgs(profileArgs ?? "");
  if (!args) return null;
  const launch: CodexLaunch = { flags: ["app-server"], resumeId: null, thread: {}, ignored: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const value = (): string | null => inline ?? (index + 1 < args.length ? args[++index] : null);
    switch (name) {
      case "-c": case "--config": case "--enable": case "--disable": {
        const option = value();
        if (option === null) return null;
        launch.flags.push(name === "--config" ? "-c" : name, option);
        break;
      }
      case "--strict-config":
        launch.flags.push(name);
        break;
      case "-m": case "--model": {
        const model = value();
        if (!model) return null;
        launch.thread.model = model;
        break;
      }
      case "-s": case "--sandbox": {
        const sandbox = value();
        if (!sandbox || !SANDBOXES.includes(sandbox)) return null;
        launch.thread.sandbox = sandbox;
        break;
      }
      case "-a": case "--ask-for-approval": {
        const approval = value();
        if (!approval || !APPROVALS.includes(approval)) return null;
        launch.thread.approvalPolicy = approval;
        break;
      }
      case "--full-auto":
        Object.assign(launch.thread, { sandbox: "workspace-write", approvalPolicy: "on-request" });
        break;
      case "--dangerously-bypass-approvals-and-sandbox": case "--yolo":
        Object.assign(launch.thread, { sandbox: "danger-full-access", approvalPolicy: "never" });
        break;
      case "--search":
        launch.flags.push("-c", 'web_search="live"');
        break;
      case "-C": case "--cd": {
        const cwd = value();
        if (!cwd) return null;
        launch.thread.cwd = cwd;
        break;
      }
      case "--no-alt-screen": case "--no-daemon":
        break;
      case "-i": case "--image": case "--add-dir":
        launch.ignored.push(`${name} ${value() ?? ""}`.trim());
        break;
      case "resume": {
        if (index !== 0) return null;
        const id = args[index + 1];
        if (id && UUID.test(id)) { launch.resumeId = id; index++; }
        else if (id === "--last") index++;
        break;
      }
      default:
        // Otros subcomandos, mensajes iniciales u opciones solo de la terminal.
        return null;
    }
  }
  // Las preguntas con opciones se responden en el chat, salvo que el perfil las apague.
  if (!launch.flags.some((flag, index) => index > 0 && flag === QUESTIONS_FEATURE && /^--(en|dis)able$/.test(launch.flags[index - 1]))) {
    launch.flags.push("--enable", QUESTIONS_FEATURE);
  }
  return launch;
}

/**
 * Aviso de funciones «en desarrollo» sin la que activa trex para las preguntas:
 * null si solo hablaba de ella.
 */
export function visibleWarning(message: string): string | null {
  const match = /^(Under-development features enabled: )([^.]+)\./.exec(message);
  if (!match) return message;
  const others = match[2].split(/,\s*/).filter(feature => feature.trim() && feature.trim() !== QUESTIONS_FEATURE);
  return others.length ? message.replace(match[2], others.join(", ")) : null;
}

/** El perfil puede abrirse como chat. */
export const codexChatSupported = (profileArgs: string | null): boolean => codexLaunch(profileArgs) !== null;

// --- Mensajes hacia Codex -----------------------------------------------------

export const requestLine = (id: number, method: string, params: unknown): string => JSON.stringify({ id, method, params });
export const notificationLine = (method: string, params?: unknown): string =>
  JSON.stringify(params === undefined ? { method } : { method, params });
export const resultLine = (id: string | number, result: unknown): string => JSON.stringify({ id, result });
export const errorLine = (id: string | number, message: string, code = -32601): string => JSON.stringify({ id, error: { code, message } });

/** Notificaciones que el chat no usa: se piden apagadas para no recibirlas. */
export const OPT_OUT_NOTIFICATIONS = [
  "hook/started", "hook/completed", "mcpServer/startupStatus/updated", "remoteControl/status/changed",
  "rawResponseItem/completed", "rawResponse/completed", "app/list/updated", "fs/changed", "deprecationNotice",
  "thread/started", "item/commandExecution/terminalInteraction",
];

export function userInput(value: string, images: OutgoingImage[] = [], skills: { name: string; path: string }[] = []): Json[] {
  return [
    ...images.flatMap((image, index) => [
      { type: "text", text: imageReference(index), text_elements: [] },
      { type: "image", url: `data:${image.mediaType};base64,${image.data}` },
    ]),
    ...(value ? [{ type: "text", text: value, text_elements: [] }] : []),
    // Las skills nombradas con `$nombre` se adjuntan para que Codex cargue sus instrucciones.
    ...skills.map(skill => ({ type: "skill", name: skill.name, path: skill.path })),
  ];
}

/** Mensaje de `/init`: el mismo encargo que hace la terminal de Codex. */
export const INIT_PROMPT = [
  "Genera un archivo AGENTS.md en la raíz del repositorio que sirva de guía para quien contribuya, sea una persona o un agente.",
  "Explora el proyecto y documenta de forma breve y concreta: estructura y módulos principales; cómo instalar, compilar, ejecutar y probar;",
  "convenciones de estilo y de nombres; cómo escribir y ejecutar los tests; y pautas para commits y pull requests.",
  "Usa títulos en Markdown, sé específico de este repositorio y evita las generalidades. Si ya existe un AGENTS.md, mejóralo en lugar de reemplazarlo.",
].join(" ");

// --- Modos de permisos --------------------------------------------------------

const SANDBOX_POLICIES: Record<string, Json> = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  "danger-full-access": { type: "dangerFullAccess" },
};

/**
 * Ajustes del siguiente turno según lo elegido en el chat. Los modos son los
 * preajustes de Codex: solo lectura, automático, acceso total y planificar.
 */
export function turnOverrides(choices: { mode: string | null; model: string | null; effort: string | null; fast?: boolean | null },
  current: { model: string | null; effort: string | null; fastTier?: string | null }): Json {
  const overrides: Json = {};
  if (choices.model) overrides.model = choices.model;
  if (choices.effort) overrides.effort = choices.effort;
  // El nivel de servicio queda en el hilo; «default» es la velocidad estándar.
  if (typeof choices.fast === "boolean") overrides.serviceTier = choices.fast && current.fastTier ? current.fastTier : "default";
  if (choices.mode) {
    const sandbox = choices.mode === "read-only" ? "read-only" : choices.mode === "full" ? "danger-full-access" : "workspace-write";
    overrides.sandboxPolicy = SANDBOX_POLICIES[sandbox];
    overrides.approvalPolicy = choices.mode === "full" ? "never" : "on-request";
    // El modo plan es un modo de colaboración y lleva consigo el modelo y el esfuerzo.
    const model = choices.model ?? current.model;
    if (model) {
      overrides.collaborationMode = { mode: choices.mode === "plan" ? "plan" : "default",
        settings: { model, reasoning_effort: choices.effort ?? current.effort, developer_instructions: null } };
    }
  }
  return overrides;
}

/** Velocidad del hilo según su nivel de servicio: cualquiera distinto del estándar es la rápida. */
const isFastTier = (tier: unknown): boolean => typeof tier === "string" && tier !== "" && tier !== "default";

/** Modo que corresponde a los ajustes reales del hilo. */
function modeOf(settings: Json): string | null {
  if (record(settings.collaborationMode)?.mode === "plan") return "plan";
  const sandbox = record(settings.sandboxPolicy) ?? record(settings.sandbox);
  const type = text(sandbox?.type) || text(settings.sandbox);
  if (!type) return null;
  // Sin límites del sandbox pero pidiendo permiso no es «Permitir todo».
  const asks = settings.approvalPolicy !== undefined && settings.approvalPolicy !== "never";
  if (type === "dangerFullAccess" || type === "danger-full-access") return asks ? "auto" : "full";
  if (type === "readOnly" || type === "read-only") return "read-only";
  return "auto";
}

// --- Respuestas a las peticiones de Codex -------------------------------------

/** Peticiones de permiso (no preguntas) que se aceptan solas con «Permitir todo». */
const APPROVAL_REQUESTS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]);

/** Respuesta que acepta un permiso sin mostrar la tarjeta; null si la petición no es un permiso. */
export function autoApproval(method: string, params: Json): Json | null {
  if (!APPROVAL_REQUESTS.has(method)) return null;
  const item = { request: { id: 0, method }, input: { availableDecisions: params.availableDecisions ?? [], permissions: params.permissions ?? {} } };
  return answerResult(item as unknown as PermissionItem, true, false);
}

/** Lo que espera Codex como respuesta a una tarjeta de permiso o de preguntas. */
export function answerResult(item: PermissionItem, allowed: boolean, remember: boolean, choices: QuestionChoice[] = []): Json {
  const method = item.request?.method ?? "";
  const decisions = list(item.input.availableDecisions);
  const offers = (decision: string): boolean => !decisions.length || decisions.some(entry => entry === decision || !!record(entry)?.[decision]);
  if (method === "item/tool/requestUserInput") {
    const answers: Json = {};
    const questions = list(item.input.questions).map(record);
    // Las preguntas que se dejaron sin responder no se mandan.
    choices.forEach((choice, index) => {
      const id = text(questions[index]?.id) || String(index);
      const values = choiceAnswers(choice);
      if (allowed && values.length) answers[id] = { answers: values };
    });
    return { answers };
  }
  if (method === "item/permissions/requestApproval") {
    return allowed ? { permissions: record(item.input.permissions) ?? {}, scope: remember ? "session" : "turn" } : { permissions: {}, scope: "turn" };
  }
  if (!allowed) return { decision: offers("decline") ? "decline" : "cancel" };
  if (!remember) return { decision: "accept" };
  if (offers("acceptForSession")) return { decision: "acceptForSession" };
  const amendment = decisions.map(record).find(entry => entry?.acceptWithExecpolicyAmendment);
  return amendment ? { decision: amendment } : { decision: "accept" };
}

/** Opción de «permitir siempre» que admite la petición. */
function rememberOption(method: string, params: Json): unknown[] {
  if (method === "item/fileChange/requestApproval") return [{ type: "session", label: "Permitir ediciones en esta sesión" }];
  if (method === "item/permissions/requestApproval") return [{ type: "session", label: "Permitir en esta sesión" }];
  const decisions = list(params.availableDecisions);
  if (!decisions.length || decisions.includes("acceptForSession")) return [{ type: "session", label: "Permitir en esta sesión" }];
  if (decisions.some(entry => record(entry)?.acceptWithExecpolicyAmendment)) return [{ type: "rule", label: "Permitir siempre este comando" }];
  return [];
}

// --- Elementos del hilo -------------------------------------------------------

/** Quita el envoltorio del shell (`/bin/zsh -lc "…"`) para mostrar el comando. */
export function shellCommand(command: string): string {
  const wrapped = /^\S*?(?:ba|z|da|k)?sh\S*\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  if (!wrapped) return command;
  return wrapped[1] === "'" ? wrapped[2].replace(/'\\''/g, "'") : wrapped[2].replace(/\\(["\\$`])/g, "$1");
}

const TOOL_STATUS: Record<string, ToolStatus> = { inProgress: "running", completed: "done", failed: "error", declined: "error" };

/** Comando como herramienta: lecturas y búsquedas se muestran como tales. */
function commandTool(item: Json): ToolItem {
  const actions = list(item.commandActions).map(record).filter((action): action is Json => !!action);
  const command = actions.map(action => text(action.command)).filter(Boolean).join(" && ") || shellCommand(text(item.command));
  const every = (type: string): boolean => actions.length > 0 && actions.every(action => action.type === type);
  const [name, input]: [string, Json] = every("read") ? ["Read", { file_path: actions.map(action => text(action.path) || text(action.name)).join(", "), command }]
    : every("search") ? ["Grep", { pattern: text(actions[0].query) || command, path: text(actions[0].path), command }]
    : every("listFiles") ? ["LS", { path: text(actions[0].path) || ".", command }]
    : ["Bash", { command }];
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  let status = TOOL_STATUS[text(item.status)] ?? "running";
  if (status === "done" && exitCode !== null && exitCode !== 0) status = "error";
  const output = typeof item.aggregatedOutput === "string" ? clip(item.aggregatedOutput) : item.status === "declined" ? "Denegado." : null;
  return { kind: "tool", id: text(item.id), name, input, status, output, patch: null };
}

/** Una fila por archivo editado. */
function fileTools(item: Json): ToolItem[] {
  const changes = list(item.changes).map(record).filter((change): change is Json => !!change);
  const status = TOOL_STATUS[text(item.status)] ?? "running";
  return changes.map((change, index) => {
    const kind = record(change.kind) ?? {};
    const destination = text(kind.move_path);
    const fullDiff = unifiedDiffLines(text(change.diff), kind.type === "delete" ? "del" : "add", Number.MAX_SAFE_INTEGER);
    const name = kind.type === "add" ? "Write" : kind.type === "delete" ? "Delete" : destination ? "Move" : "Edit";
    return {
      kind: "tool", id: changes.length === 1 ? text(item.id) : `${text(item.id)}#${index}`, name,
      input: { file_path: text(change.path), changeKind: text(kind.type), ...(destination ? { destination } : {}) }, status,
      output: item.status === "declined" ? "Denegado." : null,
      patch: unifiedDiffLines(text(change.diff), kind.type === "delete" ? "del" : "add"),
      changeStats: diffStats(fullDiff),
    };
  });
}

const mcpOutput = (item: Json): string | null => {
  const error = text(record(item.error)?.message);
  if (error) return error;
  const content = list(record(item.result)?.content).map(record).map(block => block?.type === "text" ? text(block.text) : block?.type ? `[${text(block.type)}]` : "")
    .filter(Boolean).join("\n");
  return content ? clip(content) : null;
};

/** Elemento del hilo → herramientas del chat (vacío si no es una herramienta). */
function itemTools(item: Json): ToolItem[] {
  const id = text(item.id);
  const status = TOOL_STATUS[text(item.status)] ?? "done";
  switch (item.type) {
    case "commandExecution": return [commandTool(item)];
    case "fileChange": return fileTools(item);
    case "mcpToolCall": {
      const input = record(item.arguments) ?? {};
      const name = `mcp__${text(item.server)}__${text(item.tool)}`;
      const failed = !!item.error || record(item.result)?.isError === true;
      const taskInput = !failed && status === "done" && record(item.result) ? taskToolInput(name, input) : null;
      return [{ kind: "tool", id, name: taskInput ? "TodoWrite" : name, input: taskInput ?? input, status: failed ? "error" : status, output: (item.server === "trex_browser" || item.server === "trex_desktop") && !item.error ? browserToolResultText(record(item.result)?.content ?? item.result) : mcpOutput(item), patch: null, ...((item.server === "trex_browser" || item.server === "trex_desktop") ? { artifacts: browserResultArtifacts(item.result) } : {}) }];
    }
    case "dynamicToolCall": {
      const output = list(item.contentItems).map(record).map(entry => text(entry?.text)).filter(Boolean).join("\n");
      return [{ kind: "tool", id, name: text(item.tool) || "Herramienta", input: record(item.arguments) ?? {},
        status: item.success === false ? "error" : status, output: output || null, patch: null }];
    }
    case "webSearch": {
      const action = record(item.action) ?? {};
      return action.type === "openPage" || action.type === "findInPage"
        ? [{ kind: "tool", id, name: "WebFetch", input: { url: text(action.url) }, status: "done", output: null, patch: null }]
        : [{ kind: "tool", id, name: "WebSearch", input: { query: text(item.query) || text(action.query) }, status: item.query ? "done" : "running", output: null, patch: null }];
    }
    case "imageView":
      return [{ kind: "tool", id, name: "ViewImage", input: { file_path: text(item.path) }, status: "done", output: null, patch: null }];
    case "collabAgentToolCall": {
      const prompt = text(item.prompt);
      return [{ kind: "tool", id, name: "Task", input: { description: prompt.split("\n")[0].slice(0, 120) || text(item.tool), prompt }, status, output: null, patch: null }];
    }
    case "plan":
      return [{ kind: "tool", id, name: "ExitPlanMode", input: { plan: text(item.text) }, status: "done", output: null, patch: null }];
    default:
      return [];
  }
}

function upsert(items: ChatItem[], next: ChatItem): ChatItem[] {
  const index = items.findIndex(item => item.kind === next.kind && item.id === next.id);
  if (index === -1) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}

const reasoningText = (item: Json): string =>
  (list(item.summary).map(text).filter(Boolean).join("\n\n") || list(item.content).map(text).filter(Boolean).join("\n\n")).trim();

/** Contenido de un mensaje del usuario guardado en el hilo. */
function userItem(item: Json): ChatItem | null {
  const content = withoutImageLabels(list(item.content).map(record).filter((part): part is Json => !!part));
  const typed = content.filter(part => part.type === "text").map(part => text(part.text)).join("\n\n").trim();
  const images = content.filter(part => part.type === "image" || part.type === "localImage");
  const previews = images.map(part => text(part.url)).filter(url => url.startsWith("data:image/"));
  if (!typed && !images.length) return null;
  return { kind: "user", id: text(item.id), text: typed, images: images.length, previews };
}

/** Marca de los textos que cierran una revisión (`/review`). */
const REVIEW = "review";

/**
 * Elemento empezado, terminado o guardado en el historial. Los mensajes del
 * usuario en directo ya están en el hilo (los añade el chat al enviarlos).
 */
function applyItem(items: ChatItem[], item: Json, phase: "started" | "completed" | "history"): ChatItem[] {
  const id = text(item.id);
  switch (item.type) {
    case "userMessage": {
      const user = phase === "history" ? userItem(item) : null;
      return user ? [...items, user] : items;
    }
    case "agentMessage": {
      const value = text(item.text);
      // El resultado de una revisión llega dos veces (fin de la revisión y mensaje): se queda el primero.
      if (phase !== "started" && value.trim() && items.some(entry => entry.kind === "text" && entry.messageId === REVIEW && entry.text.trim() === value.trim())) {
        return items.filter(entry => !(entry.kind === "text" && entry.id === id));
      }
      const current = items.find(entry => entry.kind === "text" && entry.id === id);
      if (phase === "started" && !value && current) return items;
      return upsert(items, { kind: "text", id, messageId: id, text: value || (current?.kind === "text" ? current.text : ""), final: phase !== "started" });
    }
    case "reasoning": {
      const value = reasoningText(item);
      const current = items.find(entry => entry.kind === "thinking" && entry.id === id);
      if (phase === "started" && !value && current) return items;
      return upsert(items, { kind: "thinking", id, messageId: id, text: value || (current?.kind === "thinking" ? current.text : ""), final: phase !== "started" });
    }
    case "contextCompaction":
      return phase === "started" ? items : addNotice(items, "info", "Conversación resumida para liberar contexto.", "c");
    case "enteredReviewMode":
      return phase === "completed" || phase === "history" ? addNotice(items, "info", "Codex empezó a revisar los cambios.", "rv") : items;
    case "exitedReviewMode": {
      const review = text(item.review).trim();
      const shown = items.some(entry => entry.kind === "text" && entry.id !== id && entry.text.trim() === review);
      return review && !shown && phase !== "started" ? upsert(items, { kind: "text", id, messageId: REVIEW, text: review, final: true }) : items;
    }
    default: {
      let next = items;
      for (const tool of itemTools(item)) {
        const current = next.find(entry => entry.kind === "tool" && entry.id === tool.id);
        // La salida en directo se conserva hasta que llega la definitiva.
        const output = tool.output ?? (current?.kind === "tool" ? current.output : null);
        next = upsert(next, { ...tool, output, status: phase === "history" && tool.status === "running" ? "done" : tool.status });
      }
      return next;
    }
  }
}

/** Añade texto en directo a un elemento que crece por partes. */
function appendDelta(items: ChatItem[], id: string, kind: "text" | "thinking" | "tool" | "plan", delta: string): ChatItem[] {
  if (!delta) return items;
  const target = kind === "plan" ? "tool" : kind;
  const index = items.findIndex(item => item.kind === target && item.id === id);
  if (index === -1) {
    if (kind === "text" || kind === "thinking") return [...items, { kind, id, messageId: id, text: delta, final: false }];
    if (kind === "plan") return [...items, { kind: "tool", id, name: "ExitPlanMode", input: { plan: delta }, status: "running", output: null, patch: null }];
    return items;
  }
  const current = items[index];
  const copy = [...items];
  if ((current.kind === "text" || current.kind === "thinking") && !current.final) {
    copy[index] = { ...current, text: current.text + delta };
  } else if (current.kind === "tool" && kind === "plan") {
    copy[index] = { ...current, input: { plan: text(current.input.plan) + delta } };
  } else if (current.kind === "tool" && current.status === "running") {
    copy[index] = { ...current, output: clip((current.output ?? "") + delta) };
  } else return items;
  return copy;
}

/** Lista de tareas del turno (herramienta update_plan), como la de Claude. */
function planTodos(items: ChatItem[], params: Json): ChatItem[] {
  const todos = list(params.plan).map(record).filter((step): step is Json => !!step && typeof step.step === "string")
    .map(step => ({ content: text(step.step), status: step.status === "completed" ? "completed" : step.status === "inProgress" ? "in_progress" : "pending" }));
  if (!todos.length) return items;
  return upsert(items, { kind: "tool", id: `todos-${text(params.turnId)}`, name: "TodoWrite", input: { todos }, status: "done", output: null, patch: null });
}

function completeTurn(state: ChatState, turn: Json, now: number): ChatState {
  const turnId = text(turn.id);
  // Sin identidad no se puede distinguir un terminal atrasado del turno en curso.
  if (!turnId) return state;
  const completedId = `codex:${turnId}`;
  if (state.completedTurnIds.includes(completedId)) return state;
  if (turnId && state.turnId && state.turnId !== turnId) return state;
  const bound = state.items.filter(item => item.kind === "user" && state.pendingMessageIds.includes(item.id) && item.providerTurnId);
  if (bound.length && !bound.some(item => item.kind === "user" && item.providerTurnId === turnId)) return state;
  const consumed = issuedMessages(state, turnId);
  if (!consumed.length && state.turnId !== turnId) return state;
  const pendingMessageIds = state.pendingMessageIds.filter(id => !consumed.includes(id));
  const status = text(turn.status);
  const interrupted = ["interrupted", "cancelled", "canceled"].includes(status)
    || consumed.some(id => state.interruptedMessageIds.includes(id));
  const failed = !interrupted && (status !== "completed" || !!turn.error);
  let items = finalize(state.items).map(item =>
    item.kind === "tool" && item.status === "running" ? { ...item, status: interrupted || failed ? "error" as const : "done" as const }
      : item.kind === "permission" && item.state === "pending" ? { ...item, state: "denied" as const } : item);
  if (interrupted) items = addNotice(items, "info", "Detenido. Puedes seguir escribiendo.", "i");
  else if (failed) {
    const error = record(turn.error);
    const message = [text(error?.message), text(error?.additionalDetails)].filter(Boolean).join("\n") || "Codex no pudo completar la respuesta.";
    items = addNotice(items, "error", message, "e");
  } else if ((consumed.length || !state.pendingMessageIds.length) && (state.turnStartedAt !== null || typeof turn.durationMs === "number")) {
    const durationMs = typeof turn.durationMs === "number" ? turn.durationMs : now - (state.turnStartedAt ?? now);
    items = [...items, { kind: "turn", id: `t-${text(turn.id) || items.length}`, durationMs,
      ...(state.turnDiff !== null ? { diff: state.turnDiff } : {}) }];
  }
  return { ...state, items, pendingTurns: pendingMessageIds.length ? 1 : 0, pendingMessageIds,
    activeMessageIds: state.activeMessageIds.filter(id => !consumed.includes(id)),
    interruptedMessageIds: state.interruptedMessageIds.filter(id => !consumed.includes(id)), turnStartedAt: null, turnId: null, turnDiff: null,
    completedTurnIds: [...state.completedTurnIds, completedId], turnItemStart: null,
    lastCompletion: liveCompletion(state, completedId, interrupted ? "interrupted" : failed ? "failed" : "completed", consumed, items) };
}

/** Un terminal solo consume mensajes emitidos para ese turno, nunca reservas locales. */
function issuedMessages(state: ChatState, turnId: string): string[] {
  return state.pendingMessageIds.filter(id => {
    const item = state.items.find(item => item.kind === "user" && item.id === id);
    return item?.kind === "user" && (state.activeMessageIds.includes(id) || item.providerTurnId === turnId)
      && (!item.providerTurnId || item.providerTurnId === turnId);
  });
}

/** Petición del servidor que necesita respuesta de la persona. */
function applyRequest(state: ChatState, message: Json, scope: string): ChatState {
  const method = text(message.method);
  const params = record(message.params) ?? {};
  const rpcId = message.id as string | number;
  const id = `${scope}:${String(rpcId)}`;
  if (state.items.some(item => item.kind === "permission" && item.id === id)) return state;
  const itemId = text(params.itemId) || null;
  const base = { kind: "permission" as const, id, toolUseId: itemId, state: "pending" as const, request: { id: rpcId, method },
    description: text(params.reason), suggestions: rememberOption(method, params) };
  let permission: PermissionItem;
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = list(params.commandActions).map(record).map(action => text(action?.command)).filter(Boolean).join(" && ")
        || shellCommand(text(params.command));
      permission = { ...base, toolName: "Bash", input: { command, availableDecisions: params.availableDecisions ?? [] } };
      break;
    }
    case "item/fileChange/requestApproval": {
      const raw = state.items.filter(item => item.kind === "tool" && (item.id === itemId || item.id.startsWith(`${itemId}#`))) as ToolItem[];
      const files = raw.map(tool => text(tool.input.file_path));
      const patch = raw.flatMap((tool, index) => [
        ...(raw.length > 1 ? [{ kind: "gap" as const, text: files[index] }] : []), ...(tool.patch ?? [])]);
      permission = { ...base, toolName: raw.length === 1 && raw[0].name === "Write" ? "Write" : "Edit",
        input: { file_path: files.length > 1 ? `${files.length} archivos` : files[0] ?? text(params.grantRoot) }, patch: patch.length ? patch : null };
      break;
    }
    case "item/tool/requestUserInput": {
      // Sin opciones es una pregunta abierta; `isOther` dice si admite otra respuesta y `isSecret`, si no debe verse.
      const questions = list(params.questions).map(record).filter((question): question is Json => !!question).map(question => ({
        id: text(question.id), header: text(question.header), question: text(question.question), multiSelect: false,
        options: list(question.options).map(record).filter((option): option is Json => !!option)
          .map(option => ({ label: text(option.label), description: text(option.description) })),
        isOther: question.isOther !== false, isSecret: question.isSecret === true,
      }));
      permission = { ...base, toolName: "AskUserQuestion", input: { questions } };
      break;
    }
    case "item/permissions/requestApproval":
      permission = { ...base, toolName: "Permissions", input: { permissions: params.permissions ?? {}, cwd: text(params.cwd) } };
      break;
    default:
      return state;
  }
  return { ...state, items: [...state.items, permission] };
}

/** Avisos que conviene ver: límites de uso, cambios de modelo, advertencias. */
function applyNotification(state: ChatState, method: string, params: Json, now: number): ChatState {
  switch (method) {
    case "turn/started": {
      const turn = record(params.turn) ?? {};
      if (state.completedTurnIds.includes(`codex:${text(turn.id)}`)) return state;
      if (state.turnId && text(turn.id) && state.turnId !== turn.id) return state;
      return { ...state, turnId: text(turn.id) || state.turnId, pendingTurns: Math.max(1, state.pendingTurns), turnStartedAt: state.turnStartedAt ?? now };
    }
    case "turn/completed":
      return completeTurn(state, record(params.turn) ?? {}, now);
    case "turn/diff/updated":
      return typeof params.diff === "string" ? { ...state, turnDiff: params.diff } : state;
    case "item/started": case "item/completed": {
      const item = record(params.item);
      return item ? { ...state, items: applyItem(state.items, item, method === "item/started" ? "started" : "completed") } : state;
    }
    case "item/agentMessage/delta":
      return { ...state, items: appendDelta(state.items, text(params.itemId), "text", text(params.delta)) };
    case "item/reasoning/summaryTextDelta": case "item/reasoning/textDelta":
      return { ...state, items: appendDelta(state.items, text(params.itemId), "thinking", text(params.delta)) };
    case "item/reasoning/summaryPartAdded": {
      // Cada parte del resumen es un párrafo nuevo.
      const current = state.items.find(item => item.kind === "thinking" && item.id === text(params.itemId));
      return current?.kind === "thinking" && current.text.trim() ? { ...state, items: appendDelta(state.items, current.id, "thinking", "\n\n") } : state;
    }
    case "item/plan/delta":
      return { ...state, items: appendDelta(state.items, text(params.itemId), "plan", text(params.delta)) };
    case "item/commandExecution/outputDelta":
      return { ...state, items: appendDelta(state.items, text(params.itemId), "tool", text(params.delta)) };
    case "turn/plan/updated":
      return { ...state, items: planTodos(state.items, params) };
    case "serverRequest/resolved":
      // Respondida o retirada por Codex (por ejemplo, al detener el turno).
      return { ...state, items: state.items.map(item => item.kind === "permission" && item.state === "pending"
        && item.request && String(item.request.id) === String(params.requestId) ? { ...item, state: "denied" as const } : item) };
    case "thread/settings/updated": {
      const settings = record(params.threadSettings) ?? {};
      // Lo elegido en el chat se aplica en el siguiente turno: hasta entonces el hilo puede traer el modo anterior.
      return { ...state, model: text(settings.model) || state.model, effort: text(settings.effort) || state.effort,
        fast: state.fastChoice ?? (settings.serviceTier === undefined ? state.fast : isFastTier(settings.serviceTier)),
        permissionMode: state.modeChoice ?? modeOf(settings) ?? state.permissionMode };
    }
    case "thread/tokenUsage/updated": {
      const usage = record(params.tokenUsage) ?? {};
      const tokens = (breakdown: Json | null): number | null => !breakdown ? null
        : typeof breakdown.totalTokens === "number" ? breakdown.totalTokens
        : typeof breakdown.inputTokens === "number" ? breakdown.inputTokens + (typeof breakdown.outputTokens === "number" ? breakdown.outputTokens : 0) : null;
      // La última petición al modelo es lo que ocupa ahora la conversación en la ventana.
      const used = tokens(record(usage.last));
      return used === null ? state : { ...state, usage: { used, parts: [], reserve: null, total: tokens(record(usage.total)),
        window: typeof usage.modelContextWindow === "number" && usage.modelContextWindow > 0 ? usage.modelContextWindow : state.usage?.window ?? null } };
    }
    case "thread/compacted":
      return { ...state, items: addNotice(state.items, "info", "Conversación resumida para liberar contexto.", "c") };
    case "model/rerouted":
      return { ...state, model: text(params.toModel) || state.model,
        items: addNotice(state.items, "info", `Codex cambió de ${text(params.fromModel)} a ${text(params.toModel)} para esta respuesta.`, "m") };
    case "error": {
      if (params.willRetry === true) return state;
      const error = record(params.error) ?? {};
      const turnId = text(params.turnId) || state.turnId;
      return { ...state, items: addNotice(state.items, "error", text(error.message) || "Codex informó de un error.", "e"),
        lastCompletion: params.willRetry === false && turnId && turnId === state.turnId
          ? liveCompletion(state, `codex:${turnId}`, "failed", issuedMessages(state, turnId)) : state.lastCompletion };
    }
    case "warning": {
      const message = visibleWarning(text(params.message));
      return message ? { ...state, items: addNotice(state.items, "warn", message, "w") } : state;
    }
    case "configWarning":
      return { ...state, items: addNotice(state.items, "warn", [text(params.summary), text(params.details)].filter(Boolean).join("\n"), "w") };
    case "account/rateLimits/updated": {
      const limits = record(params.rateLimits) ?? {};
      state = { ...state, plan: parseCodexUsage(params, state.plan) };
      if (!limits.rateLimitReachedType) return state;
      const reset = record(limits.primary)?.resetsAt;
      const time = typeof reset === "number" ? new Date(reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
      return { ...state, items: addNotice(state.items, "warn",
        time ? `Alcanzaste el límite de uso de Codex. Se restablece a las ${time}.` : "Alcanzaste el límite de uso de Codex.", "r") };
    }
    default:
      return state;
  }
}

// --- Catálogo de modelos ------------------------------------------------------

/** Catálogo de `model/list`; `windows` son las ventanas de contexto de la caché de Codex. */
export function parseCodexModels(raw: unknown, windows: Record<string, number> = {}): ModelInfo[] {
  return list(raw).map(record).filter((model): model is Json => !!model && !!text(model.id) && model.hidden !== true)
    .map(model => ({
      value: text(model.model) || text(model.id),
      resolvedModel: text(model.model) || text(model.id),
      displayName: text(model.displayName) || text(model.id),
      description: text(model.description),
      efforts: list(model.supportedReasoningEfforts).map(record).map(option => text(option?.reasoningEffort)).filter(Boolean),
      featured: true,
      defaultEffort: text(model.defaultReasoningEffort) || undefined,
      contextWindow: windows[text(model.model) || text(model.id)] || undefined,
      fast: fastSpeedOf(model),
    }));
}

/** Nivel de servicio rápido del modelo (`serviceTiers`; antes, `additionalSpeedTiers`). */
function fastSpeedOf(model: Json): ModelInfo["fast"] {
  const tier = list(model.serviceTiers).map(record).find(entry => isFastTier(entry?.id));
  if (tier) return { tier: text(tier.id), hint: speedHint(text(tier.description)) };
  return list(model.additionalSpeedTiers).includes("fast") ? { tier: "fast", hint: speedHint("") } : undefined;
}

// --- Reductor -----------------------------------------------------------------

export function codexReducer(state: ChatState, action: CodexAction): ChatState {
  switch (action.type) {
    case "rpc": {
      const message = record(action.message);
      if (!message) return state;
      const params = record(message.params) ?? {};
      if ((message.method === "turn/completed" || message.method === "turn/started")
        && text(params.threadId) && state.sessionId && params.threadId !== state.sessionId) return state;
      if (message.id !== undefined && message.id !== null && typeof message.method === "string") return applyRequest(state, message, action.scope);
      if (typeof message.method !== "string") return state;
      return applyNotification(state, message.method, params, action.now);
    }
    case "thread": {
      const response = record(action.response) ?? {};
      const thread = record(response.thread) ?? {};
      // Lo elegido en el chat manda: se aplica en el siguiente turno aunque el hilo nuevo traiga otro valor.
      return { ...state, sessionId: text(thread.id) || state.sessionId,
        model: (state.modelChoice ? state.model : text(response.model)) || state.model,
        effort: state.effortChoice ?? (text(response.reasoningEffort) || state.effort),
        fast: state.fastChoice ?? isFastTier(response.serviceTier),
        permissionMode: state.modeChoice ?? modeOf(response) ?? state.permissionMode };
    }
    case "history": {
      let items: ChatItem[] = [];
      const completedTurnIds = new Set(state.completedTurnIds);
      for (const raw of action.turns) {
        const turn = record(raw);
        if (!turn) continue;
        if (text(turn.id) && ["completed", "interrupted", "failed", "cancelled", "canceled"].includes(text(turn.status))) {
          completedTurnIds.add(`codex:${text(turn.id)}`);
        }
        const start = items.length;
        for (const item of list(turn.items).map(record)) if (item) items = applyItem(items, item, "history");
        items = items.map((item, index) => index >= start && item.kind === "user"
          ? { ...item, providerTurnId: text(turn.id) } : item);
        if (turn.status === "completed") items.push({ kind: "turn", id: `t-${text(turn.id) || items.length}`,
          durationMs: typeof turn.durationMs === "number" ? turn.durationMs : 0 });
        if (turn.status === "interrupted") items = addNotice(items, "info", "Detenido.", "i");
      }
      items = finalize(items);
      // Sustituye un historial anterior en vez de repetirlo.
      return { ...state, items: [...items, ...state.items.slice(state.historyCount)], historyCount: items.length,
        completedTurnIds: [...completedTurnIds],
        turnItemStart: state.turnItemStart === null ? null : state.turnItemStart + items.length - state.historyCount };
    }
    case "models": {
      const models = parseCodexModels(action.data, action.windows);
      return models.length ? { ...state, models } : state;
    }
    case "skills":
      return { ...state, skills: parseCodexSkills(action.data) };
    case "turnStarted":
      return state.pendingTurns > 0 && !state.completedTurnIds.includes(`codex:${action.turnId}`)
        && (!state.turnId || state.turnId === action.turnId) ? { ...state, turnId: action.turnId } : state;
    case "plan":
      return { ...state, plan: parseCodexUsage(action.data, state.plan) };
    case "turnFailed":
      return { ...state, pendingTurns: 0, pendingMessageIds: [], activeMessageIds: [], turnStartedAt: null, turnId: null, turnItemStart: null,
        completedTurnIds: state.turnId && !state.completedTurnIds.includes(`codex:${state.turnId}`)
          ? [...state.completedTurnIds, `codex:${state.turnId}`] : state.completedTurnIds,
        lastCompletion: liveCompletion(state, `codex:failed:${state.turnId ?? JSON.stringify(state.pendingMessageIds)}`, "failed", state.pendingMessageIds),
        items: addNotice(state.items, "error", action.message, "e") };
    case "interruptIssued":
      return state.activeMessageIds.reduce((next, id) => baseReducer(next, { type: "interruptSend", id }), state);
    case "sendIssued": {
      if (!state.pendingMessageIds.includes(action.id)) return state;
      const next = action.turnId ? baseReducer(state, { type: "bindTurn", id: action.id, turnId: action.turnId }) : state;
      return { ...next, activeMessageIds: next.activeMessageIds.includes(action.id) ? next.activeMessageIds : [...next.activeMessageIds, action.id],
        turnStartedAt: next.turnStartedAt ?? action.now, turnItemStart: next.turnItemStart ?? next.items.length };
    }
    case "sendFailed": {
      const items = addNotice(state.items.map(item => item.kind === "user" && item.id === action.id
        ? { ...item, providerTurnId: undefined } : item), "error", action.message, "e");
      if (!state.pendingMessageIds.includes(action.id)) {
        // Un terminal puede llegar antes del rechazo de un steer ya emitido.
        // Corrige solo esa entrega; el turno nativo y las reservas nuevas siguen liquidados.
        const previous = state.lastCompletion;
        return { ...state, items, lastCompletion: previous?.status === "completed" && previous.messageIds.includes(action.id)
          ? { id: `codex:send-failed:${action.id}`, status: "failed", messageIds: [action.id], itemIds: [] } : previous };
      }
      const pendingMessageIds = state.pendingMessageIds.filter(id => id !== action.id);
      return { ...state, pendingMessageIds, pendingTurns: pendingMessageIds.length || state.turnId ? 1 : 0,
        activeMessageIds: state.activeMessageIds.filter(id => id !== action.id),
        interruptedMessageIds: state.interruptedMessageIds.filter(id => id !== action.id),
        turnStartedAt: pendingMessageIds.length || state.turnId ? state.turnStartedAt : null,
        turnItemStart: pendingMessageIds.length || state.turnId ? state.turnItemStart : null,
        lastCompletion: liveCompletion(state, `codex:send-failed:${action.id}`, "failed", [action.id]),
        items };
    }
    case "answered": {
      const index = state.items.findIndex(item => item.kind === "permission" && item.id === action.id);
      const question = state.items[index];
      if (question?.kind !== "permission") return state;
      // Las respuestas secretas no se guardan en el hilo.
      const secret = new Set(questionsOf(question.input).filter(entry => entry.secret).map(entry => entry.question));
      const answers: Record<string, string> = {};
      for (const choice of action.choices) {
        const value = choiceAnswers(choice).join(", ");
        if (value) answers[choice.question] = secret.has(choice.question) ? "••••••" : value;
      }
      const output = Object.entries(answers).map(([asked, answer]) => `${asked}\n→ ${answer}`).join("\n\n");
      const items = [...state.items];
      items.splice(index + 1, 0, { kind: "tool", id: `${action.id}:answer`, name: "AskUserQuestion",
        input: { ...question.input, answers }, status: "done", output, patch: null });
      return { ...state, items: items.map(item => item.kind === "permission" && item.id === action.id ? { ...item, state: "allowed" as const } : item) };
    }
    case "send": {
      // Un mensaje durante un turno se suma a ese turno: no abre otro.
      const next = baseReducer(state, action);
      return { ...next, pendingTurns: 1,
        activeMessageIds: ("deferred" in action && action.deferred) || next.activeMessageIds.includes(action.id)
          ? next.activeMessageIds : [...next.activeMessageIds, action.id] };
    }
    default:
      return baseReducer(state, action);
  }
}
