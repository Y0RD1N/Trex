import { formatClock } from "./timeFormat";
import { browserResultArtifacts, browserToolResultText } from "./browser";
/**
 * Protocolo de Claude Code en modo chat (`claude -p` con stream-json).
 *
 * El CLI se ejecuta sin terminal: recibe un JSON por línea en stdin y emite
 * eventos JSON por línea en stdout. Este módulo convierte esos eventos en el
 * estado común del chat (`chatState`) y construye los mensajes de vuelta. No
 * toca la interfaz ni el backend, así que se prueba sin Tauri.
 */
import {
  addNotice, baseReducer, choiceAnswers, finalize, initialChatState, list, liveCompletion, record, resultText, text,
  type BaseChatAction, type ChatItem, type ChatState, type ContextUsage, type DiffLine, type Json, type ModelInfo, type OutgoingImage,
  type QuestionChoice,
} from "./chatState";
import { parseClaudeAgents, parseClaudeCommands, parseClaudeSkills } from "./chatCommands";
import { claudeRateLimitUsage, parseClaudeUsage } from "./planUsage";
import { FILE_SHARING_INSTRUCTIONS } from "./sharedFiles";
import { imageReference, withoutImageLabels } from "./imageReferences";
import { questionInstructions } from "./chatQuestions";
import { INBOX_INSTRUCTIONS } from "./messageQueue";
import { taskInstructions } from "./chatTasks";
import { taskToolInput } from "./taskTools";
import { addApiUsage, claudeApiUsage, type ApiUsage } from "./tokenUsage";
import { stampItems } from "./chatTimes";
import { integrationInstructions, type IntegrationContext } from "./integrations";

export type ChatAction =
  | BaseChatAction
  | { type: "line"; event: unknown; now: number }
  | { type: "history"; entries: unknown[] }
  | { type: "catalog"; models: unknown; permissionMode?: unknown; commands?: unknown; agents?: unknown; fastState?: unknown }
  | { type: "skills"; data: unknown }
  | { type: "sendFailed"; id: string; message: string }
  | { type: "applied"; model?: unknown; effort?: unknown }
  /** Respuesta a `get_context_usage`: lo mismo que muestra `/context`. */
  | { type: "context"; data: unknown }
  /** Respuesta a `get_usage`: el uso del plan de la cuenta, como en `/usage`. */
  | { type: "plan"; data: unknown }
  /** El CLI rechazó el modo elegido: se vuelve al anterior. */
  | { type: "modeRejected"; permissionMode: string | null; modeChoice: string | null; message: string };

// --- Mensajes hacia el CLI ----------------------------------------------------

/** Opciones que convierten el CLI en un proceso de chat por stdin/stdout. */
export function claudeChatFlags(profileArgs: string | null, conversationId: string | null,
  choices: { model?: string | null; effort?: string | null; mode?: string | null; integrations?: IntegrationContext } = {}): string[] {
  const flags = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages",
    // Los permisos y las preguntas con opciones llegan como peticiones que el chat responde.
    "--permission-prompt-tool", "stdio",
  ];
  // «Permitir todo» solo se puede elegir en mitad de la sesión si el CLI arrancó con esta opción.
  const restricted = /(^|\s)--restricted(\s|=|$)/.test(profileArgs ?? "");
  if (!restricted && !/(^|\s)--(allow-)?dangerously-skip-permissions(\s|=|$)/.test(profileArgs ?? "")) flags.push("--allow-dangerously-skip-permissions");
  // Instrucciones de la interfaz, salvo que el perfil ya defina las del sistema.
  if (!/(^|\s)--(append-)?system-prompt(-file)?(\s|=|$)/.test(profileArgs ?? "")) {
    flags.push("--append-system-prompt", `${FILE_SHARING_INSTRUCTIONS} ${questionInstructions("claude")} ${INBOX_INSTRUCTIONS} ${taskInstructions("claude")} ${integrationInstructions("claude", choices.integrations)}`);
  }
  const choosesConversation = /(^|\s)(--resume|-r|--continue|-c|--session-id)(\s|=|$)/.test(profileArgs ?? "");
  if (conversationId && !choosesConversation) flags.push("--resume", conversationId);
  // Al reanudar el proceso se conserva lo que se eligió en el chat.
  if (choices.model) flags.push("--model", choices.model);
  if (choices.effort) flags.push("--effort", choices.effort);
  const choosesMode = /(^|\s)(--permission-mode|--dangerously-skip-permissions)(\s|=|$)/.test(profileArgs ?? "");
  if (choices.mode && choices.mode !== "manual" && PERMISSION_MODES.has(choices.mode) && !choosesMode
    && !(restricted && choices.mode === "bypassPermissions")) flags.push("--permission-mode", choices.mode);
  return flags;
}

