/** Una conversación compartida con historiales y cuentas independientes por rol. */
import { normalizeAgentWorkflow, type WorkflowAgent, type WorkflowStatus } from "./agentWorkflow";
import { initialChatState, type ChatItem, type ChatState } from "./chatState";
import { validConversationId, validAcpId } from "./conversations";
import { createHandoffContext, normalizeHandoffReference, sanitizeHandoffText, type HandoffContext, type HandoffReference, type HandoffSource } from "./handoff";
import type { QueueSnapshot, QueuedMessage } from "./messageQueue";

export type RoomRole = "planner" | "executor";
export function roomQueueAddress(id: string): { role: RoomRole; id: string } {
  const match = /^(planner|executor)::(.+)$/.exec(id);
  if (!match) throw new Error("No se encontró el agente al que pertenece el mensaje en cola.");
  return { role: match[1] as RoomRole, id: match[2] };
}
export function roomQueueSnapshot(role: RoomRole, snapshot: QueueSnapshot): QueueSnapshot {
  const name = (id: string): string => `${role}::${id}`;
  const message = (value: QueuedMessage): QueuedMessage => ({ ...value, id: name(value.id) });
  return { messages: snapshot.messages.map(message), receipt: snapshot.receipt
    ? { id: name(snapshot.receipt.id), messages: snapshot.receipt.messages.map(message) } : null,
    outbox: (snapshot.outbox ?? []).map(entry => ({ ...entry, id: name(entry.id), message: message(entry.message), predecessors: entry.predecessors.map(name) })) };
}
export type RoomParticipant = { agent: WorkflowAgent; conversationId: string | null; mode?: string | null };
export type AgentRoom = {
  id: string;
  planner: RoomParticipant;
  executor: RoomParticipant;
  active: RoomRole;
  phase: WorkflowStatus | "idle";
  cycle: number;
  /** `cursor` becomes `delivered[role]` once the provider accepts this delivery. */
  pending?: { id: string; role: RoomRole; reference: HandoffReference; cursor?: string | null } | null;
  /** Optional inherited context, consumed by the first explicit composer send. */
  setupContext?: HandoffReference | null;
  /**
   * Role that receives `setupContext`. The other role resumes the original
   * conversation and already has it. Absent in older rooms: the first send consumes it.
   */
  setupRole?: RoomRole | null;
  /**
   * Last ledger entry each role already has in its own conversation (its own
   * items, or the other role's items delivered to it). Absent: the next
   * delivery to that role carries the full context once; null: delivered before any entry.
   */
  delivered?: Partial<Record<RoomRole, string | null>>;
  order: string[];
  plan?: HandoffReference | null;
  error?: string | null;
};

const ROLES: RoomRole[] = ["planner", "executor"];
const PHASES: AgentRoom["phase"][] = ["idle", "planning", "waiting", "transferring", "executing", "completed", "paused", "failed"];
const MODES = { claude: ["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk", "manual"], codex: ["read-only", "auto", "plan", "full"], antigravity: ["ask", "default", "accept-edits", "auto", "full"], trex: ["plan", "ask", "auto", "full"] };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100 && !/[^A-Za-z0-9_-]/.test(value);
const isRole = (value: unknown): value is RoomRole => value === "planner" || value === "executor";
// Los proveedores usan UUID y también identificadores compuestos con dos puntos.
const itemId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(value);
const ledgerId = (value: unknown): value is string => typeof value === "string" && /^(planner|executor)::/.test(value) && itemId(value.slice(value.indexOf("::") + 2));
/** El ordinal cuenta bloques del mismo tipo: los registros de Claude pueden dividirlos. */
function normalizeOrder(value: unknown[], nativeIds = new Set<string>()): string[] {
  const order: string[] = [], seen = new Set<string>(), emitted = new Set<string>();
  const counts = new Map<string, number>();
  for (const original of value.filter(ledgerId)) {
    if (seen.has(original)) continue;
    seen.add(original);
    const generated = !nativeIds.has(original) && /^((?:planner|executor)::.+:(?:text|thinking)):\d+(?::\d+)?$/.exec(original);
    if (generated && emitted.has(original)) continue; // Alias canónico de un bloque ya recuperado.
    const group = generated ? generated[1] : null;
    const ordinal = group ? counts.get(group) ?? 0 : 0;
    const id = group ? `${group}:${ordinal}` : original;
    if (group) counts.set(group, ordinal + 1);
    if (!emitted.has(id)) { emitted.add(id); order.push(id); }
  }
  return order;
}

