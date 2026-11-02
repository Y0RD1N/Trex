import { useId, useState } from "react";
import { TEAM_ROLES, teamTaskActive, type AgentTeam, type TeamMember, type TeamSnapshot } from "../agentTeam";
import { agentPermissionLabel } from "../agentPermissions";
import { chatActivity, currentModel, modelName, type ChatState } from "../chatState";
import AgentIcon from "./AgentIcon";
import { ChevronIcon, RotateIcon, StopIcon } from "./Icons";

type Props = { team: AgentTeam; states: Record<string, ChatState>; snapshot: TeamSnapshot | null; starting: boolean; busy: boolean;
  onStop: () => void; onResume: () => void; onLoad: (member: TeamMember) => void; onRecover: (member: TeamMember) => void;
  canRecover: (member: TeamMember) => boolean };
export default function AgentTeamToolbar({ team, states, snapshot, starting, busy, onStop, onResume, onLoad, onRecover, canRecover }: Props) {
  const [expanded, setExpanded] = useState(false), id = useId();
  const paused = ["paused", "failed"].includes(team.phase), members = [team.master, ...team.workers];
  const active = snapshot?.tasks.filter(task => ["claimed", "running"].includes(task.status)).length ?? 0;
  const status = paused ? "En pausa" : team.setup && !busy ? "Listo para tu idea" : team.phase === "completed" ? "Completado" : "Equipo activo";
  return <section className="agent-team-toolbar" aria-label="Equipo de agentes">
    <div className="agent-team-heading"><AgentIcon kind={team.master.agent.provider} size={16} activity={busy ? "working" : "idle"} />
      <div><strong title={team.master.name}>{team.master.name}</strong><span role="status">{status}{active > 0 ? ` · ${active} en curso` : ` · ${team.workers.length} subagentes`}</span></div>
      {paused || team.phase === "completed" ? <button type="button" className="agent-team-control" disabled={starting} onClick={onResume} title={paused ? "Revisado: reanudar equipo" : "Iniciar nuevo ciclo"} aria-label={paused ? "Revisado: reanudar equipo" : "Iniciar nuevo ciclo"}><RotateIcon size={14} /></button> :
        (!team.setup || busy) && <button type="button" className="agent-team-control" onClick={onStop} title="Detener equipo" aria-label="Detener equipo"><StopIcon size={13} /></button>}
    </div>
    <button type="button" className="agent-team-disclosure" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <span className="agent-team-avatars" aria-hidden="true">{members.slice(0, 4).map(member => <AgentIcon key={member.id} kind={member.agent.provider} size={13} activity={states[member.id] ? chatActivity(states[member.id]) : "idle"} />)}</span>
      <span>Agentes y permisos</span><ChevronIcon size={13} />
    </button>
    {team.error && <p className="agent-team-error" role="status">{team.error}</p>}
    <div id={id} className="agent-team-members" hidden={!expanded}>
      {members.map(member => {
        const state = states[member.id], model = state ? currentModel(state.models, state.model, state.modelChoice) : null;
        const task = snapshot?.tasks.find(task => task.memberId === member.id && teamTaskActive(task));
        return <div className="agent-team-member" key={member.id}>
          <div className="agent-team-member-title"><AgentIcon kind={member.agent.provider} size={14} /><strong>{member.name}</strong><small>{agentPermissionLabel(member.agent.provider, member.mode, member.canWrite)}</small></div>
          <span>{TEAM_ROLES[member.role].name} · {member.agent.profileName}</span>
          <span>{model ? modelName(model) : member.agent.model ?? "Modelo del perfil"}{member.agent.effort ? ` · ${member.agent.effort}` : ""}</span>
          {task && <small className="agent-team-task">{task.status === "queued" ? "En espera" : task.status === "claimed" ? "Preparando" : "Trabajando"}</small>}
          <div className="agent-team-member-actions"><button type="button" disabled={starting || paused && !member.conversationId} onClick={() => onLoad(member)}>{paused && !member.conversationId ? "Sin historial" : state?.process === "failed" ? "Reintentar" : "Cargar historial"}</button>
            {canRecover(member) && <button type="button" disabled={starting} onClick={() => onRecover(member)}>Confirmar revisión de operaciones</button>}</div>
        </div>;
      })}
    </div>
  </section>;
}
