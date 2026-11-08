import { useId, useState } from "react";
import { TEAM_ROLES, teamTaskActive, type AgentTeam, type TeamBudget, type TeamMember, type TeamSnapshot } from "../agentTeam";
import { agentPermissionLabel } from "../agentPermissions";
import { chatActivity, currentModel, formatTokens, modelName, type ChatState } from "../chatState";
import { budgetExhausted, budgetLabel, MEMBER_BUDGET_PRESETS, raisedBudget, TEAM_BUDGET_PRESETS, teamBudgetUse } from "../teamBudget";
import { accountGroups, QUOTA_WARNING, type AccountQuota, type TeamUsageView } from "../teamUsage";
import { costLabel } from "../tokenUsage";
import AgentIcon from "./AgentIcon";
import { permissionRisk } from "./chat/ComposerSettings";
import Select from "./Select";
import { AlertIcon, ChevronIcon, GaugeIcon, RotateIcon, StopIcon } from "./Icons";
import "./TeamUsage.css";

type Props = { team: AgentTeam; states: Record<string, ChatState>; snapshot: TeamSnapshot | null; starting: boolean; busy: boolean;
  onStop: () => void; onResume: () => void; onLoad: (member: TeamMember) => void; /** Abre la conversación completa de un subagente. */ onOpen?: (member: TeamMember) => void; onRecover: (member: TeamMember) => void;
  canRecover: (member: TeamMember) => boolean;
  /** Tokens nuevos por participante, contexto y cuota de su cuenta. */
  usage?: TeamUsageView; onBudgetChange?: (budget: TeamBudget | null) => void };

const percentText = (value: number): string => `${Math.round(value)} %`;
const quotaText = (quota: AccountQuota): string =>
  [quota.fiveHour ? `5 h ${percentText(quota.fiveHour.percent)}` : null, quota.week ? `Semana ${percentText(quota.week.percent)}` : null].filter(Boolean).join(" · ");
const quotaLevel = (peak: number | null): string => peak === null ? "" : peak >= 90 ? " critical" : peak >= QUOTA_WARNING ? " warning" : "";

/** Anillo diminuto con el contexto ocupado de una sesión. */
function ContextRing({ percent }: { percent: number | null }) {
  const length = 2 * Math.PI * 5;
  const filled = percent === null ? 0 : Math.max(percent, percent > 0 ? 4 : 0);
  return <span className={`team-usage-context${percent !== null && percent >= 70 ? percent >= 90 ? " critical" : " warning" : ""}`}
    aria-label={percent === null ? "Contexto sin medir" : `Contexto ${percentText(percent)}`} role="img">
    <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
      <circle className="track" cx="7" cy="7" r="5" />
      <circle className="value" cx="7" cy="7" r="5" strokeDasharray={length} strokeDashoffset={length * (1 - filled / 100)} />
    </svg>
    <span aria-hidden="true">{percent === null ? "—" : percentText(percent)}</span>
  </span>;
}

const presetOptions = (presets: (number | null)[], current: number | null) => [...new Set([...presets, current])]
  .sort((a, b) => (a ?? Infinity) - (b ?? Infinity)).map(value => ({ value: value === null ? "" : String(value), label: budgetLabel(value) }));