function presentationIds(items: ChatItem[], role: RoomRole): string[] {
  const counts = new Map<string, number>(), originals = new Map<string, string>();
  return items.map(item => {
    const raw = `${role}::${item.id}`;
    if (!itemId(item.id) || (item.kind !== "text" && item.kind !== "thinking") || item.id === item.messageId) return raw;
    const prefix = `${item.messageId}:${item.kind}:`;
    if (!item.id.startsWith(prefix) || !/^\d+(?::\d+)?$/.test(item.id.slice(prefix.length))) return raw;
    const replacement = originals.get(raw);
    if (replacement) return replacement;
    const ordinal = counts.get(prefix) ?? 0;
    counts.set(prefix, ordinal + 1);
    const id = `${role}::${prefix}${ordinal}`;
    originals.set(raw, id);
    return id;
  });
}

/** Valida las cuentas mediante el mismo contrato que los flujos existentes. */
export function normalizeAgentRoom(raw: unknown): AgentRoom | null {
  const value = object(raw);
  if (!value || !validId(value.id) || !isRole(value.active)
    || !PHASES.includes(value.phase as AgentRoom["phase"])
    || !Number.isSafeInteger(value.cycle) || (value.cycle as number) < 0 || !Array.isArray(value.order)) return null;
  const planner = object(value.planner), executor = object(value.executor);
  if (!planner || !executor) return null;
  for (const participant of [planner, executor]) {
    if (participant.conversationId !== null && !(participant.agent && (participant.agent as { provider?: unknown }).provider === "antigravity" ? validAcpId(participant.conversationId) : validConversationId(participant.conversationId))) return null;
  }
  const workflow = normalizeAgentWorkflow({ id: value.id, role: value.active, status: "paused", planner: planner.agent, executor: executor.agent });
  if (!workflow) return null;
  for (const role of ROLES) {
    const participant = role === "planner" ? planner : executor;
    if (participant.mode != null && (typeof participant.mode !== "string" || (workflow[role].provider === "antigravity"
      ? !/^[a-zA-Z0-9_-]{1,128}$/.test(participant.mode) || /plan|architect|read.?only/i.test(participant.mode)
      : !MODES[workflow[role].provider].includes(participant.mode)))) return null;
  }
  let pending: AgentRoom["pending"] = null;
  if (value.pending != null) {
    const candidate = object(value.pending);
    if (!candidate || !validId(candidate.id) || !isRole(candidate.role)) return null;
    const reference = normalizeHandoffReference(candidate.reference);
    if (!reference || !validId(reference.id)) return null;
    pending = { id: candidate.id, role: candidate.role, reference,
      ...(candidate.cursor === null || ledgerId(candidate.cursor) ? { cursor: candidate.cursor as string | null } : {}) };
  }
  const plan = normalizeHandoffReference(value.plan);
  const setupContext = normalizeHandoffReference(value.setupContext);
  if (value.setupContext != null && (!setupContext || !validId(setupContext.id))) return null;
  // An unreadable cursor only costs one full delivery; it never invalidates the room.
  const rawDelivered = object(value.delivered);
  const delivered = rawDelivered ? Object.fromEntries(ROLES.flatMap(role => rawDelivered[role] === null || ledgerId(rawDelivered[role])
    ? [[role, rawDelivered[role] as string | null]] : [])) as Partial<Record<RoomRole, string | null>> : null;
  return {
    id: value.id,
    planner: { agent: workflow.planner, conversationId: planner.conversationId as string | null, mode: planner.mode == null ? "plan" : planner.mode as string },
    executor: { agent: workflow.executor, conversationId: executor.conversationId as string | null,
      ...(executor.mode !== undefined ? { mode: executor.mode as string | null } : {}) },
    active: value.active, phase: value.phase as AgentRoom["phase"], cycle: value.cycle as number,
    pending, order: normalizeOrder(value.order), plan: plan && validId(plan.id) ? plan : null,
    ...(value.setupContext !== undefined ? { setupContext } : {}),
    ...(isRole(value.setupRole) ? { setupRole: value.setupRole } : {}),
    ...(delivered ? { delivered } : {}),
    error: typeof value.error === "string" ? [...sanitizeHandoffText(value.error)].slice(0, 1200).join("") : null,
  };
}

