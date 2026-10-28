import type { Json } from "./chatState";

/** App-owned fallback: independent of the provider's built-in planning tools. */
export const TASK_TOOL = "trex_update_tasks";
export const MCP_TASK_TOOL = `mcp__trex_inbox__${TASK_TOOL}`;
export const taskTool = {
  name: TASK_TOOL,
  description: "Publish or replace this chat's visible task list, in ordinary chats or planning mode. Mark the current step in_progress, verified work completed and unfinished work pending. At most one step can be in progress. plan:[] clears the list. This only tracks tasks: it never executes work, edits workspace files or changes permissions. Maximum 64 steps and 32 KiB of JSON arguments.",
  inputSchema: { type: "object", properties: { plan: { type: "array", maxItems: 64, items: {
    type: "object", properties: { step: { type: "string", minLength: 1, maxLength: 2000 }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
    required: ["step", "status"], additionalProperties: false,
  } } }, required: ["plan"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export type TaskPlan = { plan: { step: string; status: "pending" | "in_progress" | "completed" }[] };
export function parseTaskPlan(value: unknown): TaskPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Json;
  if (Object.keys(input).some(key => key !== "plan") || !Array.isArray(input.plan) || input.plan.length > 64) return null;
  let active = 0;
  for (const raw of input.plan) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const step = raw as Json;
    if (Object.keys(step).some(key => key !== "step" && key !== "status") || typeof step.step !== "string"
      || step.step.length > 4000 || !step.step.trim() || [...step.step].length > 2000 || typeof step.status !== "string"
      || !["pending", "in_progress", "completed"].includes(step.status)) return null;
    if (step.status === "in_progress" && ++active > 1) return null;
  }
  try { if (new TextEncoder().encode(JSON.stringify(input)).length > 32 * 1024) return null; }
  catch { return null; }
  return input as TaskPlan;
}

/** Normalize only an accepted result from our exact app server. */
export function taskToolInput(name: string, input: unknown): Json | null {
  if (name !== MCP_TASK_TOOL) return null;
  const plan = parseTaskPlan(input);
  return plan ? { todos: plan.plan.map(step => ({ content: step.step, status: step.status })) } : null;
}
