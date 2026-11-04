/** Provider-reported consumption. Context occupancy is a separate measurement. */
export type ApiUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  totalTokens: number | null;
  requests: number | null;
  costUsd: number | null;
  partial: boolean;
  costPartial: boolean;
};
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
export const tokenCount = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export const reportedCost = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export function readApiUsage(raw: unknown): ApiUsage | null {
  const v = object(raw); if (!v) return null;
  const result: ApiUsage = {
    inputTokens: tokenCount(v.inputTokens), outputTokens: tokenCount(v.outputTokens),
    reasoningTokens: tokenCount(v.reasoningTokens ?? v.thoughtTokens),
    cachedReadTokens: tokenCount(v.cachedReadTokens), cachedWriteTokens: tokenCount(v.cachedWriteTokens),
    totalTokens: tokenCount(v.totalTokens), requests: tokenCount(v.requests), costUsd: reportedCost(v.costUsd),
    partial: v.partial === true || tokenCount(v.inputTokens) === null || tokenCount(v.outputTokens) === null, costPartial: v.costPartial === true,
  };
  return Object.entries(result).some(([key, value]) => key !== "partial" && key !== "costPartial" && value !== null) ? result : null;
}
export function addApiUsage(previous: ApiUsage | null, next: ApiUsage | null): ApiUsage | null {
  if (!previous) return next; if (!next) return previous;
  const sum = (a: number | null, b: number | null): number | null => a === null && b === null ? null : tokenCount((a ?? 0) + (b ?? 0));
  return {
    inputTokens: sum(previous.inputTokens, next.inputTokens), outputTokens: sum(previous.outputTokens, next.outputTokens),
    reasoningTokens: sum(previous.reasoningTokens, next.reasoningTokens), cachedReadTokens: sum(previous.cachedReadTokens, next.cachedReadTokens),
    cachedWriteTokens: sum(previous.cachedWriteTokens, next.cachedWriteTokens), totalTokens: sum(previous.totalTokens, next.totalTokens),
    requests: previous.requests === null || next.requests === null ? null : sum(previous.requests, next.requests),
    costUsd: previous.costUsd === null && next.costUsd === null ? null : reportedCost((previous.costUsd ?? 0) + (next.costUsd ?? 0)), partial: previous.partial || next.partial || previous.totalTokens === null || next.totalTokens === null,
    costPartial: previous.costPartial || next.costPartial || previous.costUsd === null || next.costUsd === null,
  };
}

/** Usage of one response: the conversation total after it minus the total before. */
export function subtractApiUsage(after: ApiUsage | null, before: ApiUsage | null): ApiUsage | null {
  if (!after) return null;
  if (!before) return after;
  const minus = (a: number | null, b: number | null): number | null => a === null ? null : Math.max(0, a - (b ?? 0));
  const result: ApiUsage = {
    inputTokens: minus(after.inputTokens, before.inputTokens), outputTokens: minus(after.outputTokens, before.outputTokens),
    reasoningTokens: minus(after.reasoningTokens, before.reasoningTokens), cachedReadTokens: minus(after.cachedReadTokens, before.cachedReadTokens),
    cachedWriteTokens: minus(after.cachedWriteTokens, before.cachedWriteTokens), totalTokens: minus(after.totalTokens, before.totalTokens),
    requests: minus(after.requests, before.requests),
    costUsd: after.costUsd === null ? null : Math.max(0, after.costUsd - (before.costUsd ?? 0)),
    partial: after.partial, costPartial: after.costPartial,
  };
  return result.totalTokens || result.inputTokens || result.outputTokens ? result : null;
}
const n = (v: unknown): number | null => tokenCount(v);
/** Claude Code `usage` (Anthropic API names). Cache tokens are not part of input_tokens. */
export function claudeApiUsage(raw: unknown): ApiUsage | null {
  const v = object(raw); if (!v) return null;
  const input = n(v.input_tokens), output = n(v.output_tokens), read = n(v.cache_read_input_tokens), write = n(v.cache_creation_input_tokens);
  if (input === null && output === null) return null;
  return { inputTokens: input, outputTokens: output, reasoningTokens: null, cachedReadTokens: read, cachedWriteTokens: write,
    totalTokens: (input ?? 0) + (output ?? 0) + (read ?? 0) + (write ?? 0), requests: null, costUsd: null,
    partial: input === null || output === null, costPartial: false };
}
/**
 * OpenAI-compatible totals (Trex CLI) count cache hits inside `inputTokens`:
 * the total then stays below input + output + cache reads. Anthropic and the
 * normalized Codex counters keep cache reads apart, so their totals add up.
 */
