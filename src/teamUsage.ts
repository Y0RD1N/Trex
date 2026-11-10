/**
 * Consumo del equipo: tokens nuevos atribuibles a cada participante desde que
 * empezó el equipo, contexto de cada sesión y cuota de cada cuenta (5 h y
 * semana). Leer la cuota de una cuenta no envía mensajes al modelo.
 */
import { refreshAccount } from "./accountUsageStore";
import { teamMemberUsesBrowser, type AgentTeam, type TaskUsage, type TeamMember } from "./agentTeam";
import { contextPercent, type ChatState } from "./chatState";
import { accountUsageWindows, type PlanUsage } from "./planUsage";
import { addUsageTotals, EMPTY_USAGE, subtractApiUsage, subtractUsageTotals, usageTotals, type ApiUsage } from "./tokenUsage";
import type { LauncherProfile, Settings } from "./types";
import type { ChatSession } from "./hooks/chatSession";

export const QUOTA_WARNING = 75;
export const QUOTA_BLOCK = 98;
export type QuotaWindowView = { percent: number; resetsAt: number | null };
export type AccountQuota = { key: string; label: string; fiveHour: QuotaWindowView | null; week: QuotaWindowView | null; peak: number | null; blocked: boolean };

/** Ventanas generales de la cuenta; los límites por modelo no bloquean al resto. */
export function accountQuota(key: string, label: string, plan: PlanUsage | null | undefined): AccountQuota | null {
  if (!plan) return null;
  const { session, weekly } = accountUsageWindows(plan);
  const view = (window: typeof session): QuotaWindowView | null => window ? { percent: window.percent, resetsAt: window.resetsAt } : null;
  const fiveHour = view(session), week = view(weekly);
  if (!fiveHour && !week) return null;
  const peak = Math.max(fiveHour?.percent ?? 0, week?.percent ?? 0);
  return { key, label, fiveHour, week, peak, blocked: peak >= QUOTA_BLOCK };
}

/** Lectura de /usage de la cuenta, compartida unos minutos con la pestaña «Uso» y los chats. */
export function readAccountPlan(profile: LauncherProfile, settings: Settings, cwd: string): Promise<PlanUsage | null> {
  return refreshAccount(profile, { maxAge: 5 * 60_000, read: { settings, cwd } });
}

export type UsageObservation = { usage: ApiUsage | null; active: boolean };
type Observed = Pick<ChatState, "apiUsage" | "pendingTurns" | "turnStartedAt" | "historyCount">;
/**
 * Consumo nuevo desde la observación anterior de una sesión. Solo cuenta lo
 * medido alrededor de un turno: cargar el historial de una conversación
 * restaurada informa su total anterior, que no es trabajo de este equipo.
 */
export function observeUsage(previous: UsageObservation | undefined, state: Observed): { next: UsageObservation; delta: TaskUsage | null } {
  const active = state.pendingTurns > 0 || state.turnStartedAt !== null;
  const next = { usage: state.apiUsage, active };
  if (!previous || previous.usage === state.apiUsage) return { next, delta: null };
  if (!previous.active && !active || previous.usage === null && state.historyCount > 0) return { next, delta: null };
  return { next, delta: usageTotals(subtractApiUsage(state.apiUsage, previous.usage)) };
}
/** Usage of one delegation: the member's attributed growth since it started. */
export const usageSince = (after: TaskUsage | null | undefined, before: TaskUsage | null | undefined): TaskUsage | null => subtractUsageTotals(after, before);

export const COMPACT_PERCENT = 50;
export const COMPACT_TOKENS = 120_000;
/** A session with history whose context is half full (or very large) is summarized before new work. */
export function compactionNeeded(state: Pick<ChatState, "usage" | "historyCount" | "items">): { percent: number | null; tokens: number } | null {
  const usage = state.usage;
  if (!usage || usage.measured === false || !(state.historyCount > 0 || state.items.some(item => item.kind === "user"))) return null;
  const percent = contextPercent(usage);
  return percent !== null && percent >= COMPACT_PERCENT || usage.used >= COMPACT_TOKENS ? { percent, tokens: usage.used } : null;
}
/** Uses the session's own /compact (as the context menu does); false when it has none. */
export function requestCompaction(session: Pick<ChatSession, "provider" | "supportsCompact" | "runCommand" | "send">): boolean {
  if (session.provider === "trex") return !!session.supportsCompact && session.runCommand("compact", "");
  if (session.provider === "codex") return session.runCommand("compact", "");
  if (session.provider === "claude") { void Promise.resolve(session.send("/compact", [], [])).catch(() => undefined); return true; }
  return false;
}

