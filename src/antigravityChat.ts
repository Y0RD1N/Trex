/** Translate only ACP events from the selected session into the existing chat UI. */
import { baseReducer, finalize, list, liveCompletion, normalizeEffortChoice, normalizeModelChoice, record, text,
  type BaseChatAction, type ChatItem, type ChatState, type Json, type ModelInfo } from "./chatState";
import { parseTaskPlan } from "./taskTools";
import { browserResultArtifacts } from "./browser";
import { acpContext, antigravityTier } from "./antigravityUsage";
import { addApiUsage, readApiUsage } from "./tokenUsage";
import type { PlanUsage } from "./planUsage";

export type AcpConfig = { id: string; category: string; currentValue: string; options: { value: string; name: string; description: string }[] };
export function acpConfigs(raw: unknown): AcpConfig[] {
  return list(raw).flatMap(value => {
    const item = record(value);
    if (!item || typeof item.id !== "string" || item.type !== "select" || typeof item.currentValue !== "string") return [];
    const options = list(item.options).flatMap(option => { const entry = record(option); return entry && Array.isArray(entry.options) ? entry.options : [option]; }).flatMap(value => {
      const option = record(value); return typeof option?.value === "string" && typeof option.name === "string" ? [{ value: option.value, name: option.name, description: text(option.description) }] : [];
    });
    return [{ id: item.id, category: text(item.category), currentValue: item.currentValue, options }];
  });
}
export const acpModelConfig = (configs: AcpConfig[]): AcpConfig | undefined => configs.find(c => c.category === "model" || c.id === "model");
export const acpEffortConfig = (configs: AcpConfig[]): AcpConfig | undefined => configs.find(c => /^(?:thought_level|reasoning_effort|effort)$/.test(c.category) || /^(?:thought_level|reasoning_effort|effort)$/.test(c.id));
export function acpModels(configs: AcpConfig[], legacy: unknown): ModelInfo[] {
  const models = acpModelConfig(configs)?.options ?? list(record(legacy)?.availableModels).flatMap(value => {
    const item = record(value); return item ? [{ value: text(item.modelId), name: text(item.name), description: text(item.description) }] : [];
  });
  const efforts = acpEffortConfig(configs)?.options.map(o => o.value).filter(e => normalizeEffortChoice(e) === e) ?? [];
  const seen = new Set<string>();
  return models.flatMap(item => { const id = normalizeModelChoice(item.value); if (!id || seen.has(id)) return []; seen.add(id);
    return [{ value: id, resolvedModel: id, displayName: item.name || id, description: item.description, featured: true, efforts }]; });
}
export function acpModes(raw: unknown): { value: string; label: string; description: string }[] {
  return list(record(raw)?.availableModes).flatMap(value => { const item = record(value);
    // Native plan restrictions have not yet been verified. Do not advertise a read-only guarantee.
    return item && typeof item.id === "string" && typeof item.name === "string" && !/plan|architect|read.?only/i.test(item.id + " " + item.name)
      ? [{ value: item.id, label: item.name, description: text(item.description) }] : [];
  });
}
const TOOL_NAMES: Record<string, string> = { view_file: "Read", list_dir: "LS", find_by_name: "Glob", grep_search: "Grep", run_command: "Bash", write_to_file: "Write", replace_file_content: "Edit", multi_replace_file_content: "Edit", ask_question: "AskUserQuestion" };
export function acpTool(input: Json): { name: string; input: Json } {
  const raw = record(input.rawInput) ?? {};
  const metadata = record(record(input._meta)?.antigravity);
  const supplied = text(metadata?.toolName) || text(input.toolName) || text(input.title);
  const isTasks = /^(?:mcp__trex_inbox__|mcp_trex_inbox_|trex_inbox[/:.])?trex_update_tasks$/.test(supplied);
  const plan = isTasks ? parseTaskPlan(raw) : null;
  if (plan) return { name: "TodoWrite", input: { todos: plan.plan.map(s => ({ content: s.step, status: s.status })) } };
  return { name: TOOL_NAMES[supplied] ?? (supplied || "Herramienta"), input: { ...raw,
    ...(raw.CommandLine ? { command: raw.CommandLine } : {}), ...(raw.AbsolutePath || raw.TargetFile ? { file_path: raw.AbsolutePath ?? raw.TargetFile } : {}),
    ...(raw.CodeContent ? { content: raw.CodeContent } : {}), ...(raw.TargetContent ? { old_string: raw.TargetContent, new_string: raw.ReplacementContent } : {}) } };
}
export function acpOutputText(raw: unknown): string | null {
  if (raw == null) return null;
  const result = record(raw);
  const output = typeof raw === "string" ? raw : Array.isArray(result?.content)
    ? result.content.map(value => { const block = record(value); return block?.type === "text" ? text(block.text) : block?.type === "image" ? "[Imagen devuelta por la herramienta]" : ""; }).filter(Boolean).join("\n")
    : JSON.stringify(raw, (_key, value) => record(value)?.type === "image" ? { type: "image", mimeType: record(value)?.mimeType } : value);
  return output.length > 128_000 ? output.slice(0, 128_000) + "\n[Salida truncada]" : output;
}
export type AntigravityAction = BaseChatAction
  | { type: "acpReady"; sessionId: string; result: Json; history?: boolean }
  | { type: "acpUpdate"; sessionId: string; update: Json; turn: string | null; replay: boolean }
  | { type: "acpPermission"; item: Extract<ChatItem, { kind: "permission" }> }
  | { type: "acpHistoryStart"; sessionId: string }
  | { type: "acpUsageSnapshot"; sessionId: string; plan: PlanUsage | null; apiUsage: import("./tokenUsage").ApiUsage | null }
  | { type: "acpReceipt"; id: string; messages: { id: string; text: string; previews: string[] }[] }
  | { type: "acpFinished"; id: string; result?: Json; error?: string; now: number };
