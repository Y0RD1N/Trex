import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AgentProvider, LauncherProfile, Project, Settings } from "../types";
import { handoffTargetReason } from "./HandoffDialog";
import { TEAM_ROLES, MAX_TEAM_WORKERS, type TeamRole } from "../agentTeam";
import { useWorkflowStage } from "./AgentWorkflowDialog";
import type { WorkflowRequest } from "./AgentWorkflowDialog";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import AgentIcon from "./AgentIcon";
import Select from "./Select";
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, CloseIcon, PlusIcon, ShieldIcon } from "./Icons";
import "./AgentTeamDialog.css";

export type TeamMemberChoice = WorkflowRequest["planner"] & { id: string; name: string; role: TeamRole; instructions: string; canWrite: boolean };
export type TeamRequest = { master: TeamMemberChoice; workers: TeamMemberChoice[] };
type Draft = Omit<TeamMemberChoice, "profileId" | "model" | "effort"> & { provider: AgentProvider };
type Selection = WorkflowRequest["planner"] & { ready: boolean };
type Props = FeatureDialogMotionProps & {
  project: Project; profiles: LauncherProfile[]; settings: Settings;
  onClose: () => void; onBack: () => void; onStart: (request: TeamRequest) => void;
  submitting: boolean; error: string | null; initialMaster?: WorkflowRequest["planner"];
};
function MemberEditor({ draft, targets, settings, cwd, disabled, leaving, initial, onChange, onSelection, onRemove, position, onMoveUp, onMoveDown }: {
  draft: Draft; targets: { profile: LauncherProfile; reason: string | null }[]; settings: Settings; cwd: string;
  disabled: boolean; leaving: boolean; initial?: WorkflowRequest["planner"];
  onChange: (patch: Partial<Draft>) => void; onSelection: (id: string, value: Selection) => void; onRemove?: () => void;
  position?: number; onMoveUp?: () => void; onMoveDown?: () => void;
}) {
  const stage = useWorkflowStage(targets, draft.provider, settings, cwd, leaving, initial);
  const latest = useRef(onSelection); latest.current = onSelection;
  const field = useId();
  useEffect(() => latest.current(draft.id, { profileId: stage.profileId, model: stage.model || null, effort: stage.effort, ready: stage.ready }),
    [draft.id, stage.profileId, stage.model, stage.effort, stage.ready]);
  const principal = draft.role === "coordinator";
  return <section className="team-member-editor" aria-label={principal ? "Agente principal" : draft.name}>
    <header><span className="workflow-eyebrow">{principal ? "Agente principal" : `Subagente ${position}`}</span>
      {onRemove && <div className="team-member-controls"><button type="button" className="icon-btn" disabled={disabled || !onMoveUp} onClick={onMoveUp} aria-label={"Subir " + draft.name}><ArrowUpIcon size={13} /></button>
        <button type="button" className="icon-btn" disabled={disabled || !onMoveDown} onClick={onMoveDown} aria-label={"Bajar " + draft.name}><ArrowDownIcon size={13} /></button>
        <button type="button" className="icon-btn" disabled={disabled} onClick={onRemove} aria-label={"Quitar " + draft.name}><CloseIcon size={14} /></button></div>}
    </header>
    <div className="team-member-fields">
      <label className="workflow-field"><span className="workflow-field-label">Nombre</span>
        <input className="input" data-autofocus={principal||undefined} maxLength={80} value={draft.name} disabled={disabled} onChange={event => onChange({ name: event.currentTarget.value })} />
      </label>
      {!principal && <div className="workflow-field">
        <label className="workflow-field-label" htmlFor={field + "-role"}>Función</label>
        <Select id={field + "-role"} value={draft.role} disabled={disabled} align="start"
          options={Object.entries(TEAM_ROLES).filter(([role]) => role !== "coordinator").map(([value, role]) => ({ value, label: role.name, description: role.description }))}
          onChange={value => { const role = value as TeamRole; onChange({ role, canWrite: TEAM_ROLES[role].writes, instructions: TEAM_ROLES[role].description }); }} />
      </div>}
    </div>
    <div className="workflow-field">
      <label className="workflow-field-label" htmlFor={field + "-profile"}>Cuenta o conexión</label>
      <Select id={field + "-profile"} value={stage.profileId} disabled={disabled || !stage.profile} align="start"
        options={targets.map(({ profile, reason }) => ({ value: profile.id, label: profile.name, description: reason ?? profile.provider, disabled: !!reason, icon: <AgentIcon kind={profile.provider} size={16} /> }))}
        onChange={stage.setProfileId} />
    </div>
    <div className="team-member-fields">
      <div className="workflow-field"><label className="workflow-field-label" htmlFor={field + "-model"}>Modelo</label>
        <Select id={field + "-model"} value={stage.model} options={stage.options} align="start" disabled={disabled || stage.loading || !stage.profile}
          placeholder={stage.loading ? "Cargando modelos…" : "Elige un modelo"} onChange={stage.setModel} />
      </div>
      <div className="workflow-field"><label className="workflow-field-label" htmlFor={field + "-effort"}>Esfuerzo</label>
        <Select id={field + "-effort"} value={stage.effort ?? ""} options={stage.effortOptions} align="start"
          disabled={disabled || !stage.effortLevels.length} onChange={stage.setEffort} />
      </div>
    </div>
    <p className="workflow-field-hint">{stage.loading ? "Consultando el catálogo de esta cuenta…" : stage.effortHint}</p>
    {stage.error && <p className="workflow-field-hint">No se pudo cargar el catálogo: {stage.error} <button type="button" className="btn btn-small btn-ghost" disabled={disabled} onClick={stage.retry}>Reintentar</button></p>}
    {!stage.loading && !stage.validModel && <p className="workflow-model-error">El modelo elegido ya no está disponible en este catálogo.</p>}
    <label className="workflow-field"><span className="workflow-field-label">{principal ? "Responsabilidad del principal" : "Instrucciones de la función"}</span>
      <textarea className="input" rows={2} maxLength={2000} value={draft.instructions} disabled={disabled}
        onChange={event => onChange({ instructions: event.currentTarget.value })} />
    </label>
    {principal ? <p className="team-member-policy"><ShieldIcon size={13} />Planifica y delega sin editar el proyecto directamente.</p>
      : <label className="team-member-policy"><input type="checkbox" checked={draft.canWrite} disabled={disabled} onChange={event => onChange({ canWrite: event.currentTarget.checked })} />
        Puede implementar y ejecutar con los permisos normales de su asistente
      </label>}
  </section>;
}
const draft = (id: string, role: TeamRole, provider: AgentProvider): Draft => ({
  id, role, provider, name: TEAM_ROLES[role].name, instructions: TEAM_ROLES[role].description, canWrite: TEAM_ROLES[role].writes,
});
export default function AgentTeamDialog({ project, profiles, settings, onClose, onBack, onStart, submitting, error, initialMaster, ...motion }: Props) {
  const [master, setMaster] = useState(() => draft("principal", "coordinator", "claude"));
  const [workers, setWorkers] = useState(() => [draft("worker-1","implementation","trex"), draft("worker-2","review","claude"), draft("worker-3","fix","codex")]);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const next = useRef(4);
  const targets = useMemo(() => profiles.map(profile => ({ profile, reason: handoffTargetReason(profile, null, settings) })), [profiles, settings]);
  const select = (id: string, value: Selection): void => setSelections(previous => JSON.stringify(previous[id]) === JSON.stringify(value) ? previous : { ...previous, [id]: value });
  const members = [master, ...workers];
  const ready = workers.length > 0 && members.every(member => member.name.trim() && selections[member.id]?.ready) && !submitting && !motion.leaving;
  const move = (id: string, direction: number): void => setWorkers(previous => {
    const index = previous.findIndex(member => member.id === id), target = index + direction;
    if (index < 0 || target < 0 || target >= previous.length) return previous;
    const next = [...previous]; [next[index],next[target]] = [next[target],next[index]]; return next;
  });
  const choice = (member: Draft): TeamMemberChoice => ({ id: member.id, name: member.name.trim(), role: member.role,
    instructions: member.instructions.trim(), canWrite: member.canWrite, profileId: selections[member.id].profileId, model: selections[member.id].model, effort: selections[member.id].effort });
  return <FeatureDialog {...motion} title="Equipo con agente principal" onClose={onClose} className="agent-workflow-dialog agent-team-dialog"
    footer={<><span className="feature-hint">Tu idea se escribe en el chat.</span>
      <button type="button" className="btn btn-ghost" disabled={submitting} onClick={onBack}>Flujo de dos agentes</button>
      <button type="button" className="btn btn-ghost" disabled={submitting} onClick={onClose}>Cancelar</button>
      <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => { if (ready) onStart({ master: choice(master), workers: workers.map(choice) }); }}>
        {submitting ? <span className="chat-spinner" /> : <ArrowRightIcon size={15} />}{submitting ? "Guardando…" : "Guardar y abrir chat"}
      </button></>}>
    <p className="workflow-explanation">Configura el equipo de {project.name}: el principal y la función, cuenta, modelo y esfuerzo de cada subagente. Después escribe tu idea en el chat; el principal preparará el plan, delegará y revisará los resultados.</p>
    <ol className="workflow-setup-steps" aria-label="Cómo empieza el equipo"><li><span>1</span>Organiza tu equipo</li><li><ArrowRightIcon size={13} aria-hidden="true" /><span>2</span>Escribe tu idea en el chat</li></ol>
    {initialMaster && <p className="workflow-field-hint">Para continuar en este chat, conserva su cuenta actual en el principal o en uno de los subagentes.</p>}
    <MemberEditor draft={master} targets={targets} settings={settings} cwd={project.path} disabled={submitting} leaving={!!motion.leaving} initial={initialMaster}
      onChange={patch => setMaster(previous => ({ ...previous, ...patch }))} onSelection={select} />
    <div className="team-workers-heading"><div><h3>Subagentes · orden de trabajo</h3><p>Usa las flechas para ordenar sus funciones. Puedes combinar cuentas y proveedores.</p></div>
      <button type="button" className="btn btn-small btn-ghost" disabled={submitting || workers.length >= MAX_TEAM_WORKERS}
        onClick={() => setWorkers(previous => [...previous, draft("worker-" + next.current++, "research", "claude")])}><PlusIcon size={14} />Añadir subagente</button>
    </div>
    <div className="team-workers-grid">{workers.map((worker,index) => <MemberEditor key={worker.id} draft={worker} targets={targets} settings={settings} position={index+1}
      cwd={project.path} disabled={submitting} leaving={!!motion.leaving} onSelection={select}
      onChange={patch => setWorkers(previous => previous.map(item => item.id === worker.id ? { ...item, ...patch } : item))}
      onRemove={() => setWorkers(previous => previous.filter(item => item.id !== worker.id))}
      onMoveUp={index>0?()=>move(worker.id,-1):undefined} onMoveDown={index<workers.length-1?()=>move(worker.id,1):undefined} />)}</div>
    <p className="workflow-automation-note"><ShieldIcon size={15} />Las tareas de este equipo se ejecutan en serie. Detener el equipo interrumpe al principal y a sus subagentes. Una sesión recuperada empieza en pausa.</p>
    <p className="workflow-field-hint">Para investigación web con un modelo API, activa Trex Browser y comprueba que esté instalado. Las herramientas web disponibles dependen del asistente y de los componentes habilitados.</p>
    {error && <p className="workflow-status error" role="alert">{error}</p>}
  </FeatureDialog>;
}
