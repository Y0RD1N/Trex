import { browserArtifacts, browserResultArtifacts } from "./browser";
/** Protocolo propio de Trex CLI: la API del proveedor permanece dentro del CLI. */
import { baseReducer, currentModel, finalize, list, liveCompletion, normalizeEffortChoice, normalizeModelChoice, record, text,
  type BaseChatAction, type ChatItem, type ChatState, type ContextUsage, type Json, type ModelInfo } from "./chatState";

const tokens = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const windowSize = (value: unknown): number | null => { const count = tokens(value); return count && count > 0 ? count : null; };

export const trexRequest = (id: string | number, method: string, params: unknown = {}): string => JSON.stringify({ jsonrpc: "2.0", id, method, params });
export const trexResult = (id: string | number, result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id, result });

export function parseTrexModels(raw: unknown): ModelInfo[] {
  const seen = new Set<string>();
  return list(raw).flatMap((value, index) => {
    const model = record(value), id = normalizeModelChoice(model?.id);
    if (!model || !id || seen.has(id)) return [];
    seen.add(id);
    return [{ value: id, resolvedModel: id, displayName: text(model.name) || id, description: text(model.description),
      ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((value): value is string => typeof value === "string") } : {}),
      featured: index < 8, efforts: [...new Set(list(model.efforts).filter((level): level is string => typeof level === "string" && normalizeEffortChoice(level) === level))],
      ...(windowSize(model.contextWindow) ? { contextWindow: windowSize(model.contextWindow)! } : {}),
      ...(model.contextWindowSource === "remote" || model.contextWindowSource === "documented" ? { contextWindowSource: model.contextWindowSource } : {}) }];
  });
}

export type TrexChatAction = BaseChatAction
  | { type: "trexReady"; result: Json; models: ModelInfo[] }
  | { type: "trexEvent"; method: string; params: Json; now: number }
  | { type: "trexFailed"; id: string; message: string };

const TOOL_NAMES: Record<string, string> = { read_file: "Read", list_files: "LS", search: "Grep", write_file: "Write", apply_patch: "TrexPatch", shell: "Bash", trex_read_messages: "trex_read_messages" };
export const trexToolName = (value: string): string => value === "update_plan" ? "TodoWrite" : TOOL_NAMES[value] ?? value;
export function trexToolInput(name: string, input: Json): Json {
  const tool = trexToolName(name);
  if (tool === "TodoWrite" && Array.isArray(input.plan)) return { todos: input.plan.map(record).filter((step): step is Json => !!step)
    .map(step => ({ content: text(step.step), status: step.status })) };
  if (tool === "Read" || tool === "Write") return { ...input, file_path: input.file_path ?? input.path };
  if (tool === "TrexPatch" && typeof input.patch === "string") {
    try {
      const patch = record(JSON.parse(input.patch));
      return { ...input, files: list(patch?.files).map(record).filter((file): file is Json => !!file)
        .map(file => ({ file_path: text(file.path), old_string: text(file.before), new_string: text(file.after), changeKind: file.before === null ? "add" : "edit" })) };
    } catch { return input; }
  }
  return input;
}