/** No reenvía nada: conserva la entrega incierta para reconciliarla con el historial. */
export function restoreAgentRoom(room: AgentRoom | null | undefined): AgentRoom | null {
  if (!room) return null;
  const pending = room.pending != null || room.plan?.pending === true;
  if (!pending && ["idle", "completed", "failed", "paused"].includes(room.phase)) return room;
  return { ...room, phase: "paused", error: pending
    ? "Entrega pendiente al recuperar la sala. Revisa ambos historiales antes de reanudar; no se ha vuelto a enviar."
    : "Sala pausada al recuperar la sesión. Revisa las conversaciones antes de reanudar." };
}

/** Solo cambia identificadores de presentación; los originales siguen en owners. */
function roomItem(item: ChatItem, role: RoomRole, id: string): ChatItem {
  if (item.kind === "text" || item.kind === "thinking") return { ...item, id, messageId: `${role}::${item.messageId}` };
  if (item.kind === "permission") return { ...item, id, toolUseId: item.toolUseId === null ? null : `${role}::${item.toolUseId}` };
  return { ...item, id };
}

/**
 * El registro fija la intercalación incluso si un proveedor repone su historial después.
 * Las entradas ausentes se conservan en order, pero nunca generan elementos fantasma.
 */
export function mergeRoomItems(states: Partial<Record<RoomRole, ChatState>>, order: string[]): {
  items: ChatItem[]; order: string[]; owners: Record<string, { role: RoomRole; originalId: string }>;
} {
  const ids: Partial<Record<RoomRole, string[]>> = {};
  const nativeIds = new Set<string>();
  for (const role of ROLES) {
    const items = states[role]?.items ?? [];
    ids[role] = presentationIds(items, role);
    for (const item of items) {
      if ((item.kind === "text" || item.kind === "thinking") && item.id === item.messageId) nativeIds.add(`${role}::${item.id}`);
    }
  }
  const ledger = normalizeOrder(order, nativeIds);
  const known = new Set(ledger);
  const current = new Map<string, ChatItem>();
  const owners: Record<string, { role: RoomRole; originalId: string }> = {};
  for (const role of ROLES) {
    const state = states[role];
    const items = state?.items ?? [];
    const keys = ids[role]!;
    // Solo los elementos presentes en este historial pueden anclar una ID recuperada.
    const nextKnown: (string | null)[] = [];
    let next: string | null = null;
    for (let index = items.length - 1; index >= 0; index--) {
      nextKnown[index] = next;
      const id = keys[index];
      if (itemId(items[index].id) && known.has(id)) next = id;
    }
    let previous: string | null = null;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!itemId(item.id)) continue;
      const namespaced = roomItem(item, role, keys[index]);
      current.set(namespaced.id, namespaced);
      owners[namespaced.id] = { role, originalId: item.id };
      if (!known.has(namespaced.id)) {
        if (index < (state?.historyCount ?? 0)) {
          // Codex sustituye las UUID locales de usuario por sus ID nativas al recuperar.
          const historyTurn = item.kind === "turn" && item.id.startsWith("history-t-");
          const before = historyTurn && previous !== null ? null : nextKnown[index];
          const at = before !== null ? ledger.indexOf(before) : previous !== null ? ledger.indexOf(previous) + 1 : ledger.length;
          ledger.splice(at, 0, namespaced.id);
        } else ledger.push(namespaced.id);
        known.add(namespaced.id);
      }
      previous = namespaced.id;
    }
  }
  return { items: ledger.flatMap(id => { const item = current.get(id); return item ? [item] : []; }), order: ledger, owners };
}

