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