export function trexReducer(state: ChatState, action: TrexChatAction): ChatState {
  if (action.type === "model") {
    const next = baseReducer(state, action);
    if ((next.modelChoice ?? next.model) === (state.modelChoice ?? state.model)) return next;
    return { ...next, usage: state.usage ? { ...state.usage, measured: false,
      window: currentModel(next.models, next.model, next.modelChoice)?.contextWindow ?? null } : null };
  }
  if (action.type === "trexReady") {
    const result = action.result;
    const model = text(result.model) || state.modelChoice;
    const limit = windowSize(result.contextWindow);
    const models = action.models.map((entry): ModelInfo => entry.resolvedModel === model && limit ? { ...entry, contextWindow: limit,
      ...(result.contextWindowSource === "remote" || result.contextWindowSource === "documented" ? { contextWindowSource: result.contextWindowSource } : {}) } : entry);
    if (state.modelChoice && state.modelChoice !== model && !models.some(entry => entry.value === state.modelChoice)) {
      // Conserva la elección hecha durante el reinicio aunque el catálogo nuevo
      // ya no la incluya; no uses el modelo anterior como sustituto de su límite.
      const chosen = state.models.find(entry => entry.value === state.modelChoice);
      models.unshift(chosen ?? { value: state.modelChoice, resolvedModel: state.modelChoice, displayName: state.modelChoice,
        description: "Modelo elegido", featured: true, efforts: [] });
    }
    const items = list(result.items).filter((value): value is ChatItem => {
      const item = record(value);
      return !!item && typeof item.id === "string" && ["user", "text", "thinking", "tool", "permission", "notice", "turn"].includes(text(item.kind));
    }).map(item => item.kind === "tool" ? { ...item, name: trexToolName(item.name), artifacts: browserArtifacts(item.artifacts), input: trexToolInput(item.name, item.input) }
      : item.kind === "permission" ? { ...item, toolName: trexToolName(item.toolName), input: trexToolInput(item.toolName, item.input) } : item);
    // La restauración no borra un envío reservado mientras arrancaba el proceso.
    const pending = state.items.filter(item => item.kind === "user" && state.pendingMessageIds.includes(item.id));
    const existing = new Set(items.map(item => item.id));
    const previousTotal = state.sessionId === text(result.sessionId) ? state.usage?.total ?? null : null;
    const next: ChatState = { ...state, sessionId: text(result.sessionId), process: "ready", exitCode: null,
      model, effort: text(result.effort) || state.effortChoice,
      permissionMode: text(result.mode) || state.permissionMode, models,
      items: [...items, ...pending.filter(item => !existing.has(item.id))], historyCount: items.length,
      turnItemStart: pending.length ? items.length : null,
      usage: previousTotal === null ? null : { used: 0, window: null, parts: [], reserve: null, total: previousTotal, measured: false } };
    const usage = record(result.usage);
    // Una respuesta de arranque puede llegar después de elegir otro modelo.
    const selectedLimit = !next.modelChoice || next.modelChoice === model ? limit : null;
    const hasHistory = items.some(item => ["user", "text", "thinking", "tool"].includes(item.kind));
    return { ...next, usage: usage ? readUsage(usage, next, true, selectedLimit)
      : selectedLimit || hasHistory || previousTotal !== null ? { used: 0, window: selectedLimit ?? currentModel(models, model, next.modelChoice)?.contextWindow ?? null,
        parts: [], reserve: null, total: previousTotal, ...(hasHistory || previousTotal !== null ? { measured: false } : {}) } : null };
  }
  if (action.type === "trexFailed") {
    if (!state.pendingMessageIds.includes(action.id)) return state;
    const next = finish(state, action.id, "failed", `failed:${action.id}`, action.message, Date.now());
    return next;
  }
  if (action.type !== "trexEvent") return baseReducer(state, action);
  const p = action.params, userId = text(p.messageId);
  if (p.sessionId !== state.sessionId || !state.pendingMessageIds.includes(userId)) return state;
  if (action.method === "turn/started") return { ...state, activeMessageIds: [userId], turnId: text(p.turnId) || userId };
  if (action.method === "message/delta") {
    const kind = p.kind === "thinking" ? "thinking" : "text";
    const id = text(p.id) || `${userId}:${kind}`;
    const index = state.items.findIndex(item => item.id === id && item.kind === kind);
    const items = [...state.items];
    if (index < 0) items.push({ kind, id, messageId: id, text: text(p.text), final: false });
    else {
      const before = items[index];
      if (before.kind === kind) items[index] = { ...before, text: before.text + text(p.text) };
    }
    return { ...state, items };
  }
  if (action.method === "tool/start") {
    const id = text(p.id);
    if (!id || state.items.some(item => item.id === id)) return state;
    return { ...state, items: [...state.items, { kind: "tool", id, name: trexToolName(text(p.toolName)),
      input: trexToolInput(text(p.toolName), record(p.input) ?? {}), status: "running", output: null, patch: null }] };
  }
  if (action.method === "tool/result") return { ...state, items: state.items.map(item => item.kind === "tool" && item.id === p.id
    ? { ...item, artifacts: browserArtifacts(p.artifacts).length ? browserArtifacts(p.artifacts) : browserResultArtifacts(record(p.output)), status: p.isError ? "error" : "done", output: typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? null) } : item) };
  if (action.method === "permission/request") {
    const id = text(p.id);
    if (!id || state.items.some(item => item.id === id)) return state;
    return { ...state, items: [...state.items, { kind: "permission", id, toolName: trexToolName(text(p.toolName)), toolUseId: text(p.toolUseId) || null,
      input: trexToolInput(text(p.toolName), record(p.input) ?? {}), description: text(p.description), suggestions: [], state: "pending", request: { id, method: "permission/respond" } }] };
  }
  if (action.method === "turn/completed") {
    const status = p.status === "completed" ? "completed" : p.status === "interrupted" ? "interrupted" : "failed";
    const next = finish(state, userId, status, `trex:${userId}`, text(p.error), action.now);
    const usage = record(p.usage);
    if (!usage) return next;
    return { ...next, usage: readUsage(usage, next),
      costUsd: typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? (state.costUsd ?? 0) + usage.costUsd : state.costUsd };
  }
  return state;
}

