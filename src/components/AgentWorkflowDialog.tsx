import { useId, useMemo, useState } from "react";
import { defaultAgentPermission } from "../agentPermissions";
import { useWorkflowStage, type Stage, type Target, type WorkflowRequest } from "../hooks/useWorkflowStage";
import { PROVIDER_NAMES } from "../profiles";
import type { LauncherProfile, Project, Settings } from "../types";
import AgentIcon from "./AgentIcon";
import { AgentFields, SetupSwitch } from "./AgentSetup";
import AgentTeamDialog, { type TeamRequest } from "./AgentTeamDialog";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import { handoffTargetReason } from "./HandoffDialog";
import { ArrowDownIcon, ArrowRightIcon, FolderIcon, MapIcon, WrenchIcon } from "./Icons";
import Select, { type SelectOption } from "./Select";

// El hook vive aparte para que el diálogo de equipo no dependa de este módulo.
export { useWorkflowStage } from "../hooks/useWorkflowStage";
export type { WorkflowRequest } from "../hooks/useWorkflowStage";

export type AgentWorkflowDialogProps = {
  project: Project;
  profiles: LauncherProfile[];
  settings: Settings;
  onClose: () => void;
  onStart: (request: WorkflowRequest) => void;
  onStartTeam?: (request: TeamRequest) => void;
  submitting: boolean;
  error: string | null;
  initialExecutor?: WorkflowRequest["executor"];
} & FeatureDialogMotionProps;

function AgentCard({ stage, role, profileOptions, disabled }: {
  stage: Stage;
  role: "planner" | "executor";
  profileOptions: SelectOption[];
  disabled: boolean;
}) {
  const id = useId();
  const planning = role === "planner";
  const name = planning ? "Planificación" : "Implementación";
  const mode = stage.mode ?? (stage.profile ? defaultAgentPermission(stage.profile.provider, !planning) : "") ?? "";
  return <section className="agent-card" aria-labelledby={`${id}-title`}>
    <header className="agent-card-head">
      <span className="agent-card-icon" aria-hidden="true">{planning ? <MapIcon size={16} /> : <WrenchIcon size={16} />}</span>
      <h3 id={`${id}-title`}>{name}</h3>
      <Select aria-label={`Asistente de ${name.toLowerCase()}`} className="agent-select agent-account" align="end"
        data-autofocus={planning || undefined} value={stage.profileId} options={profileOptions} placeholder="Sin perfiles compatibles"
        disabled={disabled || !stage.profile} onChange={stage.setProfileId} />
    </header>
    <AgentFields stage={stage} mode={mode} onMode={stage.setMode} disabled={disabled} accessibleName={name} />
  </section>;
}

export default function AgentWorkflowDialog({ project, profiles, settings, onClose, onStart, onStartTeam, submitting, error, initialExecutor, ...motion }: AgentWorkflowDialogProps) {
  const [teamMode, setTeamMode] = useState(false);
  const targets: Target[] = useMemo(() => profiles.map(profile => ({ profile, reason: handoffTargetReason(profile, null, settings) })), [profiles, settings]);
  const planner = useWorkflowStage(targets.filter(target => target.profile.provider !== "antigravity"), "claude", settings, project.path, !!motion.leaving);
  const executor = useWorkflowStage(targets, "codex", settings, project.path, !!motion.leaving, initialExecutor);
  const available = targets.some(target => !target.reason);
  const profileOptions: SelectOption[] = targets.map(({ profile, reason }) => ({ value: profile.id, label: profile.name,
    description: reason ?? PROVIDER_NAMES[profile.provider], disabled: !!reason, icon: <AgentIcon kind={profile.provider} size={16} /> }));
  // Antigravity todavía no puede planificar en solo lectura.
  const plannerOptions = profileOptions.map(option => targets.find(target => target.profile.id === option.value)?.profile.provider === "antigravity"
    ? { ...option, disabled: true, description: "Planificación de solo lectura pendiente de validación" } : option);
  const ready = planner.ready && executor.ready && !submitting && !motion.leaving;

  if (teamMode && onStartTeam) return <AgentTeamDialog {...motion} project={project} profiles={profiles} settings={settings} onClose={onClose}
    onStart={onStartTeam} onBack={() => setTeamMode(false)} submitting={submitting} error={error} initialMaster={initialExecutor} />;
  return <FeatureDialog {...motion} title="Planificar e implementar" onClose={onClose} className="agent-workflow-dialog"
    footer={<>
      <span className="agent-project" title={project.path}><FolderIcon size={14} />{project.name}</span>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancelar</button>
      <button type="button" className="btn btn-primary agent-start" disabled={!ready} onClick={() => {
        if (ready) onStart({
          planner: { profileId: planner.profileId, model: planner.model || null, effort: planner.effort, fast: planner.fast, mode: planner.mode ?? "plan" },
          executor: { profileId: executor.profileId, model: executor.model || null, effort: executor.effort, fast: executor.fast, mode: executor.mode ?? defaultAgentPermission(executor.profile!.provider) } });
      }}>
        {submitting ? <span className="chat-spinner" aria-hidden="true" /> : <ArrowRightIcon size={15} />}
        {submitting ? "Guardando…" : "Guardar y abrir chat"}
      </button>
    </>}>
    {onStartTeam && <SetupSwitch team={false} disabled={submitting} onChange={setTeamMode} />}
    {initialExecutor && <p className="agent-note">Mantén la cuenta de este chat en uno de los dos agentes para continuar la conversación.</p>}
    <div className="agent-stack">
      <AgentCard stage={planner} role="planner" profileOptions={plannerOptions} disabled={submitting} />
      <span className="agent-link-arrow" aria-hidden="true"><ArrowDownIcon size={14} /></span>
      <AgentCard stage={executor} role="executor" profileOptions={profileOptions} disabled={submitting} />
    </div>
    {!available && <p className="agent-note error" role="status">Añade en Ajustes un perfil compatible con el chat, sin opciones de reanudación ni modos especiales.</p>}
    {error && <p className="agent-note error" role="alert">{error}</p>}
  </FeatureDialog>;
}
