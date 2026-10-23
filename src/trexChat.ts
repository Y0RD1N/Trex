/** Protocolo propio de Trex CLI: la API del proveedor permanece dentro del CLI. */
import { baseReducer, finalize, list, liveCompletion, normalizeEffortChoice, normalizeModelChoice, record, text,
  type BaseChatAction, type ChatItem, type ChatState, type Json, type ModelInfo } from "./chatState";

export const trexRequest = (id: string | number, method: string, params: unknown = {}): string => JSON.stringify({ jsonrpc: "2.0", id, method, params });
export const trexResult = (id: string | number, result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id, result });

export function parseTrexModels(raw: unknown): ModelInfo[] {
  const seen = new Set<string>();
  return list(raw).flatMap((value, index) => {
    const model = record(value), id = normalizeModelChoice(model?.id);
    if (!model || !id || seen.has(id)) return [];
    seen.add(id);
    return [{ value: id, resolvedModel: id, displayName: text(model.name) || id, description: text(model.description),
      featured: index < 8, efforts: [...new Set(list(model.efforts).filter((level): level is string => typeof level === "string" && normalizeEffortChoice(level) === level))],
      ...(typeof model.contextWindow === "number" && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}) }];
  });
}

export type TrexChatAction = BaseChatAction
  | { type: "trexReady"; result: Json; models: ModelInfo[] }
  | { type: "trexEvent"; method: string; params: Json; now: number }
  | { type: "trexFailed"; id: string; message: string };

const TOOL_NAMES: Record<string, string> = { read_file: "Read", list_files: "LS", search: "Grep", write_file: "Write", apply_patch: "TrexPatch", shell: "Bash", trex_read_messages: "trex_read_messages" };
export const trexToolName = (value: string): string => TOOL_NAMES[value] ?? value;
export function trexToolInput(name: string, input: Json): Json {
  const tool = trexToolName(name);
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
  if (action.type === "trexReady") {
    const result = action.result;
    const items = list(result.items).filter((value): value is ChatItem => {
      const item = record(value);
      return !!item && typeof item.id === "string" && ["user", "text", "thinking", "tool", "permission", "notice", "turn"].includes(text(item.kind));
    }).map(item => item.kind === "tool" ? { ...item, name: trexToolName(item.name), input: trexToolInput(item.name, item.input) }
      : item.kind === "permission" ? { ...item, toolName: trexToolName(item.toolName), input: trexToolInput(item.toolName, item.input) } : item);
    // La restauración no borra un envío reservado mientras arrancaba el proceso.
    const pending = state.items.filter(item => item.kind === "user" && state.pendingMessageIds.includes(item.id));
    const existing = new Set(items.map(item => item.id));
    return { ...state, sessionId: text(result.sessionId), process: "ready", exitCode: null,
      model: text(result.model) || state.modelChoice, effort: text(result.effort) || state.effortChoice,
      permissionMode: text(result.mode) || state.permissionMode, models: action.models,
      items: [...items, ...pending.filter(item => !existing.has(item.id))], historyCount: items.length,
      turnItemStart: pending.length ? items.length : null };
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
    ? { ...item, status: p.isError ? "error" : "done", output: typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? null) } : item) };
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
    const input = typeof usage.inputTokens === "number" && usage.inputTokens >= 0 ? usage.inputTokens : 0;
    const output = typeof usage.outputTokens === "number" && usage.outputTokens >= 0 ? usage.outputTokens : 0;
    return { ...next, usage: { used: typeof usage.contextTokens === "number" && usage.contextTokens >= 0 ? usage.contextTokens : input, window: typeof usage.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : null,
      parts: [], reserve: null, total: (state.usage?.total ?? 0) + input + output },
      costUsd: typeof usage.costUsd === "number" && usage.costUsd >= 0 ? (state.costUsd ?? 0) + usage.costUsd : state.costUsd };
  }
  return state;
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