/** Usa la selección, el filtrado de secretos y los límites del contexto portátil existente. */
export function roomConversationContext(items: ChatItem[], source: HandoffSource, limit?: number): HandoffContext {
  return createHandoffContext({ ...initialChatState(), items }, source, Date.now(), limit);
}

export type RoomDelivery = {
  /** First delivery to this role (or its conversation is new): it lacks the context from the start. */
  full: boolean;
  /** Entries to transfer: everything for a new conversation, otherwise only the other role's. */
  items: ChatItem[];
  /** Ledger position this role will have once the delivery is accepted. */
  cursor: string | null;
  /** The other role used tools or changed files since the last delivery. */
  peerWork: boolean;
};

/**
 * Each participant keeps its own provider conversation, so a delivery only
 * carries what that conversation lacks: the other role's entries after its
 * cursor. Without a cursor (first delivery or an older saved room) or without
 * its own history, the full context is sent once.
 */
export function roomDelivery(room: AgentRoom, merged: { items: ChatItem[]; order: string[] }, role: RoomRole, ownHistory: boolean): RoomDelivery {
  const prefix = `${role === "planner" ? "executor" : "planner"}::`;
  const cursor = room.delivered?.[role];
  const at = cursor === undefined ? -2 : cursor === null ? -1 : merged.order.indexOf(cursor);
  const full = !ownHistory || cursor === undefined || (cursor !== null && at < 0);
  const position = new Map(merged.order.map((id, index) => [id, index]));
  const items = full && !ownHistory ? merged.items
    : merged.items.filter(item => item.id.startsWith(prefix) && (full || (position.get(item.id) ?? -1) > at));
  const peerWork = items.some(item => item.id.startsWith(prefix) && (item.kind === "tool" || item.kind === "turn" && !!item.diff));
  return { full, items, cursor: merged.order[merged.order.length - 1] ?? null, peerWork };
}

const REQUEST_HEADING = /^# Solicitud (?:actual del usuario|del usuario)\s*\n+/;
const REQUEST_END = /\n\n(?:## Contexto de la entrega pendiente que se revisa\n|## Contexto anterior del chat\n|## Novedades de |# Continuidad del proyecto\n|---\n## Estado del proyecto capturado por TREX\n)/;
/** The user's request at the start of a room delivery, without the transferred context. */
export function roomRequestText(content: string): string | null {
  const heading = REQUEST_HEADING.exec(content);
  if (!heading) return null;
  const rest = content.slice(heading[0].length), end = REQUEST_END.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim() || null;
}

/** Solo los prefijos explícitos cambian el destino; el llamador decide si puede enviarse. */
export function routeRoomMessage(text: string, room: AgentRoom): { kind: "plan" | "message"; role: RoomRole; text: string } {
  const ordinary = { kind: "message" as const, role: room.active, text };
  const match = /^\s*(\/(?:planificar|plan)|@(?:planificador|planner|ejecutor|executor|claude|codex|trex|antigravity))(?=\s|$)\s*([\s\S]*)$/i.exec(text);
  if (!match || !match[2].trim()) return ordinary;
  const prefix = match[1].toLowerCase();
  let role: RoomRole;
  if (prefix === "@ejecutor" || prefix === "@executor") role = "executor";
  else if (prefix === "@claude" || prefix === "@codex" || prefix === "@trex" || prefix === "@antigravity") {
    const matches = ROLES.filter(candidate => room[candidate].agent.provider === prefix.slice(1));
    if (matches.length !== 1) return ordinary;
    role = matches[0];
  } else role = "planner";
  return { kind: role === "planner" && room.phase !== "planning" && room.phase !== "waiting" ? "plan" : "message", role, text: match[2].trim() };
}