export function userMessageLine(text: string, images: OutgoingImage[] = [], uuid?: string): string {
  const content = images.length
    ? [...images.flatMap((image, index) => [
      { type: "text", text: imageReference(index) },
      { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
    ]),
      ...(text ? [{ type: "text", text }] : [])]
    : text;
  return JSON.stringify({ type: "user", message: { role: "user", content }, ...(uuid ? { uuid } : {}) });
}

export const controlLine = (requestId: string, request: Json): string =>
  JSON.stringify({ type: "control_request", request_id: requestId, request });

export function permissionLine(requestId: string, allowed: boolean, input: Json, remember: unknown[] = []): string {
  const response = allowed
    ? { behavior: "allow", updatedInput: input, ...(remember.length ? { updatedPermissions: remember } : {}) }
    : { behavior: "deny", message: "El usuario denegó este permiso." };
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

export const controlErrorLine = (requestId: string, error: string): string =>
  JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });

// --- Lectura de eventos -------------------------------------------------------

/** Diff legible a partir del parche que devuelve Edit/Write. */
export function patchLines(patch: unknown): DiffLine[] | null {
  const hunks = list(patch);
  if (!hunks.length) return null;
  const lines: DiffLine[] = [];
  hunks.forEach((hunk, index) => {
    if (index > 0) lines.push({ kind: "gap", text: "…" });
    for (const line of list(record(hunk)?.lines)) {
      const value = text(line);
      lines.push(value.startsWith("+") ? { kind: "add", text: value.slice(1) }
        : value.startsWith("-") ? { kind: "del", text: value.slice(1) } : { kind: "ctx", text: value.slice(1) });
    }
  });
  return lines;
}

/**
 * Respuestas en el formato que espera el CLI: pregunta → texto elegido. Sin
 * respuestas, Claude sabe que la persona no quiso contestar y sigue a su criterio.
 */
export function answeredInput(input: Json, choices: QuestionChoice[]): Json {
  const answers: Record<string, string> = {};
  for (const choice of choices) {
    const value = choiceAnswers(choice).join(", ");
    if (value) answers[choice.question] = value;
  }
  return { ...input, answers };
}

const answerText = (answers: Json): string =>
  Object.entries(answers).map(([question, answer]) => `${question}\n→ ${text(answer)}`).join("\n\n");