export function addToLedger(ledger: Record<string, TaskUsage> | undefined, memberId: string, delta: TaskUsage): Record<string, TaskUsage> {
  return { ...ledger, [memberId]: addUsageTotals(ledger?.[memberId], delta) ?? delta };
}
export function teamUsageTotal(ledger: Record<string, TaskUsage> | undefined): TaskUsage {
  return Object.values(ledger ?? {}).reduce<TaskUsage>((sum, usage) => addUsageTotals(sum, usage) ?? sum, EMPTY_USAGE);
}

/** Plan de la cuenta: el que informa la propia sesión o, si aún no, la lectura de /usage. */
export function memberQuota(member: TeamMember, state: ChatState | undefined, plans: Record<string, PlanUsage | null>): AccountQuota | null {
  return accountQuota(member.agent.profileId, member.agent.profileName, state?.plan ?? plans[member.agent.profileId]);
}

export type MemberUsageView = { usage: TaskUsage | null; contextPercent: number | null; quota: AccountQuota | null };
export type TeamUsageView = { total: TaskUsage; members: Record<string, MemberUsageView> };
export function teamUsageView(team: AgentTeam, states: Record<string, ChatState>, plans: Record<string, PlanUsage | null>): TeamUsageView {
  const members = Object.fromEntries([team.master, ...team.workers].map(member => [member.id, {
    usage: team.usage?.[member.id] ?? null, contextPercent: contextPercent(states[member.id]?.usage ?? null), quota: memberQuota(member, states[member.id], plans),
  }]));
  return { total: teamUsageTotal(team.usage), members };
}

/** Lo que leen las herramientas del principal (trex_team_members y las delegaciones). */
export type TeamUsageReport = {
  epoch: string;
  budget: { teamTokens?: number; memberTokens?: number };
  members: { memberId: string; coordinator: boolean; usage: TaskUsage; contextPercent?: number; browser?: boolean;
    account?: { key: string; label: string; fiveHour?: QuotaWindowView; week?: QuotaWindowView; blocked: boolean } }[];
};
export function teamUsageReport(team: AgentTeam, view: TeamUsageView, browserEnabled: boolean): TeamUsageReport {
  const budget = team.budget ?? null;
  return {
    epoch: team.epoch,
    budget: { ...(budget?.teamTokens ? { teamTokens: budget.teamTokens } : {}), ...(budget?.memberTokens ? { memberTokens: budget.memberTokens } : {}) },
    members: [team.master, ...team.workers].map(member => {
      const entry = view.members[member.id], quota = entry?.quota;
      return { memberId: member.id, coordinator: member.id === team.master.id, usage: entry?.usage ?? EMPTY_USAGE,
        ...(entry?.contextPercent != null ? { contextPercent: Math.round(entry.contextPercent) } : {}),
        ...(browserEnabled ? { browser: teamMemberUsesBrowser(member) } : {}),
        ...(quota ? { account: { key: /^[A-Za-z0-9_-]{1,100}$/.test(quota.key) ? quota.key : "", label: quota.label.slice(0, 120),
          ...(quota.fiveHour ? { fiveHour: quota.fiveHour } : {}), ...(quota.week ? { week: quota.week } : {}), blocked: quota.blocked } } : {}) };
    }),
  };
}

/** Accounts shared by the members, for grouping and for the pre-launch summary. */
export function accountGroups<T extends { id: string; profileId: string; profileName: string }>(members: T[]): { profileId: string; profileName: string; members: T[] }[] {
  const groups = new Map<string, { profileId: string; profileName: string; members: T[] }>();
  for (const member of members) {
    const group = groups.get(member.profileId) ?? { profileId: member.profileId, profileName: member.profileName, members: [] };
    group.members.push(member); groups.set(member.profileId, group);
  }
  return [...groups.values()];
}
