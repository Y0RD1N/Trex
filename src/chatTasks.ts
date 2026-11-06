import { todoItems, type ChatItem } from "./chatState";
import type { TeamMember, TeamSnapshot } from "./agentTeam";
import type { AgentProvider } from "./types";
import { MCP_TASK_TOOL } from "./taskTools";

export type TaskState = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "uncertain";
export type ChatTask = { id: string; title: string; status: TaskState; owner: string; memberId?: string; sourceId?: string; report?: string | null;
  /** When work on it started and finished (ms since epoch), when known. */
  startedAt?: number; completedAt?: number;
  /** The agent completed it without marking it in progress: the start is the previous plan update. */
  approximate?: boolean };
export type ChatAttribution = { provider: AgentProvider; label: string; profile?: string; memberId?: string; role?: string; model?: string | null; effort?: string | null; worker?: boolean; busy?: boolean };
export const TASK_STATES: Record<TaskState, string> = { pending: "Pendiente", in_progress: "En curso", completed: "Completada", failed: "Falló", cancelled: "Cancelada", uncertain: "Requiere revisión" };

/** Task tracking is independent of the chat's permissions or planning workflow. */
export function taskInstructions(provider: AgentProvider): string {
  // Trex CLI ya pide la lista de tareas con update_plan y no marcar lo no verificado (su prompt de sistema).
  if (provider === "trex") return "Skip task lists for simple questions or single actions and follow the user's tracking preferences; team workflows use their team-plan tools.";
  const tools = `${MCP_TASK_TOOL} (plan:[{step,status}]; preferred over native ${provider === "claude" ? "TodoWrite or TaskCreate/TaskUpdate" : "update_plan"}, available even without it)`;
  return `For multi-step work, in ordinary chats too, publish a short task list before starting with ${tools} and keep it updated: in progress when you start a task, completed only after verifying its result, unfinished work pending. Skip lists for simple questions or single actions; follow the user's tracking preferences. Tracking needs no mode change, subagent or planning workflow; respect permissions and any team workflow (its team-plan tools for delegated work). If task tools are unavailable, say so; never claim a list was published.`;
}

/** Native task IDs belong to one participant's session, not the shared room. */
export function roomTasks(items: ChatItem[], names: { planner: string; executor: string }): ChatTask[] {
  const byRole: Record<"planner" | "executor", ChatItem[]> = { planner: [], executor: [] };
  let latest: "planner" | "executor" | null = null;
  for (const item of items) {
    const role = item.id.startsWith("planner::") ? "planner" : item.id.startsWith("executor::") ? "executor" : null;
    if (!role) continue;
    // A new request to the planner after execution begins a fresh cycle.
    // Keep clarifications within the same planning cycle together.
    if (role === "planner" && item.kind === "user" && byRole.executor.some(entry => entry.kind === "user" || entry.kind === "tool" && entry.status === "done" && ["TodoWrite", "TaskCreate", "TaskUpdate"].includes(entry.name))) {
      byRole.planner = []; byRole.executor = []; latest = null;
    }
    byRole[role].push(item);
    if (item.kind === "tool" && item.status === "done" && ["TodoWrite", "TaskCreate", "TaskUpdate"].includes(item.name)) latest = role;
  }
  if (!latest) return [];
  return chatTasks(byRole[latest], names[latest]);
}

type Timing = { startedAt?: number; completedAt?: number; approximate?: boolean };
/** Follows a task's status across plan updates (at time `at`) to know when it ran. */
function track(timing: Timing | undefined, status: TaskState, at: number | undefined, previousAt: number | undefined): Timing {
  const next: Timing = { ...timing };
  if (at === undefined) return next;
  if (status === "in_progress") {
    if (next.startedAt === undefined || next.completedAt !== undefined) { next.startedAt = next.completedAt !== undefined ? at : next.startedAt ?? at; next.approximate = false; }
    next.completedAt = undefined;
  } else if (status === "completed") {
    if (next.completedAt === undefined) {
      if (next.startedAt === undefined) { next.startedAt = previousAt ?? at; next.approximate = true; }
      next.completedAt = at;
    }
  } else if (status === "pending") { next.completedAt = undefined; if (next.approximate) next.startedAt = undefined; }
  return next;
}
const titleKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");