/** Mensajes internos del CLI que no escribió la persona (etiquetas, avisos). */
const hiddenUserText = (value: string): boolean => {
  const trimmed = value.trim();
  return !trimmed || trimmed.startsWith("<") || trimmed.startsWith("Caveat:");
};
const interruptedText = (value: string): boolean => /^\[Request interrupted by user/.test(value.trim());

function upsertTool(items: ChatItem[], block: Json): ChatItem[] {
  const id = text(block.id);
  const input = record(block.input) ?? {};
  const index = items.findIndex(item => item.kind === "tool" && item.id === id);
  if (index === -1) {
    return [...items, { kind: "tool", id, name: text(block.name) || "Herramienta", input, status: "running", output: null, patch: null }];
  }
  const current = items[index];
  if (current.kind !== "tool") return items;
  const next = [...items];
  next[index] = { ...current, name: text(block.name) || current.name, input: Object.keys(input).length ? input : current.input };
  return next;
}

/** Bloques de un mensaje del asistente (en directo o desde el historial). */
function applyAssistant(state: ChatState, message: Json): ChatState {
  const messageId = text(message.id) || `m-${state.items.length}`;
  let items = state.items;
  list(message.content).forEach((raw, index) => {
    const block = record(raw);
    if (!block) return;
    if (block.type === "tool_use") {
      items = upsertTool(items, block);
      return;
    }
    if (block.type !== "text" && block.type !== "thinking") return;
    const kind = block.type;
    const value = kind === "text" ? text(block.text) : text(block.thinking);
    // Completa el bloque que llegó por partes; si no existe, lo añade.
    const position = items.findIndex(item => item.kind === kind && item.messageId === messageId && !item.final);
    if (position !== -1) {
      const current = items[position] as Extract<ChatItem, { kind: "text" | "thinking" }>;
      items = [...items];
      items[position] = { ...current, text: value || current.text, final: true };
    } else if (value.trim()) {
      items = [...items, { kind, id: `${messageId}:${kind}:${index}:${items.length}`, messageId, text: value, final: true }];
    }
  });
  return { ...state, items };
}

/** Resultados de herramientas y mensajes del usuario. */
function applyUser(state: ChatState, event: Json, fromHistory: boolean): ChatState {
  const message = record(event.message) ?? {};
  const toolResult = record(event.tool_use_result) ?? record(event.toolUseResult);
  let items = state.items;
  const content = withoutImageLabels(typeof message.content === "string" ? [{ type: "text", text: message.content }]
    : list(message.content).map(record).filter((block): block is Json => !!block));
  const typed: string[] = [];
  let images = 0;
  let interrupted = false;
  for (const raw of content) {
    const block = record(raw);
    if (!block) continue;
    if (block.type === "tool_result") {
      const id = text(block.tool_use_id);
      const index = items.findIndex(item => item.kind === "tool" && item.id === id);
      if (index === -1) continue;
      const current = items[index];
      if (current.kind !== "tool") continue;
      items = [...items];
      // Las respuestas a las preguntas quedan junto a ellas para mostrarlas en el hilo.
      const answers = record(toolResult?.answers);
      const response = text(toolResult?.response).trim();
      const taskInput = block.is_error === true ? null : taskToolInput(current.name, current.input);
      items[index] = { ...current, status: block.is_error === true ? "error" : "done",
        ...(taskInput ? { name: "TodoWrite" } : {}),
        input: taskInput ?? (answers ? { ...current.input, answers, ...(response ? { response } : {}) }
          : toolResult?.type === "create" ? { ...current.input, changeKind: "add" } : current.input),
        output: answers ? answerText(answers) : (current.name.startsWith("mcp__trex_browser__") || current.name.startsWith("mcp__trex_desktop__")) ? browserToolResultText(block.content) : resultText(block.content),
        ...((current.name.startsWith("mcp__trex_browser__") || current.name.startsWith("mcp__trex_desktop__")) ? { artifacts: browserResultArtifacts({ content: block.content }) } : {}),
        patch: patchLines(toolResult?.structuredPatch) ?? current.patch };
    } else if (block.type === "text") {
      const value = text(block.text);
      if (interruptedText(value)) {
        interrupted = true;
        items = [...items, { kind: "notice", id: `n-${items.length}-${text(event.uuid)}`, tone: "info", text: "Detenido. Puedes seguir escribiendo." }];
      } else if (fromHistory && !hiddenUserText(value)) typed.push(value);
    } else if (block.type === "image" && fromHistory) images += 1;
  }
  if (typed.length || images) {
    items = [...items, { kind: "user", id: text(event.uuid) || `u-${items.length}`, text: typed.join("\n\n"), images, previews: [] }];
  }
  const interruptedIds = state.activeMessageIds.length ? state.activeMessageIds : state.pendingMessageIds.slice(0, 1);
  return { ...state, items, lastCompletion: interrupted && !fromHistory
    ? liveCompletion(state, `claude:interrupted:${JSON.stringify(interruptedIds)}`, "interrupted", interruptedIds, items) : state.lastCompletion };
}

function applyResult(state: ChatState, event: Json, now: number): ChatState {
  const referenced = Array.isArray(event.user_message_uuids) && event.user_message_uuids.length
    ? list(event.user_message_uuids).map(text).filter(Boolean) : [text(event.user_message_uuid)].filter(Boolean);
  // Los productores antiguos sin UUID tampoco pueden publicar dos éxitos por el mismo terminal.
  // Si no hay identidad ni atribución, una repetición idéntica se trata conservadoramente como duplicada.
  const resultId = text(event.uuid) ? `claude:${text(event.uuid)}` : referenced.length
    ? `claude:messages:${JSON.stringify(referenced)}` : `claude:legacy:${JSON.stringify(event)}`;
  if (state.completedTurnIds.includes(resultId)) return state;
  if (text(event.session_id) && state.sessionId && event.session_id !== state.sessionId) return state;
  const interrupted = ["error_during_execution", "interrupted", "cancelled", "canceled"].includes(text(event.subtype));
  const failed = !interrupted && (event.subtype !== "success" || event.is_error === true || list(event.errors).length > 0 || !!event.error);
  let pendingMessageIds = state.pendingMessageIds;
  if (interrupted && state.queuedAfterInterrupt !== null) {
    pendingMessageIds = pendingMessageIds.filter(id => state.queuedAfterInterrupt!.includes(id));
  } else if (Array.isArray(event.user_message_uuids) && event.user_message_uuids.length) {
    const consumed = new Set(list(event.user_message_uuids).map(text));
    pendingMessageIds = pendingMessageIds.filter(id => !consumed.has(id));
  } else {
    const echoed = text(event.user_message_uuid);
    const consumed = echoed ? [echoed] : state.activeMessageIds;
    // Productores anteriores solo identifican el último mensaje del lote.
    const last = Math.max(-1, ...consumed.map(id => pendingMessageIds.indexOf(id)));
    if (consumed.length) pendingMessageIds = pendingMessageIds.slice(last + 1);
    else if (typeof event.queued_turn_count === "number" && Number.isInteger(event.queued_turn_count) && event.queued_turn_count >= 0) {
      pendingMessageIds = event.queued_turn_count ? pendingMessageIds.slice(-event.queued_turn_count) : [];
    } else pendingMessageIds = pendingMessageIds.slice(1);
  }
  const consumed = state.pendingMessageIds.filter(id => !pendingMessageIds.includes(id));
  // Un terminal atrasado no cierra ni finaliza la respuesta que se está escribiendo ahora.
  if (referenced.length && (!consumed.length || state.activeMessageIds.length > 0
    && !consumed.some(id => state.activeMessageIds.includes(id)))) return state;
  let items = finalize(state.items).map(item => item.kind === "tool" && item.status === "running"
    ? { ...item, status: interrupted || failed ? "error" as const : "done" as const }
    : item.kind === "permission" && item.state === "pending" ? { ...item, state: "denied" as const } : item);
  const message = text(event.result) || list(event.errors).map(text).filter(Boolean).join("\n");
  // Tokens of this response (also spent when it was interrupted or failed).
  const turnUsage = claudeApiUsage(event.usage);
  if (failed) {
    items = addNotice(items, "error", message || "Claude no pudo completar la respuesta.", "e");
  } else if (!interrupted && state.turnStartedAt !== null && consumed.length) {
    const durationMs = typeof event.duration_ms === "number" ? event.duration_ms : now - state.turnStartedAt;
    items = [...items, { kind: "turn", id: `t-${text(event.uuid) || items.length}`, durationMs, startedAt: state.turnStartedAt, endedAt: now,
      ...(turnUsage ? { usage: turnUsage } : {}) }];
  }
  const pendingTurns = pendingMessageIds.length;
  return {
    ...state, items, pendingTurns, pendingMessageIds, activeMessageIds: [], queuedAfterInterrupt: null,
    completedTurnIds: [...state.completedTurnIds, resultId],
    lastCompletion: liveCompletion(state, resultId, interrupted ? "interrupted" : failed ? "failed" : "completed", consumed, items),
    turnItemStart: pendingTurns ? items.length : null,
    turnStartedAt: pendingTurns > 0 ? now : null,
    stream: { messageId: null, blocks: {} },
    costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : state.costUsd,
    apiUsage: addApiUsage(state.apiUsage, turnUsage),
    sessionId: text(event.session_id) || state.sessionId,
  };
}

function applyStream(state: ChatState, event: Json): ChatState {
  const type = event.type;
  if (type === "message_start") {
    const message = record(event.message);
    return { ...state, usage: liveUsage(state.usage, record(message?.usage)), stream: { messageId: text(message?.id) || null, blocks: {} } };
  }
  const messageId = state.stream.messageId;
  const index = typeof event.index === "number" ? event.index : -1;
  if (!messageId || index < 0) return state;
  if (type === "content_block_start") {
    const block = record(event.content_block) ?? {};
    if (block.type === "tool_use") {
      const items = upsertTool(state.items, block);
      return { ...state, items, stream: { messageId, blocks: { ...state.stream.blocks, [index]: text(block.id) } } };
    }
    if (block.type !== "text" && block.type !== "thinking") return state;
    const id = `${messageId}:${block.type}:${index}`;
    const item: ChatItem = { kind: block.type, id, messageId, text: block.type === "text" ? text(block.text) : text(block.thinking), final: false };
    return { ...state, items: [...state.items, item], stream: { messageId, blocks: { ...state.stream.blocks, [index]: id } } };
  }
  if (type === "content_block_delta") {
    const delta = record(event.delta) ?? {};
    const piece = delta.type === "text_delta" ? text(delta.text) : delta.type === "thinking_delta" ? text(delta.thinking) : "";
    const id = state.stream.blocks[index];
    if (!piece || !id) return state;
    const position = state.items.findIndex(item => item.id === id);
    const current = state.items[position];
    if (!current || (current.kind !== "text" && current.kind !== "thinking") || current.final) return state;
    const items = [...state.items];
    items[position] = { ...current, text: current.text + piece };
    return { ...state, items };
  }
  return state;
}

/** Por qué Claude Code no puede usar la velocidad rápida (`fast_mode_disabled_reason`). */
const FAST_UNAVAILABLE: Record<string, string> = {
  free: "La velocidad rápida requiere una suscripción de pago.",
  preference: "Tu organización desactivó la velocidad rápida.",
  extra_usage_disabled: "La velocidad rápida se cobra como uso extra: actívalo en la configuración de tu cuenta de Claude.",
  network_error: "No se pudo comprobar la velocidad rápida por un problema de conexión.",
  not_first_party: "La velocidad rápida solo está disponible con la API de Anthropic.",
  disabled_by_env: "La velocidad rápida está desactivada en este equipo.",
  model_not_allowed: "Tu organización no permite este modelo con velocidad rápida.",
  unknown: "La velocidad rápida no está disponible ahora mismo.",
};

/**
 * Velocidad que informa el CLI (`fast_mode_state`). Si se pidió la rápida y no
 * puede usarse, se explica por qué y se vuelve a la estándar; sin motivo, es
 * que el modelo en uso no la admite y vuelve sola al elegir uno que sí.
 */
function applyFastState(state: ChatState, raw: unknown, rawReason: unknown): ChatState {
  if (raw !== "on" && raw !== "off" && raw !== "cooldown") return state;
  if (state.fastChoice === null) return { ...state, fast: raw !== "off" };
  if (!state.fastChoice || raw === "on") return state;
  if (raw === "cooldown") {
    return { ...state, items: addNotice(state.items, "info", "Velocidad rápida en pausa por el límite de uso: mientras tanto se responde a la velocidad estándar.", "s") };
  }
  const reason = FAST_UNAVAILABLE[text(rawReason)];
  return reason ? { ...state, fast: false, fastChoice: false, items: addNotice(state.items, "warn", reason, "s") } : state;
}

const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto", "manual"]);

function applyEvent(state: ChatState, raw: unknown, now: number): ChatState {
  const event = record(raw);
  if (!event) return state;
  // Los subagentes trabajan dentro de su herramienta Task: no se mezclan en el hilo.
  if (typeof event.parent_tool_use_id === "string") return state;
  if (event.type === "stream_event" || event.type === "assistant") {
    const consumed = [...list(event.user_message_uuids).map(text), text(event.user_message_uuid)]
      .filter(id => id && state.pendingMessageIds.includes(id));
    if (consumed.length) state = { ...state, activeMessageIds: [...new Set([...state.activeMessageIds, ...consumed])] };
  }
  switch (event.type) {
    case "stream_event":
      return applyStream(state, record(event.event) ?? {});
    case "assistant":
      return applyAssistant(state, record(event.message) ?? {});
    case "user":
      return applyUser(state, event, false);
    case "result":
      return applyFastState(applyResult(state, event, now), event.fast_mode_state, event.fast_mode_disabled_reason);
    case "system": {
      if (event.subtype === "commands_changed" && Array.isArray(event.commands)) return { ...state, commands: parseClaudeCommands(event.commands) };
      if (event.subtype === "init") {
        return applyFastState({ ...state, sessionId: text(event.session_id) || state.sessionId, model: text(event.model) || state.model,
          permissionMode: text(event.permissionMode) || state.permissionMode }, event.fast_mode_state, event.fast_mode_disabled_reason);
      }
      if (event.subtype === "status" && typeof event.permissionMode === "string" && PERMISSION_MODES.has(event.permissionMode)) {
        // El CLI cambia de modo por su cuenta (por ejemplo, al aprobar un plan): lo elegido pasa a ser ese modo.
        return { ...state, permissionMode: event.permissionMode, modeChoice: state.modeChoice && event.permissionMode };
      }
      if (event.subtype === "compact_boundary") {
        return { ...state, items: [...state.items, { kind: "notice", id: `c-${state.items.length}`, tone: "info", text: "Conversación resumida para liberar contexto." }] };
      }
      return state;
    }
    case "control_request": {
      const request = record(event.request) ?? {};
      if (request.subtype !== "can_use_tool") return state;
      const id = text(event.request_id);
      if (!id || state.items.some(item => item.kind === "permission" && item.id === id)) return state;
      return { ...state, items: [...state.items, {
        kind: "permission", id, toolName: text(request.tool_name) || "Herramienta",
        toolUseId: text(request.tool_use_id) || null, input: record(request.input) ?? {},
        description: text(request.description), suggestions: list(request.permission_suggestions), state: "pending",
      }] };
    }
    case "control_response": {
      const response = record(record(event.response)?.response) ?? {};
      if (Array.isArray(response.still_queued)) return { ...state, queuedAfterInterrupt: list(response.still_queued).map(text).filter(Boolean) };
      const mode = text(response.mode);
      return mode && PERMISSION_MODES.has(mode) ? { ...state, permissionMode: mode } : state;
    }
    case "rate_limit_event": {
      const info = record(event.rate_limit_info) ?? {};
      const plan = claudeRateLimitUsage(state.plan, info);
      if (info.status === "allowed" || info.status === "allowed_warning" || typeof info.status !== "string") return { ...state, plan };
      const reset = typeof info.resetsAt === "number" ? formatClock(info.resetsAt * 1000) : null;
      return { ...state, plan, items: addNotice(state.items, "warn",
        reset ? `Alcanzaste el límite de uso. Se restablece a las ${reset}.` : "Alcanzaste el límite de uso de tu cuenta.", "r") };
    }
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "sendFailed": {
      const pendingMessageIds = state.pendingMessageIds.filter(id => id !== action.id);
      return { ...state, pendingMessageIds, pendingTurns: pendingMessageIds.length,
        lastCompletion: liveCompletion(state, `send:${action.id}`, "failed", [action.id]),
        turnItemStart: pendingMessageIds.length ? state.turnItemStart : null,
        activeMessageIds: state.activeMessageIds.filter(id => id !== action.id),
        turnStartedAt: pendingMessageIds.length ? state.turnStartedAt : null,
        items: addNotice(state.items, "error", action.message, "e") };
    }
    case "line":
      return applyEvent(state, action.event, action.now);
    case "history": {
      let replay: ChatState = { ...initialChatState(), process: state.process };
      let startedAt: number | null = null;
      // A message is written once per content block with the same usage: count each id once.
      const turnMessages = new Map<string, ApiUsage>(), seen = new Set<string>();
      let apiUsage: ApiUsage | null = null;
      for (const raw of action.entries) {
        const entry = record(raw);
        const timestamp = Date.parse(text(entry?.timestamp));
        const before = replay.items;
        if (entry?.type === "assistant") {
          const message = record(entry.message) ?? {};
          replay = applyAssistant(replay, message);
          const id = text(message.id), usage = claudeApiUsage(message.usage);
          if (id && usage) turnMessages.set(id, usage);
          if (message.stop_reason === "end_turn") {
            let turnUsage: ApiUsage | null = null;
            for (const [messageId, usage] of turnMessages) {
              turnUsage = addApiUsage(turnUsage, usage);
              if (!seen.has(messageId)) { seen.add(messageId); apiUsage = addApiUsage(apiUsage, usage); }
            }
            turnMessages.clear();
            replay.items.push({ kind: "turn", id: `history-t-${text(entry.uuid) || replay.items.length}`,
              durationMs: startedAt !== null && Number.isFinite(timestamp) ? Math.max(0, timestamp - startedAt) : 0,
              ...(startedAt !== null ? { startedAt } : {}), ...(Number.isFinite(timestamp) ? { endedAt: timestamp } : {}),
              ...(turnUsage ? { usage: turnUsage } : {}) });
            startedAt = null;
          }
        } else if (entry?.type === "user") {
          const length = replay.items.length;
          replay = applyUser(replay, entry, true);
          if (replay.items.length > length && replay.items[replay.items.length - 1]?.kind === "user") {
            startedAt = Number.isFinite(timestamp) ? timestamp : null;
          }
        }
        if (Number.isFinite(timestamp) && replay.items !== before) replay = { ...replay, items: stampItems(before, replay.items, timestamp) };
      }
      // Responses cut off before end_turn still consumed tokens.
      for (const [messageId, usage] of turnMessages) if (!seen.has(messageId)) apiUsage = addApiUsage(apiUsage, usage);
      // Una herramienta sin resultado quedó cortada al cerrar la sesión anterior.
      const history = finalize(replay.items).map(item => item.kind === "tool" && item.status === "running" ? { ...item, status: "done" as const } : item);
      // Sustituye un historial anterior en vez de repetirlo.
      return { ...state, items: [...history, ...state.items.slice(state.historyCount)], historyCount: history.length,
        apiUsage: apiUsage ?? state.apiUsage,
        turnItemStart: state.turnItemStart === null ? null : state.turnItemStart + history.length - state.historyCount };
    }
    case "catalog": {
      const models = parseModels(action.models);
      const mode = text(action.permissionMode);
      const commands = parseClaudeCommands(action.commands), agents = parseClaudeAgents(action.agents);
      return applyFastState({ ...state, models: models.length ? models : state.models,
        commands: commands.length ? commands : state.commands, agents: agents.length ? agents : state.agents,
        permissionMode: state.permissionMode ?? (PERMISSION_MODES.has(mode) ? mode : null) }, action.fastState, null);
    }
    case "skills":
      return { ...state, skills: parseClaudeSkills(action.data) };
    case "applied":
      return { ...state, model: text(action.model) || state.model, effort: text(action.effort) || state.effort };
    case "context":
      return { ...state, usage: parseContextUsage(action.data) ?? state.usage };
    case "plan":
      return { ...state, plan: parseClaudeUsage(action.data) ?? state.plan };
    case "modeRejected":
      return { ...state, permissionMode: action.permissionMode, modeChoice: action.modeChoice, items: addNotice(state.items, "warn", action.message, "p") };
    default:
      return baseReducer(state, action);
  }
}

// --- Uso del contexto ---------------------------------------------------------

/** Nombres de las partes del contexto que mide Claude Code. */
const CONTEXT_PARTS: Record<string, string> = {
  "System prompt": "Instrucciones del sistema", "System tools": "Herramientas", "MCP tools": "Herramientas MCP",
  "MCP server instructions": "Instrucciones de MCP", "Custom agents": "Subagentes", "Memory files": "Memoria (CLAUDE.md)",
};

/** Uso del contexto según `get_context_usage`. Los mensajes no se guardan: son lo que falta hasta `used`. */
export function parseContextUsage(raw: unknown): ContextUsage | null {
  const data = record(raw);
  if (!data || typeof data.totalTokens !== "number") return null;
  const categories = list(data.categories).map(record).filter((entry): entry is Json => !!entry && typeof entry.tokens === "number" && entry.tokens > 0);
  const kind = (entry: Json): string => text(entry.kind)
    || (entry.isDeferred === true ? "deferred" : entry.name === "Free space" ? "free" : entry.name === "Autocompact buffer" ? "buffer" : "used");
  const reserve = categories.find(entry => kind(entry) === "buffer")?.tokens;
  return {
    used: data.totalTokens,
    window: typeof data.maxTokens === "number" && data.maxTokens > 0 ? data.maxTokens : null,
    parts: categories.filter(entry => kind(entry) === "used" && entry.name !== "Messages")
      .map(entry => ({ name: CONTEXT_PARTS[text(entry.name)] ?? text(entry.name), tokens: entry.tokens as number })),
    reserve: typeof reserve === "number" ? reserve : null,
    total: null,
  };
}

/** Contexto de la petición que empieza: todo lo que entra al modelo, venga o no de la caché. */
function liveUsage(usage: ContextUsage | null, raw: Json | null): ContextUsage | null {
  const count = (key: string): number => typeof raw?.[key] === "number" ? raw[key] as number : 0;
  const used = count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
  return used ? { ...(usage ?? { window: null, parts: [], reserve: null, total: null }), used } : usage;
}

// --- Catálogo de modelos -----------------------------------------------------

/** Alias del CLI: van en la lista principal; las versiones concretas, aparte. */
const MAIN_MODELS = ["default", "fable", "opus", "sonnet", "haiku"];

/** Catálogo de modelos de la respuesta a `initialize`. */
export function parseModels(raw: unknown): ModelInfo[] {
  return list(raw).map(record).filter((model): model is Json => !!model && typeof model.value === "string" && !!model.value)
    .map(model => ({
      value: text(model.value),
      resolvedModel: text(model.resolvedModel) || text(model.value),
      displayName: text(model.displayName) || text(model.value),
      description: text(model.description),
      efforts: model.supportsEffort === false ? [] : list(model.supportedEffortLevels).filter((level): level is string => typeof level === "string"),
      featured: MAIN_MODELS.includes(text(model.value)),
      fast: model.supportsFastMode === true ? { tier: "fast", hint: "Mismo modelo, respuestas más rápidas; se cobra como uso extra." } : undefined,
    }));
}