export function cacheReadsInInput(usage: ApiUsage): boolean {
  const input = usage.inputTokens ?? 0, output = usage.outputTokens ?? 0, read = usage.cachedReadTokens ?? 0;
  return read > 0 && read <= input && usage.totalTokens !== null && usage.totalTokens < input + output + read;
}
/**
 * Tokens processed anew: uncached input, output (with its reasoning) and cache
 * writes. Cache reads are excluded: they are cheap re-reads of the same prompt
 * and otherwise dominate long conversations. Codex input already excludes them.
 */
export function newTokens(usage: ApiUsage | null | undefined): number | null {
  if (!usage) return null;
  if (usage.inputTokens === null && usage.outputTokens === null) return usage.totalTokens;
  const input = usage.inputTokens ?? 0, output = usage.outputTokens ?? 0, read = usage.cachedReadTokens ?? 0, write = usage.cachedWriteTokens ?? 0;
  if (cacheReadsInInput(usage)) return Math.max(0, input - read) + output;
  // Reasoning reported outside the output count (Gemini thoughts) still has to be generated.
  const counted = input + output + read + write;
  const extra = usage.totalTokens !== null && usage.totalTokens > counted ? usage.totalTokens - counted : 0;
  return input + output + write + extra;
}
/** Cache reads shown as a secondary detail next to the new tokens. */
export const cacheReadTokens = (usage: ApiUsage | null | undefined): number => usage?.cachedReadTokens ?? 0;

/** Compact consumption kept per delegation, member and team. */
export type UsageTotals = { newTokens: number; cacheReadTokens: number; outputTokens: number; costUsd: number | null; requests: number | null };
export const EMPTY_USAGE: UsageTotals = { newTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, requests: null };
export function usageTotals(usage: ApiUsage | null | undefined): UsageTotals | null {
  const fresh = newTokens(usage);
  if (!usage || fresh === null) return null;
  return { newTokens: fresh, cacheReadTokens: cacheReadTokens(usage), outputTokens: usage.outputTokens ?? 0, costUsd: usage.costUsd, requests: usage.requests };
}
export function addUsageTotals(a: UsageTotals | null | undefined, b: UsageTotals | null | undefined): UsageTotals | null {
  if (!a) return b ?? null; if (!b) return a;
  const sum = (x: number | null, y: number | null): number | null => x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return { newTokens: a.newTokens + b.newTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, outputTokens: a.outputTokens + b.outputTokens,
    costUsd: sum(a.costUsd, b.costUsd), requests: sum(a.requests, b.requests) };
}
/** Difference between two cumulative totals; null when nothing new was consumed. */
export function subtractUsageTotals(after: UsageTotals | null | undefined, before: UsageTotals | null | undefined): UsageTotals | null {
  if (!after) return null; if (!before) return after.newTokens || after.outputTokens ? after : null;
  const minus = (x: number | null, y: number | null): number | null => x === null ? null : Math.max(0, x - (y ?? 0));
  const result = { newTokens: Math.max(0, after.newTokens - before.newTokens), cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens), costUsd: minus(after.costUsd, before.costUsd), requests: minus(after.requests, before.requests) };
  return result.newTokens || result.outputTokens || result.cacheReadTokens ? result : null;
}
/** Reported cost only; a missing cost is never shown as free. */
export function costLabel(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value > 0 && value < 0.0001) return "< US$0,0001";
  return value.toLocaleString("es", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 });
}

/** Codex `TokenUsageBreakdown`: cached input is included in inputTokens, reasoning in outputTokens. */
export function codexApiUsage(raw: unknown): ApiUsage | null {
  const v = object(raw); if (!v) return null;
  const input = n(v.inputTokens), cached = n(v.cachedInputTokens), output = n(v.outputTokens);
  if (input === null && output === null) return null;
  return { inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)), outputTokens: output,
    reasoningTokens: n(v.reasoningOutputTokens), cachedReadTokens: cached, cachedWriteTokens: n(v.cacheWriteInputTokens),
    totalTokens: n(v.totalTokens) ?? (input ?? 0) + (output ?? 0), requests: null, costUsd: null,
    partial: input === null || output === null, costPartial: false };
}
