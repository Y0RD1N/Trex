import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AgentProvider, LauncherProfile, Project, Settings } from "../types";
import { handoffTargetReason } from "./HandoffDialog";
import { TEAM_ROLES, MAX_TEAM_WORKERS, teamBrowserDefault, type TeamBudget, type TeamRole } from "../agentTeam";
import { agentPermissionOptions, defaultAgentPermission } from "../agentPermissions";
import { EFFORT_LEVELS, modelName } from "../chatState";
import { suggestEffort, suggestModel } from "../modelTiers";
import { budgetLabel, MEMBER_BUDGET_PRESETS, TEAM_BUDGET_PRESETS } from "../teamBudget";
import { accountGroups, accountQuota, QUOTA_WARNING, readAccountPlan, type AccountQuota } from "../teamUsage";
import { useWorkflowStage } from "./AgentWorkflowDialog";
import type { WorkflowRequest } from "./AgentWorkflowDialog";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import AgentIcon from "./AgentIcon";
import Select from "./Select";
import { AlertIcon, ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, CloseIcon, GaugeIcon, PlusIcon, ShieldIcon } from "./Icons";
import "./AgentTeamDialog.css";
import "./TeamUsage.css";

/** `browser`: explicit Trex Browser choice (null: role default). */
export type TeamMemberChoice = WorkflowRequest["planner"] & { id: string; name: string; role: TeamRole; instructions: string; canWrite: boolean; browser?: boolean | null };
export type TeamRequest = { master: TeamMemberChoice; workers: TeamMemberChoice[]; budget?: TeamBudget | null };
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
  const mode = stage.mode ?? (stage.profile ? defaultAgentPermission(stage.profile.provider, draft.canWrite) : "plan");
  useEffect(() => latest.current(draft.id, { profileId: stage.profileId, model: stage.model || null, effort: stage.effort, mode, ready: stage.ready }),
    [draft.id, stage.profileId, stage.model, stage.effort, stage.ready, mode]);
  // Suggestions only prefill what the user has not chosen for this account.
  const [chosen, setChosen] = useState<Record<string, { model?: boolean; effort?: boolean }>>(() =>
    initial ? { [initial.profileId]: { model: initial.model !== null, effort: initial.effort !== null } } : {});
  const picked = chosen[stage.profileId] ?? {};
  const choose = (key: "model" | "effort"): void => setChosen(previous => ({ ...previous, [stage.profileId]: { ...previous[stage.profileId], [key]: true } }));
  const catalogReady = !!stage.profile && !stage.loading && !stage.error;
  const suggestedModel = catalogReady && !picked.model ? suggestModel(stage.models, draft.role) : null;
  const suggestedEffort = catalogReady && !picked.effort ? suggestEffort(stage.models, stage.model || null, draft.role) : null;
  const { setModel, setEffort } = stage;
  useEffect(() => { if (suggestedModel !== null && stage.model !== suggestedModel) setModel(suggestedModel); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suggestedModel, stage.profileId]);
  useEffect(() => {
    if (!catalogReady || picked.effort || stage.effort === suggestedEffort) return;
    if (suggestedEffort === null || stage.effortLevels.includes(suggestedEffort)) setEffort(suggestedEffort ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogReady, picked.effort, suggestedEffort, stage.effort, stage.profileId, stage.effortLevels.join("|")]);
  const suggestedInfo = stage.models.find(model => model.value === stage.model);
  const suggestion = catalogReady && (!picked.model && stage.model === suggestedModel && !!stage.model || !picked.effort && !!stage.effort && stage.effort === suggestedEffort)
    ? [stage.model ? suggestedInfo ? modelName(suggestedInfo) : stage.model : "modelo del perfil",
      stage.effort ? `esfuerzo ${EFFORT_LEVELS[stage.effort]?.label.toLowerCase() ?? stage.effort}` : null].filter(Boolean).join(" · ") : "";
  const principal = draft.role === "coordinator";
  const canWrite = mode !== "plan";
  const browserDefault = teamBrowserDefault(draft.role, canWrite);
  const browserOn = draft.browser ?? browserDefault;
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
          onChange={value => { const role = value as TeamRole; stage.setMode(null); onChange({ role, canWrite: TEAM_ROLES[role].writes, instructions: TEAM_ROLES[role].description }); }} />
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
          placeholder={stage.loading ? "Cargando modelos…" : "Elige un modelo"} onChange={value => { choose("model"); stage.setModel(value); }} />
      </div>
      <div className="workflow-field"><label className="workflow-field-label" htmlFor={field + "-effort"}>Esfuerzo</label>
        <Select id={field + "-effort"} value={stage.effort ?? ""} options={stage.effortOptions} align="start"
          disabled={disabled || !stage.effortLevels.length} onChange={value => { choose("effort"); stage.setEffort(value); }} />
      </div>
    </div>
    <p className="workflow-field-hint">{stage.loading ? "Consultando el catálogo de esta cuenta…" : stage.effortHint}</p>
    {suggestion && <p className="team-suggestion-hint">Sugerido para esta función: {suggestion}</p>}
    {stage.error && <p className="workflow-field-hint">No se pudo cargar el catálogo: {stage.error} <button type="button" className="btn btn-small btn-ghost" disabled={disabled} onClick={stage.retry}>Reintentar</button></p>}
    {!stage.loading && !stage.validModel && <p className="workflow-model-error">El modelo elegido ya no está disponible en este catálogo.</p>}
    <label className="workflow-field"><span className="workflow-field-label">{principal ? "Responsabilidad del principal" : "Instrucciones de la función"}</span>
      <textarea className="input" rows={2} maxLength={2000} value={draft.instructions} disabled={disabled}
        onChange={event => onChange({ instructions: event.currentTarget.value })} />
    </label>
    <div className="workflow-field"><label className="workflow-field-label" htmlFor={field + "-permissions"}>Permisos de archivos y acciones</label>
      <Select id={field + "-permissions"} value={mode ?? ""} align="start" disabled={disabled || !stage.profile}
        options={agentPermissionOptions(stage.profile?.provider ?? "claude")} onChange={value => { stage.setMode(value || null); onChange({ canWrite: value !== "plan" }); }} />
    </div>
    {settings.browserEnabled && <label className="team-member-browser">
      <input type="checkbox" checked={browserOn} disabled={disabled} onChange={event => onChange({ browser: event.currentTarget.checked === browserDefault ? null : event.currentTarget.checked })} />
      <span>Navegador</span>
      <small>{draft.browser == null ? browserDefault ? "Según su función" + (canWrite ? "" : " (solo observar)") : "Desactivado para esta función: ahorra contexto" : "Elegido para este agente"}</small>
    </label>}
    <p className="team-member-policy"><ShieldIcon size={13} />{principal
      ? mode === "plan" ? "Planifica y delega sin editar directamente." : "También puede editar. El principal y sus delegaciones se turnan para utilizar el proyecto."
      : mode === "plan" ? "La lectura no puede ampliarse desde una aprobación del agente." : "El asistente aplicará este modo a sus archivos, comandos e integraciones habilitadas."}</p>
  </section>;
}
const draft = (id: string, role: TeamRole, provider: AgentProvider): Draft => ({
  id, role, provider, name: TEAM_ROLES[role].name, instructions: TEAM_ROLES[role].description, canWrite: TEAM_ROLES[role].writes, browser: null,
});
type Reading = { status: "loading" } | { status: "ready"; quota: AccountQuota | null };
const quotaPart = (label: string, value: { percent: number } | null): string => `${label} ${value ? `${Math.round(value.percent)} %` : "—"}`;
export default function AgentTeamDialog({ project, profiles, settings, onClose, onBack, onStart, submitting, error, initialMaster, ...motion }: Props) {
  const [master, setMaster] = useState(() => draft("principal", "coordinator", "claude"));
  const [workers, setWorkers] = useState(() => [draft("worker-1","implementation","trex"), draft("worker-2","review","claude"), draft("worker-3","fix","codex")]);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [budget, setBudget] = useState<TeamBudget>({ teamTokens: null, memberTokens: null });
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const next = useRef(4);
  const field = useId();
  const targets = useMemo(() => profiles.map(profile => ({ profile, reason: profile.provider === "antigravity" ? "Antigravity aún no está habilitado para equipos con funciones de solo lectura." : handoffTargetReason(profile, null, settings) })), [profiles, settings]);
  const select = (id: string, value: Selection): void => setSelections(previous => JSON.stringify(previous[id]) === JSON.stringify(value) ? previous : { ...previous, [id]: value });
  const members = [master, ...workers];
  const ready = workers.length > 0 && members.every(member => member.name.trim() && selections[member.id]?.ready) && !submitting && !motion.leaving;
  const move = (id: string, direction: number): void => setWorkers(previous => {
    const index = previous.findIndex(member => member.id === id), target = index + direction;
    if (index < 0 || target < 0 || target >= previous.length) return previous;
    const next = [...previous]; [next[index],next[target]] = [next[target],next[index]]; return next;
  });
  const choice = (member: Draft): TeamMemberChoice => ({ id: member.id, name: member.name.trim(), role: member.role,
    instructions: member.instructions.trim(), canWrite: selections[member.id].mode !== "plan", mode: selections[member.id].mode,
    profileId: selections[member.id].profileId, model: selections[member.id].model, effort: selections[member.id].effort, browser: member.browser ?? null });
  // Pre-launch summary: who shares which account and how much of its plan is left (reading /usage spends no tokens).
  const groups = accountGroups(members.flatMap(member => {
    const profile = profiles.find(profile => profile.id === selections[member.id]?.profileId);
    return profile ? [{ id: member.id, profileId: profile.id, profileName: profile.name, profile }] : [];
  }));
  const accountKey = groups.map(group => group.profileId).sort().join("|");
  const requested = useRef(new Set<string>()), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (motion.leaving) return;
    for (const group of groups) {
      if (requested.current.has(group.profileId)) continue;
      requested.current.add(group.profileId);
      setReadings(previous => ({ ...previous, [group.profileId]: { status: "loading" } }));
      void readAccountPlan(group.members[0].profile, settings, project.path).then(plan => {
        if (alive.current) setReadings(previous => ({ ...previous, [group.profileId]: { status: "ready", quota: accountQuota(group.profileId, group.profileName, plan) } }));
      });
    }
    // Una lectura por cuenta elegida; se repite solo al cambiar las cuentas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, motion.leaving]);
  const warnings = groups.flatMap(group => {
    const reading = readings[group.profileId], quota = reading?.status === "ready" ? reading.quota : null;
    return [
      ...(quota?.peak != null && quota.peak >= QUOTA_WARNING ? [`${group.profileName} ya usó el ${Math.round(quota.peak)} % de su cuota; puede agotarse durante el trabajo.`] : []),
      ...(group.members.length >= 3 ? [`${group.members.length} agentes comparten ${group.profileName}: consumen la misma cuota.`] : []),
    ];
  });
  const budgetText = budget.teamTokens === null && budget.memberTokens === null ? "Sin límite"
    : [budget.teamTokens !== null ? `${budgetLabel(budget.teamTokens)} por equipo` : null, budget.memberTokens !== null ? `${budgetLabel(budget.memberTokens)} por agente` : null].filter(Boolean).join(" · ");
  const start = (): void => {
    if (!ready) return;
    const request: TeamRequest = { master: choice(master), workers: workers.map(choice), budget: budget.teamTokens === null && budget.memberTokens === null ? null : budget };
    onStart(request);
  };
  const presetOptions = (presets: (number | null)[], suffix: string) => presets.map(value => ({ value: value === null ? "" : String(value), label: value === null ? "Sin límite" : `${budgetLabel(value)}${suffix}` }));
  return <FeatureDialog {...motion} title="Equipo con agente principal" onClose={onClose} className="agent-workflow-dialog agent-team-dialog"
    footer={<><span className="feature-hint">{members.length} agentes · {groups.length} {groups.length === 1 ? "cuenta" : "cuentas"} · {budgetText}. Tu idea se escribe en el chat.</span>
      <button type="button" className="btn btn-ghost" disabled={submitting} onClick={onBack}>Flujo de dos agentes</button>
      <button type="button" className="btn btn-ghost" disabled={submitting} onClick={onClose}>Cancelar</button>
      <button type="button" className="btn btn-primary" disabled={!ready} onClick={start}>
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
    <div className="workflow-field">
      <span className="workflow-field-label" id={field + "-budget"}>Presupuesto de tokens nuevos</span>
      <div className="team-budget-field" role="group" aria-labelledby={field + "-budget"}>
        <Select value={budget.teamTokens === null ? "" : String(budget.teamTokens)} aria-label={`Presupuesto del equipo: ${budgetLabel(budget.teamTokens)}`} align="start" disabled={submitting}
          options={presetOptions(TEAM_BUDGET_PRESETS, " por equipo")} onChange={value => setBudget(previous => ({ ...previous, teamTokens: value ? Number(value) : null }))} />
        <Select value={budget.memberTokens === null ? "" : String(budget.memberTokens)} aria-label={`Presupuesto por agente: ${budgetLabel(budget.memberTokens)}`} align="start" disabled={submitting}
          options={presetOptions(MEMBER_BUDGET_PRESETS, " por agente").map(option => option.value ? option : { ...option, label: "Sin límite por agente" })}
          onChange={value => setBudget(previous => ({ ...previous, memberTokens: value ? Number(value) : null }))} />
      </div>
      <p className="workflow-field-hint">Cuenta los tokens nuevos (sin lecturas de caché). Al agotarse, la siguiente delegación no empieza y el equipo se pausa para que decidas si lo amplías.</p>
    </div>
    <section className="team-launch-summary" aria-label="Resumen antes de iniciar">
      <h3><GaugeIcon size={13} /> {members.length} agentes · {groups.length} {groups.length === 1 ? "cuenta" : "cuentas"} · Presupuesto: {budgetText}</h3>
      <ul className="team-launch-accounts">{groups.map(group => {
        const reading = readings[group.profileId], quota = reading?.status === "ready" ? reading.quota : null;
        return <li key={group.profileId}><AgentIcon kind={group.members[0].profile.provider} size={14} /><strong>{group.profileName}</strong>
          <span>{group.members.length} {group.members.length === 1 ? "agente" : "agentes"}</span>
          <span aria-label={`Uso del plan: ${quotaPart("5 h", quota?.fiveHour ?? null)}, ${quotaPart("semana", quota?.week ?? null)}`}>
            {reading?.status === "loading" ? "Leyendo uso…" : `${quotaPart("5 h", quota?.fiveHour ?? null)} · ${quotaPart("Semana", quota?.week ?? null)}`}</span></li>;
      })}</ul>
      {warnings.length > 0 && <ul className="team-launch-warnings">{warnings.map(warning => <li key={warning}><AlertIcon size={12} />{warning}</li>)}</ul>}
    </section>
    <p className="workflow-automation-note"><ShieldIcon size={15} />Las tareas que escriben el proyecto se ejecutan de una en una; hasta cuatro de lectura pueden trabajar a la vez. Detener el equipo interrumpe al principal y a sus subagentes. Una sesión recuperada empieza en pausa.</p>
    <p className="workflow-field-hint">Para investigación web con un modelo API, activa Trex Browser y comprueba que esté instalado. Las herramientas web disponibles dependen del asistente y de los componentes habilitados.</p>
    {error && <p className="workflow-status error" role="alert">{error}</p>}
  </FeatureDialog>;
}
