import { useState, type ReactNode } from "react";
import type { AgentRoom, RoomRole } from "../agentRoom";
import { agentPermissionLabel } from "../agentPermissions";
import { chatActivity, effortLabel, supportedEfforts, type ChatState } from "../chatState";
import AgentIcon from "./AgentIcon";
import { MapIcon, SettingsIcon, StopIcon } from "./Icons";
import Select from "./Select";

const ROLES: RoomRole[] = ["planner", "executor"];
const ROLE_NAMES = { planner: "Planificador", executor: "Ejecutor" };
const PHASE_NAMES: Record<AgentRoom["phase"], string> = {
  idle: "Listo", planning: "Planificando", waiting: "Espera tu respuesta", transferring: "Preparando contexto",
  executing: "Ejecutando", completed: "Completado", paused: "Pausado", failed: "Revisar error",
};

type Props = {
  room: AgentRoom; states: Partial<Record<RoomRole, ChatState>>; disabled: boolean; busy: boolean;
  onSelect: (role: RoomRole) => void; onModel: (role: RoomRole, value: string) => void;
  onEffort: (role: RoomRole, value: string) => void; onRetry: (role: RoomRole) => void;
  onStop: () => void; onNewPlanning: () => void; onReview: () => void; children?: ReactNode;
};

/** Controles de la sala junto a Tareas; los ajustes se abren solo cuando hacen falta. */
export default function AgentRoomToolbar({ room, states, disabled, busy, onSelect, onModel, onEffort, onRetry, onStop, onNewPlanning, onReview, children }: Props) {
  const [configuring, setConfiguring] = useState(false);
  return <section className={`agent-room-toolbar${configuring ? " is-configuring" : ""}`} aria-label="Planificar y ejecutar">
    <div className="agent-room-participants" aria-label="Participantes de la conversación">
      {ROLES.map(role => {
        const participant = room[role], state = states[role];
        const models = state?.models ?? [], model = state?.modelChoice ?? state?.model ?? participant.agent.model ?? "";
        const efforts = state ? supportedEfforts(models, state.model, state.modelChoice) : [];
        const effort = state?.effortChoice ?? state?.effort ?? participant.agent.effort ?? "";
        return <div key={role} className={`agent-room-participant${room.active === role ? " is-selected" : ""}`}>
          <button type="button" className="agent-room-person" aria-pressed={room.active === role} disabled={disabled && room.active !== role}
            onClick={() => onSelect(role)} title={`${ROLE_NAMES[role]} · ${participant.agent.profileName} · ${agentPermissionLabel(participant.agent.provider, participant.mode, role !== "planner")}\n${model || "Modelo del perfil"} · ${effort ? effortLabel(effort) : "Esfuerzo del perfil"}`}>
            <AgentIcon kind={participant.agent.provider} size={15} activity={state ? chatActivity(state) : "idle"} />
            <span><strong>{ROLE_NAMES[role]}</strong><small>{participant.agent.profileName}</small></span>
            <span className="sr-only">{agentPermissionLabel(participant.agent.provider, participant.mode, role !== "planner")}</span>
          </button>
          {configuring && <div className="agent-room-settings">
            {models.length ? <Select aria-label={`Modelo del ${ROLE_NAMES[role].toLowerCase()}`} value={model} disabled={disabled}
              options={models.map(item => ({ value: item.value, label: item.displayName }))} onChange={value => onModel(role, value)} />
              : <span title={model || "Modelo del perfil"}>{model || "Modelo del perfil"}</span>}
            {efforts.length ? <Select aria-label={`Esfuerzo del ${ROLE_NAMES[role].toLowerCase()}`} value={effort} disabled={disabled}
              placeholder="Esfuerzo del perfil" options={efforts.map(value => ({ value, label: effortLabel(value) }))}
              onChange={value => onEffort(role, value)} /> : <span>{effort ? effortLabel(effort) : "Esfuerzo del perfil"}</span>}
          </div>}
          {configuring && <p className="agent-room-permission"><span>Permisos</span>{agentPermissionLabel(participant.agent.provider, participant.mode, role !== "planner")}</p>}
          {state && ["failed", "exited"].includes(state.process) && <div className="agent-room-runtime-error">
            <span>Sin conexión</span><button type="button" className="agent-room-action" disabled={busy}
              onClick={() => onRetry(role)} aria-label={`Reintentar ${ROLE_NAMES[role].toLowerCase()}`}>Reintentar</button>
          </div>}
        </div>;
      })}
    </div>
    <div className="agent-room-status">
      <span className={`agent-room-phase phase-${room.phase}`} role="status">{PHASE_NAMES[room.phase]}</span>
      <span className="agent-room-cycle">Ciclo {room.cycle}</span>
      {busy && <button type="button" className="agent-room-action agent-room-icon-action" onClick={onStop} aria-label="Detener flujo" title="Detener flujo"><StopIcon size={13} /></button>}
      <button type="button" className="agent-room-action agent-room-icon-action" disabled={disabled} onClick={onNewPlanning} aria-label="Nueva planificación" title="Nueva planificación"><MapIcon size={14} /></button>
      <button type="button" className="agent-room-action agent-room-icon-action" aria-expanded={configuring} onClick={() => setConfiguring(value => !value)} aria-label="Modelos y esfuerzo del flujo" title="Modelos y esfuerzo"><SettingsIcon size={14} /></button>
    </div>
    {["paused", "failed"].includes(room.phase) && <button type="button" className="agent-room-action agent-room-review" onClick={onReview}>Revisar y reanudar</button>}
    {children}
  </section>;
}
