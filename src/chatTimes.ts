/**
 * When things happened in a chat: tool calls and messages get the time they
 * appeared, and every finished response its start, end and token usage.
 * Provider reducers stay pure; this wraps them so all providers behave alike.
 * History replays carry their own times (or none) and are never stamped "now".
 */
import type { ChatItem, ChatState } from "./chatState";
import { subtractApiUsage } from "./tokenUsage";

const HISTORY_ACTIONS = new Set(["history", "acpHistoryStart", "trexReady"]);
export function isHistoryAction(action: { type: string }): boolean {
  const extra = action as { replay?: unknown; history?: unknown };
  return HISTORY_ACTIONS.has(action.type) || extra.replay === true || extra.history === true;
}

/** Gives new tool and user items the time they appeared. Earlier items keep theirs. */
export function stampItems(before: ChatItem[], after: ChatItem[], now: number): ChatItem[] {
  if (after === before) return after;
  // Items are appended (or updated in place by spreading, which keeps `at`).
  // Only the tail can hold new items: a streaming delta touches no array copy.
  const from = Math.max(0, Math.min(before.length, after.length) - 3);
  let known: Set<string> | null = null;
  let items: ChatItem[] | null = null;
  for (let index = from; index < after.length; index++) {
    const item = after[index];
    if ((item.kind !== "tool" && item.kind !== "user") || item.at !== undefined) continue;
    known ??= new Set(before.slice(from).map(previous => previous.id));
    if (known.has(item.id)) continue;
    items ??= after.slice();
    items[index] = { ...item, at: now };
  }
  return items ?? after;
}

/** Start/end and token usage for response markers this action appended. */
function completeTurns(before: ChatState, next: ChatState, now: number): ChatState {
  let items = next.items, changed = false;
  const known = new Set(before.items.slice(Math.max(0, before.items.length - 3)).map(item => item.id));
  for (let index = Math.max(0, Math.min(before.items.length, items.length) - 3); index < items.length; index++) {
    const item = items[index];
    if (item.kind !== "turn" || known.has(item.id) || item.endedAt !== undefined) continue;
    const startedAt = before.turnStartedAt ?? (item.durationMs > 0 ? now - item.durationMs : undefined);
    const usage = item.usage ?? subtractApiUsage(next.apiUsage, before.turnUsageBase ?? null);
    if (!changed) { items = [...items]; changed = true; }
    items[index] = { ...item, endedAt: now, ...(startedAt !== undefined ? { startedAt } : {}), ...(usage ? { usage } : {}) };
  }
  return changed ? { ...next, items } : next;
}

export function withChatTimes<S extends ChatState, A extends { type: string }>(reducer: (state: S, action: A) => S, clock: () => number = Date.now) {
  return (state: S, action: A): S => {
    let next = reducer(state, action);
    if (next === state) return next;
    if (isHistoryAction(action)) return next.turnStartedAt === null && next.turnUsageBase ? { ...next, turnUsageBase: null } : next;
    const now = clock();
    if (next.items !== state.items) {
      const items = stampItems(state.items, next.items, now);
      if (items !== next.items) next = { ...next, items };
      next = completeTurns(state, next, now) as S;
    }
    // Usage is measured from the moment a response starts (also when Claude chains queued messages).
    const turnEnded = next.items.length > state.items.length && next.items.slice(state.items.length).some(item => item.kind === "turn");
    if (next.turnStartedAt === null) { if (next.turnUsageBase) next = { ...next, turnUsageBase: null }; }
    else if (state.turnStartedAt === null || turnEnded || next.turnStartedAt !== state.turnStartedAt) next = { ...next, turnUsageBase: next.apiUsage ?? null };
    return next;
  };
}
