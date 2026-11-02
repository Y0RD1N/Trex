import { useEffect, useId, useMemo, useState } from "react";
import { formatError } from "../api";
import { workflowEffortLevels } from "../agentWorkflow";
import { agentPermissionOptions, defaultAgentPermission, validAgentPermission } from "../agentPermissions";
import { EFFORT_LEVELS, modelDescription, modelName, normalizeEffortChoice, normalizeModelChoice, type ModelInfo } from "../chatState";
import { loadProfileModels } from "../profileModels";
import { PROVIDER_NAMES } from "../profiles";
import type { AgentProvider, LauncherProfile, Project, Settings } from "../types";
import AgentIcon from "./AgentIcon";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import { handoffTargetReason } from "./HandoffDialog";
import { ArrowRightIcon, FolderIcon, ListIcon, MapIcon, ShieldIcon, WrenchIcon } from "./Icons";
import Select, { type SelectOption } from "./Select";
import "./AgentWorkflowDialog.css";
import AgentTeamDialog, { type TeamRequest } from "./AgentTeamDialog";

export type WorkflowRequest = {
  planner: { profileId: string; model: string | null; effort: string | null; mode?: string | null };
  executor: { profileId: string; model: string | null; effort: string | null; mode?: string | null };
};

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

type Target = { profile: LauncherProfile; reason: string | null };
type Catalog = { key: string; models: ModelInfo[]; loading: boolean; error: string | null };

function preferredTarget(targets: Target[], provider: AgentProvider, defaultProfileId: string): Target | undefined {
  const available = targets.filter(target => !target.reason);
  return available.find(target => target.profile.provider === provider && target.profile.id === defaultProfileId)
    ?? available.find(target => target.profile.provider === provider)
    ?? available.find(target => target.profile.id === defaultProfileId)
    ?? available[0];
}

