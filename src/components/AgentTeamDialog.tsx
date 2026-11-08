import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AgentProvider, LauncherProfile, Project, Settings } from "../types";
import { handoffTargetReason } from "./HandoffDialog";
import { TEAM_ROLES, MAX_TEAM_WORKERS, teamBrowserDefault, type TeamBudget, type TeamRole } from "../agentTeam";
import { defaultAgentPermission } from "../agentPermissions";
import { EFFORT_LEVELS, modelName } from "../chatState";
import { suggestEffort, suggestModel } from "../modelTiers";
import { budgetLabel, MEMBER_BUDGET_PRESETS, TEAM_BUDGET_PRESETS } from "../teamBudget";
import { accountGroups, accountQuota, QUOTA_WARNING, readAccountPlan, type AccountQuota } from "../teamUsage";
import { useWorkflowStage, type WorkflowRequest } from "../hooks/useWorkflowStage";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import AgentIcon from "./AgentIcon";
import { AgentFields, SetupSwitch } from "./AgentSetup";
import Select from "./Select";
import { AlertIcon, ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, ChevronIcon, CloseIcon, FolderIcon, GaugeIcon, GlobeIcon, PlusIcon, SparkIcon } from "./Icons";
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
  const [open, setOpen] = useState(false);
  const mode = stage.mode ?? (stage.profile ? defaultAgentPermission(stage.profile.provider, draft.canWrite) : "plan");
  useEffect(() => latest.current(draft.id, { profileId: stage.profileId, model: stage.model || null, effort: stage.effort, fast: stage.fast, mode, ready: stage.ready }),
    [draft.id, stage.profileId, stage.model, stage.effort, stage.fast, stage.ready, mode]);
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
  const label = principal ? "Principal" : draft.name;
  return <section className="agent-card agent-member" aria-label={principal ? "Agente principal" : draft.name}>
    <header className="agent-card-head">
      <input className="input agent-name" aria-label={`Nombre · ${principal ? "principal" : `subagente ${position}`}`} placeholder="Nombre" data-autofocus={principal || undefined}
        maxLength={80} value={draft.name} disabled={disabled} onChange={event => onChange({ name: event.currentTarget.value })} />
      {principal ? <span className="agent-tag">Principal</span>
        : <Select aria-label={`Función · ${label}`} className="agent-select agent-role" value={draft.role} disabled={disabled} align="start"
          options={Object.entries(TEAM_ROLES).filter(([role]) => role !== "coordinator").map(([value, role]) => ({ value, label: role.name, description: role.description }))}
          onChange={value => { const role = value as TeamRole; stage.setMode(null); onChange({ role, canWrite: TEAM_ROLES[role].writes, instructions: TEAM_ROLES[role].description }); }} />}
      <Select aria-label={`Asistente · ${label}`} className="agent-select agent-account" value={stage.profileId} disabled={disabled || !stage.profile} align="end"
        options={targets.map(({ profile, reason }) => ({ value: profile.id, label: profile.name, description: reason ?? profile.provider, disabled: !!reason, icon: <AgentIcon kind={profile.provider} size={16} /> }))}
        onChange={stage.setProfileId} />
      {onRemove && <div className="agent-card-controls">
        <button type="button" className="icon-btn" disabled={disabled || !onMoveUp} onClick={onMoveUp} aria-label={"Subir " + draft.name}><ArrowUpIcon size={13} /></button>
        <button type="button" className="icon-btn" disabled={disabled || !onMoveDown} onClick={onMoveDown} aria-label={"Bajar " + draft.name}><ArrowDownIcon size={13} /></button>
        <button type="button" className="icon-btn" disabled={disabled} onClick={onRemove} aria-label={"Quitar " + draft.name}><CloseIcon size={14} /></button>
      </div>}
    </header>
    <AgentFields stage={stage} mode={mode ?? ""} disabled={disabled} accessibleName={label}
      onModel={() => choose("model")} onEffort={() => choose("effort")}
      onMode={value => { stage.setMode(value); onChange({ canWrite: value !== "plan" }); }} />
    <div className="agent-card-foot">
      <div className="agent-card-more">
        <button type="button" className="agent-link" aria-expanded={open} aria-controls={field + "-instructions"} onClick={() => setOpen(value => !value)}>
          {principal ? "Responsabilidad" : "Instrucciones"}<ChevronIcon size={12} /></button>
        {suggestion && <span className="agent-suggested" tabIndex={0} title={"Sugerido para esta función: " + suggestion}><SparkIcon size={12} />Sugerido</span>}
      </div>
      {settings.browserEnabled && <button type="button" className="agent-chip" aria-pressed={browserOn} disabled={disabled}
        title={draft.browser == null ? browserDefault ? "Según su función" + (canWrite ? "" : " (solo observar)") : "Desactivado para esta función: ahorra contexto" : "Elegido para este agente"}
        onClick={() => onChange({ browser: !browserOn === browserDefault ? null : !browserOn })}><GlobeIcon size={13} />Navegador</button>}
    </div>
    {open && <textarea id={field + "-instructions"} className="input agent-instructions" rows={3} maxLength={2000} value={draft.instructions} disabled={disabled}
      aria-label={principal ? "Responsabilidad del principal" : "Instrucciones de la función"}
      onChange={event => onChange({ instructions: event.currentTarget.value })} />}
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
    profileId: selections[member.id].profileId, model: selections[member.id].model, effort: selections[member.id].effort, fast: selections[member.id].fast ?? null, browser: member.browser ?? null });
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
  const start = (): void => {
    if (!ready) return;
    const request: TeamRequest = { master: choice(master), workers: workers.map(choice), budget: budget.teamTokens === null && budget.memberTokens === null ? null : budget };
    onStart(request);
  };
  const presetOptions = (presets: (number | null)[], suffix: string) => presets.map(value => ({ value: value === null ? "" : String(value), label: value === null ? "Sin límite" : `${budgetLabel(value)}${suffix}` }));
  return <FeatureDialog {...motion} title="Planificar e implementar" onClose={onClose} className="agent-workflow-dialog agent-team-dialog"
    footer={<>
      <span className="agent-project" title={project.path}><FolderIcon size={14} />{project.name} · {members.length} agentes</span>
      <button type="button" className="btn btn-ghost" disabled={submitting} onClick={onClose}>Cancelar</button>
      <button type="button" className="btn btn-primary agent-start" disabled={!ready} onClick={start}>
        {submitting ? <span className="chat-spinner" /> : <ArrowRightIcon size={15} />}{submitting ? "Guardando…" : "Guardar y abrir chat"}
      </button></>}>
    <SetupSwitch team disabled={submitting} onChange={() => onBack()} />
    {initialMaster && <p className="agent-note">Mantén la cuenta de este chat en el principal o en un subagente para continuar la conversación.</p>}
    <MemberEditor draft={master} targets={targets} settings={settings} cwd={project.path} disabled={submitting} leaving={!!motion.leaving} initial={initialMaster}
      onChange={patch => setMaster(previous => ({ ...previous, ...patch }))} onSelection={select} />
    <div className="agent-section-head"><h3>Subagentes</h3>
      <button type="button" className="btn btn-small btn-ghost" disabled={submitting || workers.length >= MAX_TEAM_WORKERS}
        onClick={() => setWorkers(previous => [...previous, draft("worker-" + next.current++, "research", "claude")])}><PlusIcon size={14} />Añadir</button>
    </div>
    <div className="agent-stack">{workers.map((worker,index) => <MemberEditor key={worker.id} draft={worker} targets={targets} settings={settings} position={index+1}
      cwd={project.path} disabled={submitting} leaving={!!motion.leaving} onSelection={select}
      onChange={patch => setWorkers(previous => previous.map(item => item.id === worker.id ? { ...item, ...patch } : item))}
      onRemove={() => setWorkers(previous => previous.filter(item => item.id !== worker.id))}
      onMoveUp={index>0?()=>move(worker.id,-1):undefined} onMoveDown={index<workers.length-1?()=>move(worker.id,1):undefined} />)}</div>
    <div className="agent-budget" role="group" aria-labelledby={field + "-budget"}
      title="Cuenta los tokens nuevos (sin lecturas de caché). Al agotarse, la siguiente delegación no empieza y el equipo se pausa para que decidas si lo amplías.">
      <span className="agent-budget-label" id={field + "-budget"}><GaugeIcon size={14} />Límite de tokens</span>
      <Select className="agent-select" value={budget.teamTokens === null ? "" : String(budget.teamTokens)} aria-label={`Presupuesto del equipo: ${budgetLabel(budget.teamTokens)}`} align="start" disabled={submitting}
        options={presetOptions(TEAM_BUDGET_PRESETS, " por equipo")} onChange={value => setBudget(previous => ({ ...previous, teamTokens: value ? Number(value) : null }))} />
      <Select className="agent-select" value={budget.memberTokens === null ? "" : String(budget.memberTokens)} aria-label={`Presupuesto por agente: ${budgetLabel(budget.memberTokens)}`} align="start" disabled={submitting}
        options={presetOptions(MEMBER_BUDGET_PRESETS, " por agente").map(option => option.value ? option : { ...option, label: "Sin límite por agente" })}
        onChange={value => setBudget(previous => ({ ...previous, memberTokens: value ? Number(value) : null }))} />
    </div>
    {groups.length > 0 && <ul className="team-launch-accounts" aria-label="Uso de las cuentas">{groups.map(group => {
      const reading = readings[group.profileId], quota = reading?.status === "ready" ? reading.quota : null;
      return <li key={group.profileId}><AgentIcon kind={group.members[0].profile.provider} size={14} /><strong>{group.profileName}</strong>
        <span>{group.members.length} {group.members.length === 1 ? "agente" : "agentes"}</span>
        <span aria-label={`Uso del plan: ${quotaPart("5 h", quota?.fiveHour ?? null)}, ${quotaPart("semana", quota?.week ?? null)}`}>
          {reading?.status === "loading" ? "Leyendo uso…" : `${quotaPart("5 h", quota?.fiveHour ?? null)} · ${quotaPart("Semana", quota?.week ?? null)}`}</span></li>;
    })}</ul>}
    {warnings.length > 0 && <ul className="team-launch-warnings">{warnings.map(warning => <li key={warning}><AlertIcon size={12} />{warning}</li>)}</ul>}
    {error && <p className="agent-note error" role="alert">{error}</p>}
  </FeatureDialog>;
}