/** Only accepted tool results can replace the visible plan. Failed/partial updates cannot finish tasks. */
export function chatTasks(items: ChatItem[], owner: string): ChatTask[] {
  let tasks: ChatTask[] = [];
  // TodoWrite replaces the whole list each time: its tasks are followed by title.
  const timings = new Map<string, Timing>();
  let previousAt: number | undefined;
  const timed = (task: ChatTask, key: string): ChatTask => { const t = timings.get(key); return t ? { ...task, ...t } : task; };
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "done") continue;
    const at = item.at;
    if (item.name === "TodoWrite") {
      // An explicitly empty list clears the plan; malformed input cannot erase it.
      if (!Array.isArray(item.input.todos) || item.input.todos.some(todo => !todo || typeof todo !== "object" || typeof (todo as Record<string, unknown>).content !== "string")) continue;
      tasks = todoItems(item.input).slice(0, 128).map((todo, index) => {
        const key = `todo:${titleKey(todo.content)}`;
        timings.set(key, track(timings.get(key), todo.status, at, previousAt));
        return timed({ id: `${item.id}:${index}`, title: todo.content, status: todo.status, owner, sourceId: item.id }, key);
      });
      if (at !== undefined) previousAt = at;
    } else if (item.name === "TaskCreate" && typeof item.input.subject === "string") {
      let nativeId: unknown;
      try { const output = JSON.parse(item.output ?? "null"); nativeId = output?.task?.id ?? output?.taskId ?? output?.id; } catch { /* Native text result below. */ }
      nativeId ??= /Task #(\d+) created/i.exec(item.output ?? "")?.[1];
      const id = typeof nativeId === "string" || typeof nativeId === "number" ? String(nativeId) : item.id;
      if (!tasks.some(task => task.id === `task:${id}`) && tasks.length < 128) {
        timings.set(`task:${id}`, track(undefined, "pending", at, previousAt));
        tasks.push({ id: `task:${id}`, title: item.input.subject.slice(0, 4000), status: "pending", owner, sourceId: item.id });
      }
      if (at !== undefined) previousAt = at;
    } else if (item.name === "TaskUpdate" && typeof item.input.taskId === "string") {
      const id = `task:${item.input.taskId}`;
      if (item.input.status === "deleted") tasks = tasks.filter(task => task.id !== id);
      else tasks = tasks.map(task => {
        if (task.id !== id) return task;
        const status = ["pending", "in_progress", "completed"].includes(String(item.input.status)) ? item.input.status as TaskState : task.status;
        timings.set(id, track(timings.get(id), status, at, previousAt));
        return timed({ ...task, ...(typeof item.input.subject === "string" ? { title: item.input.subject.slice(0, 4000) } : {}), status }, id);
      });
      if (at !== undefined) previousAt = at;
    }
  }
  return tasks;
}

export function teamTasks(snapshot: TeamSnapshot | null, members: TeamMember[]): ChatTask[] {
  if (!snapshot) return [];
  const owner = (memberId: string) => members.find(member => member.id === memberId)?.name ?? "Subagente";
  const ms = (value: number) => value > 0 && value < 1e12 ? value * 1000 : value;
  const project = (task: TeamSnapshot["tasks"][number]): ChatTask => {
    const status: TaskState = task.status === "queued" ? "pending" : task.status === "running" || task.status === "claimed" ? "in_progress" : task.status;
    return { id: task.key, title: task.instruction, memberId: task.memberId, owner: owner(task.memberId), status, report: task.report,
      ...(status !== "pending" && task.createdAt > 0 ? { startedAt: ms(task.createdAt) } : {}),
      ...(!["pending", "in_progress"].includes(status) && task.updatedAt > 0 ? { completedAt: ms(task.updatedAt) } : {}) };
  };
  const planned = new Set((snapshot.plan ?? []).map(step => step.taskKey));
  return [
    ...(snapshot.plan ?? []).map((step): ChatTask => {
      const issued = snapshot.tasks.find(task => task.key === step.taskKey);
      return issued ? project(issued) : { id: step.taskKey, title: step.task, memberId: step.memberId, owner: owner(step.memberId), status: "pending" };
    }),
    ...snapshot.tasks.filter(task => !planned.has(task.key)).map(project),
  ];
}

/** Preserve chronological ownership and leave pending permissions outside collapsed groups. */
export function activityGroups(items: ChatItem[], labels?: Record<string, ChatAttribution>) {
  const groups: { start: number; end: number; author?: ChatAttribution }[] = [];
  items.forEach((item, index) => {
    const label = labels?.[item.id];
    const author = label?.worker && !(item.kind === "permission" && item.state === "pending") ? label : undefined;
    const last = groups[groups.length - 1];
    if (author?.memberId && last?.author?.memberId === author.memberId) last.end = index + 1;
    else groups.push({ start: index, end: index + 1, author });
  });
  return groups;
}