/** Cada etapa conserva sus propias elecciones, incluso si ambas usan el mismo perfil. */
export function useWorkflowStage(targets: Target[], provider: AgentProvider, settings: Settings, cwd: string, leaving: boolean, initial?: WorkflowRequest["executor"]) {
  const [profileId, setProfileId] = useState(initial?.profileId ?? "");
  const [modelChoices, setModelChoices] = useState<Record<string, string>>(() => initial ? { [initial.profileId]: initial.model ?? "" } : {});
  const [effortChoices, setEffortChoices] = useState<Record<string, Record<string, string>>>(() => initial?.effort ? { [initial.profileId]: { [initial.model ?? ""]: initial.effort } } : {});
  const [revision, setRevision] = useState(0);
  const [permissionChoices, setPermissionChoices] = useState<Record<string, string | null>>(() => initial ? { [initial.profileId]: initial.mode ?? null } : {});
  const [catalog, setCatalog] = useState<Catalog>({ key: "", models: [], loading: false, error: null });
  const selected = targets.find(target => target.profile.id === profileId && !target.reason)
    ?? preferredTarget(targets, provider, settings.defaultProfileId);
  const profile = selected?.profile;
  const selectedId = profile?.id ?? "";
  const key = profile ? JSON.stringify([profile, settings.shell, cwd, revision]) : "";
  const models = catalog.key === key ? catalog.models : [];
  const loading = !!key && (catalog.key !== key || catalog.loading);
  const error = catalog.key === key ? catalog.error : null;
  const model = modelChoices[selectedId] ?? "";
  const validModel = !model || models.some(item => item.value === model);
  const inheritedEffort = selectedId === initial?.profileId && !model ? normalizeEffortChoice(initial.effort) : null;
  const effortLevels = inheritedEffort ? [inheritedEffort] : workflowEffortLevels(models, model || null);
  const effortChoice = normalizeEffortChoice(effortChoices[selectedId]?.[model]);
  const effort = effortChoice && effortLevels.includes(effortChoice) ? effortChoice : null;

  useEffect(() => {
    if (!key || !profile || leaving) return;
    const controller = new AbortController();
    setCatalog({ key, models: [], loading: true, error: null });
    void loadProfileModels(profile, settings, cwd, controller.signal).then(available => {
      if (controller.signal.aborted) return;
      const seen = new Set<string>();
      const models = available.flatMap(item => {
        const value = normalizeModelChoice(item.value);
        if (!value || seen.has(value)) return [];
        seen.add(value);
        return [{ ...item, value }];
      });
      setCatalog({ key, models, loading: false, error: null });
      // Solo un catálogo confirmado puede invalidar las elecciones recordadas del perfil.
      setEffortChoices(previous => {
        const choices = previous[profile.id];
        if (!choices) return previous;
        const supported = Object.entries(choices).filter(([choice, effort]) => workflowEffortLevels(models, choice).includes(effort)
          || !choice && profile.id === initial?.profileId && effort === normalizeEffortChoice(initial.effort));
        return supported.length === Object.keys(choices).length ? previous
          : { ...previous, [profile.id]: Object.fromEntries(supported) };
      });
    }).catch(reason => {
      if (!controller.signal.aborted) setCatalog({ key, models: [], loading: false, error: formatError(reason) });
    });
    return () => controller.abort();
    // La clave incluye el perfil completo, el shell, el proyecto y cada reintento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, leaving]);

  const options: SelectOption[] = [
    { value: "", label: "Predeterminado del perfil", description: "Usa el modelo configurado en este perfil." },
    ...models.map(item => ({ value: item.value,
      label: item.value === "default" ? "Recomendado por el asistente" : modelName(item),
      description: modelDescription(item, models), group: item.featured ? "Modelos" : "Otras versiones" })),
    ...(!loading && model && !validModel ? [{ value: model, label: `No disponible · ${model}`, disabled: true }] : []),
  ];
  const effortOptions: SelectOption[] = [
    { value: "", label: "Predeterminado del perfil", description: "Usa el esfuerzo del perfil o el predeterminado del asistente." },
    ...effortLevels.map(level => ({ value: level, label: EFFORT_LEVELS[level].label, description: EFFORT_LEVELS[level].hint })),
  ];
  const effortHint = inheritedEffort ? "Puedes conservar el esfuerzo que ya elegiste en esta conversación."
    : !model ? "Elige un modelo para ver sus niveles de esfuerzo"
    : loading ? "Los niveles estarán disponibles cuando termine de cargar el catálogo."
    : error ? "No se pudieron verificar los niveles. Se usará el esfuerzo predeterminado."
    : !validModel ? "Elige un modelo disponible para ver sus niveles de esfuerzo."
    : !effortLevels.length ? "Este modelo no ofrece niveles de esfuerzo configurables; se usará el predeterminado."
    : effort ? "Esfuerzo elegido solo para esta etapa."
    : "Se usará el esfuerzo del perfil o el predeterminado del asistente.";

  const mode = profile && validAgentPermission(profile.provider, permissionChoices[selectedId]) ? permissionChoices[selectedId] ?? null : null;
  return { profile, profileId: selectedId, setProfileId, model, options, loading, error, validModel, mode,
    setMode: (mode: string | null) => setPermissionChoices(previous => ({ ...previous, [selectedId]: mode })),
    effort, effortLevels, effortOptions, effortHint,
    ready: !!profile && !loading && validModel,
    setModel: (value: string) => setModelChoices(previous => ({ ...previous, [selectedId]: value })),
    setEffort: (value: string) => {
      const effort = normalizeEffortChoice(value);
      setEffortChoices(previous => {
        const choices = { ...previous[selectedId] };
        if (effort && effortLevels.includes(effort)) choices[model] = effort;
        else delete choices[model];
        return { ...previous, [selectedId]: choices };
      });
    },
    retry: () => setRevision(value => value + 1) };
}

type Stage = ReturnType<typeof useWorkflowStage>;

function WorkflowStageCard({ stage, role, profileOptions, disabled }: {
  stage: Stage;
  role: "planner" | "executor";
  profileOptions: SelectOption[];
  disabled: boolean;
}) {
  const id = useId();
  const planning = role === "planner";
  const name = planning ? "planificación" : "implementación";
  return <section className={`workflow-stage workflow-stage-${role}`} aria-labelledby={`${id}-title`}>
    <div className="workflow-stage-heading">
      <span className="workflow-role-icon" aria-hidden="true">{planning ? <MapIcon size={19} /> : <WrenchIcon size={19} />}</span>
      <div><span className="workflow-eyebrow">Etapa {planning ? "1" : "2"}</span>
        <h3 id={`${id}-title`}>{planning ? "Planificación" : "Implementación"}</h3></div>
      <span className="workflow-stage-badge">{planning ? "Plan" : "Automática"}</span>
    </div>
    <p className="workflow-stage-description">{planning
      ? "Explora el proyecto y prepara un plan con los permisos que elijas."
      : "Recibe el plan y empieza a implementar automáticamente."}</p>
    <div className="workflow-field">
      <label className="workflow-field-label" id={`${id}-profile-label`} htmlFor={`${id}-profile`}>Asistente para {name}</label>
      <Select id={`${id}-profile`} aria-labelledby={`${id}-profile-label`} className="workflow-select" align="start"
        data-autofocus={planning||undefined}
        value={stage.profileId} options={profileOptions} placeholder="Sin perfiles compatibles"
        disabled={disabled || !stage.profile} onChange={stage.setProfileId} />
    </div>
    <div className="workflow-field">
      <label className="workflow-field-label" id={`${id}-model-label`} htmlFor={`${id}-model`}>Modelo de {name}</label>
      <Select id={`${id}-model`} aria-labelledby={`${id}-model-label`} aria-describedby={`${id}-model-status`}
        aria-invalid={!stage.loading && !stage.validModel || undefined}
        className="workflow-select" align="start" value={stage.model} options={stage.options}
        placeholder={stage.loading ? "Cargando modelos…" : "Elige un modelo"}
        disabled={disabled || !stage.profile || stage.loading} onChange={stage.setModel} />
      <div className="workflow-model-feedback" id={`${id}-model-status`} aria-live="polite" aria-atomic="true">
        {stage.loading ? <p className="workflow-field-hint" role="status"><span className="chat-spinner" aria-hidden="true" /> Cargando modelos…</p>
          : stage.error ? <>
            <p className="workflow-field-hint">No se pudieron cargar los modelos: {stage.error} Puedes usar el predeterminado del perfil.</p>
            <button type="button" className="btn btn-small btn-ghost workflow-retry" disabled={disabled}
              aria-label={`Reintentar modelos de ${name}`} onClick={stage.retry}>Reintentar modelos</button>
          </>
          : stage.profile ? <p className="workflow-field-hint">{stage.model && stage.validModel
            ? "Modelo elegido solo para esta etapa."
            : "Se usará el modelo configurado en el perfil."}</p> : null}
        {!stage.loading && !stage.validModel && <p className="workflow-model-error">El modelo elegido ya no está disponible. Elige otro o usa el predeterminado.</p>}
      </div>
    </div>
    <div className="workflow-field workflow-effort-field">
      <label className="workflow-field-label" id={`${id}-effort-label`} htmlFor={`${id}-effort`}>Esfuerzo de {name}</label>
      <Select id={`${id}-effort`} aria-labelledby={`${id}-effort-label`} aria-describedby={`${id}-effort-status`}
        className="workflow-select" align="start" value={stage.effort ?? ""} options={stage.effortOptions}
        disabled={disabled || !stage.profile || !stage.effortLevels.length} onChange={stage.setEffort} />
      <p className="workflow-field-hint workflow-effort-hint" id={`${id}-effort-status`} aria-live="polite" aria-atomic="true">{stage.effortHint}</p>
    </div>
    <div className="workflow-field">
      <label className="workflow-field-label" htmlFor={`${id}-permissions`}>Permisos de {name}</label>
      <Select id={`${id}-permissions`} className="workflow-select" align="start" disabled={disabled || !stage.profile}
        value={stage.mode ?? (stage.profile ? defaultAgentPermission(stage.profile.provider, !planning) : "") ?? ""}
        options={agentPermissionOptions(stage.profile?.provider ?? "claude")}
        onChange={value => stage.setMode(value || null)} />
      <p className="workflow-field-hint">{planning ? "Empieza en solo lectura. Puedes permitir cambios también durante la planificación."
        : "Se aplican a archivos, comandos y las integraciones habilitadas, según el asistente."}</p>
    </div>
  </section>;
}

export default function AgentWorkflowDialog({ project, profiles, settings, onClose, onStart, onStartTeam, submitting, error, initialExecutor, ...motion }: AgentWorkflowDialogProps) {
  const [teamMode, setTeamMode] = useState(false);
  const targets = useMemo(() => profiles.map(profile => ({ profile, reason: handoffTargetReason(profile, null, settings) })), [profiles, settings]);
  const planner = useWorkflowStage(targets.filter(target => target.profile.provider !== "antigravity"), "claude", settings, project.path, !!motion.leaving);
  const executor = useWorkflowStage(targets, "codex", settings, project.path, !!motion.leaving, initialExecutor);
  const available = targets.some(target => !target.reason);
  const profileOptions: SelectOption[] = targets.map(({ profile, reason }) => ({ value: profile.id, label: profile.name,
    description: reason ?? PROVIDER_NAMES[profile.provider], disabled: !!reason, icon: <AgentIcon kind={profile.provider} size={17} /> }));
  const ready = planner.ready && executor.ready && !submitting && !motion.leaving;

  if (teamMode && onStartTeam) return <AgentTeamDialog {...motion} project={project} profiles={profiles} settings={settings} onClose={onClose}
    onStart={onStartTeam} onBack={() => setTeamMode(false)} submitting={submitting} error={error} initialMaster={initialExecutor} />;
  return <FeatureDialog {...motion} title="Planificar e implementar" onClose={onClose} className="agent-workflow-dialog"
    footer={<>
      <span className="feature-hint workflow-footer-hint">La idea se escribe después, en el chat.</span>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancelar</button>
      <button type="button" className="btn btn-primary workflow-start" disabled={!ready} onClick={() => {
        if (ready) onStart({ planner: { profileId: planner.profileId, model: planner.model || null, effort: planner.effort, mode: planner.mode ?? "plan" },
          executor: { profileId: executor.profileId, model: executor.model || null, effort: executor.effort, mode: executor.mode ?? defaultAgentPermission(executor.profile!.provider) } });
      }}>
        {submitting ? <span className="chat-spinner" aria-hidden="true" /> : <ArrowRightIcon size={15} />}
        {submitting ? "Guardando…" : "Guardar y abrir chat"}
      </button>
    </>}>
    <div className="workflow-project"><span className="workflow-project-icon" aria-hidden="true"><FolderIcon size={20} /></span>
      <div><span className="workflow-eyebrow">Flujo automático en</span><strong>{project.name}</strong>
        <span className="workflow-project-path" title={project.path}>{project.path}</span></div>
    </div>
    <p className="workflow-explanation">Elige quién planifica y quién implementa, con su cuenta, modelo y esfuerzo. Al guardar tendrás un chat compartido donde escribir tu idea y continuar la conversación.</p>
    <ol className="workflow-setup-steps" aria-label="Cómo empieza el flujo"><li><span>1</span>Configura los agentes</li><li><ArrowRightIcon size={13} aria-hidden="true" /><span>2</span>Escribe tu idea en el chat</li></ol>
    {onStartTeam && <button type="button" className="workflow-team-choice" disabled={submitting} onClick={() => setTeamMode(true)}>
      <span className="workflow-team-choice-icon"><ListIcon size={20} /></span><span><strong>Trabajar con un equipo</strong><small>Un principal que planifica y delega a los subagentes que elijas.</small></span><ArrowRightIcon size={17} />
    </button>}
    {initialExecutor && <p className="workflow-field-hint">Este equipo continuará en tu chat actual. Conserva su perfil en una de las dos etapas para mantener la conversación.</p>}
    <div className="workflow-stages">
      <WorkflowStageCard stage={planner} role="planner" profileOptions={profileOptions.map(option => targets.find(t => t.profile.id === option.value)?.profile.provider === "antigravity" ? { ...option, disabled: true, description: "Planificación de solo lectura pendiente de validación" } : option)} disabled={submitting} />
      <span className="workflow-direction" aria-hidden="true"><ArrowRightIcon size={17} /></span>
      <WorkflowStageCard stage={executor} role="executor" profileOptions={profileOptions} disabled={submitting} />
    </div>
    <p className="workflow-automation-note"><ShieldIcon size={15} /><span>Guardar la configuración no inicia ninguna tarea. Cuando envíes tu idea, el planificador preparará el plan y el ejecutor lo recibirá con los permisos que hayas elegido.</span></p>
    {!available && <p className="workflow-status" role="status">Añade en Ajustes un perfil compatible con el chat, sin opciones de reanudación ni modos especiales.</p>}
    {error && <p className="workflow-status error" role="alert">{error}</p>}
  </FeatureDialog>;
}