export function antigravityReducer(state: ChatState, action: AntigravityAction): ChatState {
  if (action.type === "model") {
    const next = baseReducer(state, action);
    return action.model !== (state.modelChoice ?? state.model) && state.usage ? { ...next, usage: { ...state.usage, measured: false, window: null } } : next;
  }
  if (action.type === "acpHistoryStart") return { ...state, sessionId: action.sessionId, items: [], historyCount: 0, lastCompletion: null, usage: null, apiUsage: null, costUsd: null };
  if (action.type === "acpUsageSnapshot") return action.sessionId !== state.sessionId ? state : { ...state,
    plan: action.plan ?? state.plan, apiUsage: action.apiUsage ? { ...action.apiUsage,
      ...(action.apiUsage.totalTokens === state.apiUsage?.totalTokens ? {
        cachedReadTokens: action.apiUsage.cachedReadTokens ?? state.apiUsage.cachedReadTokens,
        cachedWriteTokens: action.apiUsage.cachedWriteTokens ?? state.apiUsage.cachedWriteTokens,
        costUsd: action.apiUsage.costUsd ?? state.apiUsage.costUsd,
      } : {}) } : state.apiUsage,
    usage: state.usage && action.apiUsage?.totalTokens !== null && action.apiUsage?.totalTokens !== undefined ? { ...state.usage, total: action.apiUsage.totalTokens } : state.usage };
  if (action.type === "acpReceipt") {
    const at = state.items.findIndex(i => i.kind === "user" && i.id === action.id);
    if (at < 0) return state;
    const messages: ChatItem[] = action.messages.map(m => ({ kind: "user", id: m.id, text: m.text, images: m.previews.length, previews: m.previews, fromQueue: true }));
    return { ...state, items: [...state.items.slice(0, at), ...messages, ...state.items.slice(at + 1)],
      turnItemStart: state.turnItemStart === null ? null : state.turnItemStart + messages.length - 1 };
  }
  if (action.type === "acpReady") {
    const configs = acpConfigs(action.result.configOptions), model = acpModelConfig(configs)?.currentValue || text(record(action.result.models)?.currentModelId) || state.model;
    const tier = antigravityTier(action.result);
    return { ...state, process: "ready", exitCode: null, stderr: [], sessionId: action.sessionId,
      ...(state.sessionId !== action.sessionId ? { usage: null, apiUsage: null, costUsd: null } : {}),
      ...(tier ? { plan: { plan: tier, windows: state.plan?.windows ?? [], extra: null, resetCredits: 0 } } : {}),
      model, models: acpModels(configs, action.result.models), effort: acpEffortConfig(configs)?.currentValue ?? state.effort,
      permissionMode: text(record(action.result.modes)?.currentModeId) || state.permissionMode,
      ...(action.history ? { historyCount: state.items.length, items: finalize(state.items) } : {}) };
  }
  if (action.type === "acpPermission") return state.items.some(i => i.id === action.item.id) ? state : { ...state, items: [...state.items, action.item] };
  if (action.type === "acpFinished") {
    if (!state.pendingMessageIds.includes(action.id)) return state;
    const status = action.error ? "failed" : action.result?.stopReason === "cancelled" ? "interrupted" : "completed";
    const id = `acp:${action.id}`;
    let items = finalize(state.items).map(i => i.kind === "permission" && i.state === "pending" ? { ...i, state: "denied" as const }
      : i.kind === "tool" && i.status === "running" ? { ...i, status: "error" as const } : i);
    if (action.error) items = [...items, { kind: "notice", id: `${id}:error`, tone: "error", text: action.error }];
    const completion = liveCompletion(state, id, status, [action.id], items);
    if (completion?.status === "completed") items = [...items, { kind: "turn", id: `${id}:duration`, durationMs: Math.max(0, action.now - (state.turnStartedAt ?? action.now)) }];
    const pending = state.pendingMessageIds.filter(v => v !== action.id);
    const apiUsage = addApiUsage(state.apiUsage, readApiUsage(action.result?.usage));
    return { ...state, apiUsage, usage: state.usage ? { ...state.usage, total: apiUsage?.totalTokens ?? state.usage.total } : null,
      items, pendingMessageIds: pending, pendingTurns: pending.length, activeMessageIds: [], turnId: null, turnItemStart: null,
      turnStartedAt: null, lastCompletion: completion, completedTurnIds: [...state.completedTurnIds.slice(-255), id], interruptedMessageIds: state.interruptedMessageIds.filter(v => v !== action.id) };
  }
  if (action.type !== "acpUpdate") return baseReducer(state, action);
  if (action.sessionId !== state.sessionId || !action.replay && (!action.turn || !state.pendingMessageIds.includes(action.turn))
    && !["usage_update", "config_option_update", "current_mode_update", "available_commands_update"].includes(text(action.update.sessionUpdate))) return state;
  const u = action.update, type = text(u.sessionUpdate), namespace = action.replay ? "history" : action.turn!;
  if (type === "usage_update") {
    const usage = acpContext(u); if (!usage) return state;
    const cost = record(u.cost);
    return { ...state, usage: { ...usage, total: state.apiUsage?.totalTokens ?? state.usage?.total ?? null },
      ...(cost?.currency === "USD" && typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0 ? { costUsd: cost.amount } : {}) };
  }
  if (["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(type)) {
    const content = record(u.content);
    if (type === "user_message_chunk" && action.replay && content?.type === "image") {
      const mime = text(content.mimeType), data = text(content.data);
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime) || data.length > 32 * 1024 * 1024 || !/^[a-z0-9+/]*={0,2}$/i.test(data)) return state;
      const previous = state.items[state.items.length - 1], explicit = text(u.messageId);
      const id = explicit ? `acp:history:${explicit}` : previous?.kind === "user" && previous.id.startsWith("acp:history:") ? previous.id : `acp:history:${state.items.length}`;
      const at = state.items.findIndex(i => i.id === id && i.kind === "user"), items = [...state.items], preview = `data:${mime};base64,${data}`;
      if (at >= 0) { const item = items[at]; if (item.kind === "user" && item.previews.length < 64) items[at] = { ...item, images: item.images + 1, previews: [...item.previews, preview] }; }
      else items.push({ kind: "user", id, text: "", images: 1, previews: [preview] });
      return { ...state, items };
    }
    if (content?.type !== "text" || typeof content.text !== "string") return state;
    const kind = type === "agent_thought_chunk" ? "thinking" : type === "user_message_chunk" ? "user" : "text";
    if (kind === "user" && !action.replay) return state; // live user echoes must not duplicate our submitted message.
    const previous = state.items[state.items.length - 1];
    const explicit = text(u.messageId);
    const id = explicit ? `acp:${namespace}:${explicit}` : previous?.kind === kind && previous.id.startsWith(`acp:${namespace}:`) ? previous.id : `acp:${namespace}:${state.items.length}`;
    const index = state.items.findIndex(i => i.id === id && i.kind === kind), items = [...state.items];
    if (index >= 0) { const before = items[index]; if (before.kind === "user" || before.kind === "text" || before.kind === "thinking") items[index] = { ...before, text: before.text + content.text }; }
    else items.push(kind === "user" ? { kind, id, text: content.text, images: 0, previews: [] } : { kind, id, messageId: id, text: content.text, final: action.replay });
    return { ...state, items };
  }
  if (type === "tool_call" || type === "tool_call_update") {
    const nativeId = text(u.toolCallId); if (!nativeId) return state;
    const id = `acp:${namespace}:tool:${nativeId}`, index = state.items.findIndex(i => i.id === id && i.kind === "tool");
    const before = index < 0 ? null : state.items[index];
    const parsed = acpTool(u), status = u.status === "failed" || record(u.rawOutput)?.isError === true ? "error" : u.status === "completed" ? "done" : "running";
    const output = u.rawOutput != null ? acpOutputText(u.rawOutput)
      : Array.isArray(u.content) ? u.content.map(v => text(record(record(v)?.content)?.text)).filter(Boolean).join("\n") : null;
    let item: Extract<ChatItem, { kind: "tool" }> = { kind: "tool", id, name: u.title || u.toolName ? parsed.name : before?.kind === "tool" ? before.name : parsed.name,
      input: u.rawInput ? parsed.input : before?.kind === "tool" ? before.input : parsed.input,
      status: record(u.rawOutput)?.isError === true ? "error" : u.status ? status : before?.kind === "tool" ? before.status : status, output: output ?? (before?.kind === "tool" ? before.output : null), patch: null,
      artifacts: browserResultArtifacts(record(u.rawOutput)) };
    // ACP implementations may replace the MCP tool's name with a friendly
    // title. The accepted app result is still an exact, validated task plan.
    if (item.status === "done") {
      const result = record(u.rawOutput);
      let accepted = parseTaskPlan(result?.structuredContent);
      if (!accepted) for (const block of [...list(result?.content), ...list(u.content).map(v => record(v)?.content)]) {
        const part = record(block); if (part?.type !== "text" || typeof part.text !== "string") continue;
        try { accepted = parseTaskPlan(JSON.parse(part.text)); } catch { /* A normal tool result is not a task plan. */ }
        if (accepted) break;
      }
      const candidate = parseTaskPlan(record(u.rawInput) ?? (before?.kind === "tool" ? before.input : null));
      if (accepted && (item.name === "TodoWrite" || candidate && candidate.plan.length === accepted.plan.length && candidate.plan.every((s, i) => s.step === accepted!.plan[i].step && s.status === accepted!.plan[i].status)))
        item = { ...item, name: "TodoWrite", input: { todos: accepted.plan.map(s => ({ content: s.step, status: s.status })) } };
      else if (item.name === "TodoWrite") item = { ...item, name: "trex_update_tasks" };
    }
    const items = [...state.items]; if (index < 0) items.push(item); else items[index] = item;
    return { ...state, items };
  }
  if (type === "plan") {
    const entries = list(u.entries), id = `acp:${namespace}:plan`;
    if (entries.length > 64 || entries.some(e => { const s = record(e); return !s || typeof s.content !== "string" || !["pending", "in_progress", "completed"].includes(text(s.status)); })) return state;
    if (!parseTaskPlan({ plan: entries.map(e => { const s = record(e)!; return { step: s.content, status: s.status }; }) })) return state;
    const item: ChatItem = { kind: "tool", id, name: "TodoWrite", input: { todos: entries.map(e => { const s = record(e)!; return { content: s.content, status: s.status }; }) }, status: "done", output: "Plan actualizado", patch: null };
    return { ...state, items: state.items.some(i => i.id === id) ? state.items.map(i => i.id === id ? item : i) : [...state.items, item] };
  }
  if (type === "available_commands_update") return { ...state, commands: list(u.availableCommands).flatMap(value => { const c = record(value); return c && typeof c.name === "string" ? [{ name: c.name, description: text(c.description), hint: text(record(c.input)?.hint) }] : []; }) };
  if (type === "current_mode_update") return { ...state, permissionMode: text(u.currentModeId) || state.permissionMode };
  if (type === "config_option_update") {
    const configs = acpConfigs(u.configOptions);
    const model = acpModelConfig(configs)?.currentValue ?? state.model;
    return { ...state, models: acpModels(configs, null), model, effort: acpEffortConfig(configs)?.currentValue ?? state.effort,
      ...(model !== state.model && state.usage ? { usage: { ...state.usage, measured: false, window: null } } : {}) };
  }
  return state;
}