function readUsage(raw: Json, state: ChatState, restored = false, limit: number | null = null): ContextUsage {
  const selected = state.modelChoice ?? state.model;
  const matches = !text(raw.contextModel) || raw.contextModel === selected;
  // En versiones anteriores sólo se enviaba el total de entrada del turno.
  // El protocolo actual distingue una medición ausente de un contexto vacío.
  const used = tokens(raw.contextTokens) ?? (raw.contextModel === undefined ? tokens(raw.inputTokens) : null);
  const total = tokens(raw.totalTokens) ?? (restored ? state.usage?.total ?? null
    : (state.usage?.total ?? 0) + (tokens(raw.inputTokens) ?? 0) + (tokens(raw.outputTokens) ?? 0));
  return { used: used ?? 0,
    window: (matches ? windowSize(raw.contextWindow) : null) ?? limit ?? windowSize(state.usage?.window)
      ?? currentModel(state.models, state.model, state.modelChoice)?.contextWindow ?? null,
    parts: [], reserve: null, total, ...(!matches || used === null ? { measured: false } : {}) };
}

function finish(state: ChatState, userId: string, status: "completed" | "interrupted" | "failed", completionId: string, error: string, now: number): ChatState {
  if (state.completedTurnIds.includes(completionId)) return state;
  let items = finalize(state.items).map(item => item.kind === "permission" && item.state === "pending" ? { ...item, state: "denied" as const }
    : item.kind === "tool" && item.status === "running" ? { ...item, status: "error" as const } : item);
  if (error) items = [...items, { kind: "notice", id: `${completionId}:error`, tone: "error", text: error }];
  const completion = liveCompletion(state, completionId, status, [userId], items);
  if (completion?.status === "completed") items = [...items, { kind: "turn", id: `${completionId}:duration`, durationMs: Math.max(0, now - (state.turnStartedAt ?? now)) }];
  const pendingMessageIds = state.pendingMessageIds.filter(id => id !== userId);
  return { ...state, items, pendingMessageIds, pendingTurns: pendingMessageIds.length, activeMessageIds: [],
    interruptedMessageIds: state.interruptedMessageIds.filter(id => id !== userId),
    lastCompletion: completion,
    completedTurnIds: [...state.completedTurnIds, completionId], turnItemStart: null, turnStartedAt: null, turnId: null };
}
