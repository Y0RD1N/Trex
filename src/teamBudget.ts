/**
 * Presupuesto de tokens nuevos del equipo (las lecturas de caché no cuentan).
 * Se comprueba antes de iniciar cada delegación: al agotarse, la delegación no
 * empieza y el equipo se pausa para que el usuario decida si lo amplía.
 */
import type { AgentTeam } from "./agentTeam";
import { formatTokens } from "./chatState";

export const TEAM_BUDGET_PRESETS: (number | null)[] = [null, 250_000, 500_000, 1_000_000, 2_000_000];
export const MEMBER_BUDGET_PRESETS: (number | null)[] = [null, 100_000, 250_000, 500_000, 1_000_000];
export const BUDGET_EXHAUSTED = "Presupuesto agotado";

export const budgetLabel = (tokens: number | null | undefined): string => tokens == null ? "Sin límite" : `${formatTokens(tokens)} tokens`;

export type BudgetUse = { used: number; limit: number | null; remaining: number | null };
type Budgeted = Pick<AgentTeam, "budget" | "usage" | "master" | "workers">;
const use = (used: number, limit: number | null): BudgetUse => ({ used, limit, remaining: limit === null ? null : Math.max(0, limit - used) });

/** Lo usado por el equipo y por cada participante; el límite por agente solo aplica a subagentes. */
export function teamBudgetUse(team: Budgeted): { team: BudgetUse; members: Record<string, BudgetUse> } {
  const ledger = team.usage ?? {}, budget = team.budget ?? null;
  const members = Object.fromEntries([team.master, ...team.workers].map(member =>
    [member.id, use(ledger[member.id]?.newTokens ?? 0, member.id === team.master.id ? null : budget?.memberTokens ?? null)]));
  const used = Object.values(ledger).reduce((sum, usage) => sum + usage.newTokens, 0);
  return { team: use(used, budget?.teamTokens ?? null), members };
}

/** Motivo para no iniciar una delegación; null mientras quede presupuesto. */
export function budgetRefusal(team: Budgeted, memberId: string): string | null {
  const { team: total, members } = teamBudgetUse(team);
  if (total.limit !== null && total.used >= total.limit)
    return `${BUDGET_EXHAUSTED}: el equipo ha usado ${formatTokens(total.used)} de ${formatTokens(total.limit)} tokens nuevos.`;
  const member = members[memberId], name = team.workers.find(worker => worker.id === memberId)?.name ?? memberId;
  if (member?.limit != null && member.used >= member.limit)
    return `${BUDGET_EXHAUSTED}: ${name} ha usado ${formatTokens(member.used)} de ${formatTokens(member.limit)} tokens nuevos por agente.`;
  return null;
}

/** Lo que queda para una delegación: el menor entre el equipo y el agente. */
export function budgetRemaining(team: Budgeted, memberId: string): number | null {
  const { team: total, members } = teamBudgetUse(team);
  const values = [total.remaining, members[memberId]?.remaining ?? null].filter((value): value is number => value !== null);
  return values.length ? Math.min(...values) : null;
}

/** Nota orientativa para el subagente: el límite real se aplica antes de empezar. */
export function budgetNote(remaining: number | null): string {
  return remaining === null ? "" : ` Presupuesto orientativo restante: ${remaining.toLocaleString("es")} tokens; trabaja de forma económica (lee solo lo necesario, informes breves).`;
}

/** Siguiente escalón para ampliar un límite: el preajuste superior o el doble. */
export function raisedBudget(limit: number | null, presets: (number | null)[] = TEAM_BUDGET_PRESETS): number | null {
  if (limit === null) return null;
  return presets.find((value): value is number => value !== null && value > limit) ?? limit * 2;
}

export const budgetExhausted = (error: string | null | undefined): boolean => !!error?.startsWith(BUDGET_EXHAUSTED);
