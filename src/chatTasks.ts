import { todoItems, type ChatItem } from "./chatState";
import type { TeamMember, TeamSnapshot } from "./agentTeam";
import type { AgentProvider } from "./types";

export type TaskState = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "uncertain";
export type ChatTask = { id: string; title: string; status: TaskState; owner: string; memberId?: string; sourceId?: string; report?: string | null };
export type ChatAttribution = { provider: AgentProvider; label: string; profile?: string; memberId?: string; role?: string; model?: string | null; effort?: string | null; worker?: boolean; busy?: boolean };
export const TASK_STATES: Record<TaskState, string> = { pending: "Pendiente", in_progress: "En curso", completed: "Completada", failed: "Falló", cancelled: "Cancelada", uncertain: "Requiere revisión" };

/** Task tracking is independent of the chat's permissions or planning workflow. */
export function taskInstructions(provider: AgentProvider): string {
  const tools = provider === "claude" ? "TodoWrite or TaskCreate/TaskUpdate" : "update_plan";
  return `For work with multiple meaningful steps, use the available native task tools (${tools}) to publish a short task list and keep its progress current. This works in ordinary chats as well as planning chats. Mark a task in progress when you start it and completed only after verifying its result; keep unfinished work pending. Simple questions and single-step actions do not need a list. Follow the user's task-tracking preferences. Task tracking does not require switching permission modes, creating subagents, or starting a planning workflow. Respect the current permissions and any configured team workflow; use its team-plan tools for delegated work. If task tools are unavailable, say so instead of claiming a list was published.`;
}

/** Only accepted tool results can replace the visible plan. Failed/partial updates cannot finish tasks. */
export function chatTasks(items: ChatItem[], owner: string): ChatTask[] {
  let tasks: ChatTask[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "done") continue;
    if (item.name === "TodoWrite") {
      // An explicitly empty list clears the plan; malformed input cannot erase it.
      if (!Array.isArray(item.input.todos) || item.input.todos.some(todo => !todo || typeof todo !== "object" || typeof (todo as Record<string, unknown>).content !== "string")) continue;
      tasks = todoItems(item.input).slice(0, 128).map((todo, at) => ({ id: `${item.id}:${at}`, title: todo.content, status: todo.status, owner, sourceId: item.id }));
    } else if (item.name === "TaskCreate" && typeof item.input.subject === "string") {
      let nativeId: unknown;
      try { const output = JSON.parse(item.output ?? "null"); nativeId = output?.task?.id ?? output?.taskId ?? output?.id; } catch { /* Native text result below. */ }
      nativeId ??= /Task #(\d+) created/i.exec(item.output ?? "")?.[1];
      const id = typeof nativeId === "string" || typeof nativeId === "number" ? String(nativeId) : item.id;
      if (!tasks.some(task => task.id === `task:${id}`) && tasks.length < 128)
        tasks.push({ id: `task:${id}`, title: item.input.subject.slice(0, 4000), status: "pending", owner, sourceId: item.id });
    } else if (item.name === "TaskUpdate" && typeof item.input.taskId === "string") {
      const id = `task:${item.input.taskId}`;
      if (item.input.status === "deleted") tasks = tasks.filter(task => task.id !== id);
      else tasks = tasks.map(task => task.id !== id ? task : { ...task,
        ...(typeof item.input.subject === "string" ? { title: item.input.subject.slice(0, 4000) } : {}),
        ...(["pending", "in_progress", "completed"].includes(String(item.input.status)) ? { status: item.input.status as TaskState } : {}) });
    }
  }
  return tasks;
}

export function teamTasks(snapshot: TeamSnapshot | null, members: TeamMember[]): ChatTask[] {
  if (!snapshot) return [];
  const owner = (memberId: string) => members.find(member => member.id === memberId)?.name ?? "Subagente";
  const project = (task: TeamSnapshot["tasks"][number]): ChatTask => ({ id: task.key, title: task.instruction, memberId: task.memberId, owner: owner(task.memberId),
    status: task.status === "queued" ? "pending" : task.status === "running" || task.status === "claimed" ? "in_progress" : task.status,
    report: task.report });
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