export default function AgentTeamToolbar({ team, states, snapshot, starting, busy, onStop, onResume, onLoad, onOpen, onRecover, canRecover, usage, onBudgetChange }: Props) {
  const [expanded, setExpanded] = useState(false), id = useId();
  const paused = ["paused", "failed"].includes(team.phase), members = [team.master, ...team.workers];
  const active = snapshot?.tasks.filter(task => ["claimed", "running"].includes(task.status)).length ?? 0;
  const status = paused ? "En pausa" : team.setup && !busy ? "Listo para tu idea" : team.phase === "completed" ? "Completado" : "Equipo activo";
  const budget = team.budget ?? null, spent = teamBudgetUse(team);
  const total = usage?.total ?? null, cost = costLabel(total?.costUsd);
  const limit = spent.team.limit, ratio = limit ? Math.min(1, spent.team.used / limit) : 0;
  const exhausted = budgetExhausted(team.error);
  const raise = (): void => {
    if (!onBudgetChange) return;
    const memberOver = team.workers.some(worker => { const use = spent.members[worker.id]; return use?.limit != null && use.used >= use.limit; });
    onBudgetChange({ teamTokens: limit !== null && spent.team.used >= limit ? raisedBudget(limit) : budget?.teamTokens ?? null,
      memberTokens: memberOver ? raisedBudget(budget?.memberTokens ?? null, MEMBER_BUDGET_PRESETS) : budget?.memberTokens ?? null });
  };
  const groups = accountGroups(members.map(member => ({ id: member.id, profileId: member.agent.profileId, profileName: member.agent.profileName, member })));
  return <section className="agent-team-toolbar" aria-label="Equipo de agentes">
    <div className="agent-team-heading"><AgentIcon kind={team.master.agent.provider} size={16} activity={busy ? "working" : "idle"} />
      <div><strong title={team.master.name}>{team.master.name}</strong><span role="status">{status}{active > 0 ? ` · ${active} en curso` : ` · ${team.workers.length} subagentes`}</span></div>
      {paused || team.phase === "completed" ? <button type="button" className="agent-team-control" disabled={starting} onClick={onResume} title={paused ? "Revisado: reanudar equipo" : "Iniciar nuevo ciclo"} aria-label={paused ? "Revisado: reanudar equipo" : "Iniciar nuevo ciclo"}><RotateIcon size={14} /></button> :
        (!team.setup || busy) && <button type="button" className="agent-team-control" onClick={onStop} title="Detener equipo" aria-label="Detener equipo"><StopIcon size={13} /></button>}
    </div>
    {(total && total.newTokens > 0 || limit !== null) && <div className="team-usage-summary">
      <span className="team-usage-total" title={total?.cacheReadTokens ? `Además, ${total.cacheReadTokens.toLocaleString("es")} tokens leídos de caché` : undefined}>
        <GaugeIcon size={12} /><strong>{formatTokens(total?.newTokens ?? 0)}</strong> tokens nuevos{cost ? ` · ${cost}` : ""}
      </span>
      {limit !== null && <span className="team-budget">
        <span className={`team-budget-meter${ratio >= 1 ? " critical" : ratio >= .8 ? " warning" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(spent.team.used, limit)}
          aria-label={`Presupuesto del equipo: ${spent.team.used.toLocaleString("es")} de ${limit.toLocaleString("es")} tokens nuevos`}><i style={{ width: `${Math.round(ratio * 100)}%` }} /></span>
        <span className="team-budget-text">{percentText(ratio * 100)} de {formatTokens(limit)}</span>
      </span>}
    </div>}
    <button type="button" className="agent-team-disclosure" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <span className="agent-team-avatars" aria-hidden="true">{members.slice(0, 4).map(member => <AgentIcon key={member.id} kind={member.agent.provider} size={13} activity={states[member.id] ? chatActivity(states[member.id]) : "idle"} />)}</span>
      <span>Agentes, uso y permisos</span><ChevronIcon size={13} />
    </button>
    {team.error && <p className="agent-team-error" role="status">{team.error}</p>}
    {exhausted && onBudgetChange && <div className="team-budget-actions">
      <button type="button" className="btn btn-small btn-ghost" onClick={raise}>Ampliar presupuesto</button>
      <button type="button" className="btn btn-small btn-ghost" onClick={() => onBudgetChange(null)}>Quitar límites</button>
    </div>}
    <div id={id} className="agent-team-members" hidden={!expanded}>
      {onBudgetChange && <div className="team-budget-controls">
        <span className="team-budget-label">Presupuesto</span>
        <Select value={budget?.teamTokens ? String(budget.teamTokens) : ""} aria-label={`Presupuesto del equipo: ${budgetLabel(budget?.teamTokens)}`} align="start"
          options={presetOptions(TEAM_BUDGET_PRESETS, budget?.teamTokens ?? null)} onChange={value => onBudgetChange({ teamTokens: value ? Number(value) : null, memberTokens: budget?.memberTokens ?? null })} />
        <Select value={budget?.memberTokens ? String(budget.memberTokens) : ""} aria-label={`Presupuesto por agente: ${budgetLabel(budget?.memberTokens)}`} align="start"
          options={presetOptions(MEMBER_BUDGET_PRESETS, budget?.memberTokens ?? null).map(option => option.value ? { ...option, label: option.label + " por agente" } : { ...option, label: "Sin límite por agente" })}
          onChange={value => onBudgetChange({ teamTokens: budget?.teamTokens ?? null, memberTokens: value ? Number(value) : null })} />
      </div>}
      {groups.map(group => {
        const quota = usage?.members[group.members[0].id]?.quota ?? null;
        return <section className="team-account-group" key={group.profileId} aria-label={`Cuenta ${group.profileName}`}>
          <header className="team-account-heading">
            <span className="team-account-name">{group.profileName}</span>
            {group.members.length > 1 && <small>{group.members.length} agentes comparten esta cuenta</small>}
            {quota && <span className={`team-quota${quotaLevel(quota.peak)}`} aria-label={`Uso del plan de ${group.profileName}: ${quotaText(quota)}`}>{quotaText(quota)}</span>}
          </header>
          {group.members.map(({ member }) => {
            const state = states[member.id], model = state ? currentModel(state.models, state.model, state.modelChoice) : null;
            const task = snapshot?.tasks.find(task => task.memberId === member.id && teamTaskActive(task));
            const entry = usage?.members[member.id], memberCost = costLabel(entry?.usage?.costUsd);
            const memberBudget = spent.members[member.id];
            const warn = entry?.quota && entry.quota.peak !== null && entry.quota.peak >= QUOTA_WARNING ? entry.quota : null;
            return <div className="agent-team-member" key={member.id}>
              <div className="agent-team-member-title"><AgentIcon kind={member.agent.provider} size={14} /><strong>{member.name}</strong><small data-risk={member.mode ? permissionRisk(member.mode) : member.canWrite ? "ask" : "read"}>{agentPermissionLabel(member.agent.provider, member.mode, member.canWrite)}</small></div>
              <span>{member.id === team.master.id ? "Principal" : TEAM_ROLES[member.role].name} · {member.agent.profileName}</span>
              <span>{model ? modelName(model) : member.agent.model ?? "Modelo del perfil"}{member.agent.effort ? ` · ${member.agent.effort}` : ""}</span>
              <span className="team-member-usage">
                <ContextRing percent={entry?.contextPercent ?? null} />
                <span className="team-member-tokens" aria-label={`${(entry?.usage?.newTokens ?? 0).toLocaleString("es")} tokens nuevos`}>{formatTokens(entry?.usage?.newTokens ?? 0)} tokens</span>
                {memberBudget?.limit != null && <span className="team-member-budget">de {formatTokens(memberBudget.limit)}</span>}
                {memberCost && <span className="team-member-cost">{memberCost}</span>}
                {warn && <span className={`team-quota${quotaLevel(warn.peak)}`} title={quotaText(warn)} aria-label={`Cuenta al ${percentText(warn.peak ?? 0)} de su cuota`}><AlertIcon size={11} />{percentText(warn.peak ?? 0)}</span>}
              </span>
              {task && <small className="agent-team-task">{task.status === "queued" ? "En espera" : task.status === "claimed" ? "Preparando" : "Trabajando"}</small>}
              <div className="agent-team-member-actions"><button type="button" disabled={starting || paused && !member.conversationId} onClick={() => member.id !== team.master.id && onOpen ? onOpen(member) : onLoad(member)}>{paused && !member.conversationId ? "Sin historial" : state?.process === "failed" ? "Reintentar" : member.id !== team.master.id && onOpen ? "Abrir" : "Cargar historial"}</button>
                {canRecover(member) && <button type="button" disabled={starting} onClick={() => onRecover(member)}>Confirmar revisión de operaciones</button>}</div>
            </div>;
          })}
        </section>;
      })}
    </div>
  </section>;
}
