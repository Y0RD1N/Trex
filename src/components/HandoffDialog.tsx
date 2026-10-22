import { useEffect, useId, useMemo, useState } from "react";
import { formatError } from "../api";
import { modelDescription, modelName, normalizeModelChoice, type ModelInfo } from "../chatState";
import { codexChatSupported } from "../codexChat";
import { canResume } from "../conversations";
import { DEFAULT_HANDOFF_INSTRUCTION, type HandoffContext, type PreparedHandoff } from "../handoff";
import { launchForProfile, PROVIDER_NAMES } from "../profiles";
import { loadProfileModels } from "../profileModels";
import type { LauncherProfile, Settings } from "../types";
import AgentIcon from "./AgentIcon";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import { ArrowRightIcon } from "./Icons";
import Select from "./Select";
import "./HandoffDialog.css";

export function handoffTargetReason(profile: LauncherProfile, sourceProfileId: string | null, settings: Settings): string | null {
  if (profile.id === sourceProfileId) return "Es el perfil de esta conversación.";
  if (!profile.command.trim()) return "Añade el comando de este perfil en Ajustes.";
  if (!canResume(launchForProfile(settings, profile), profile.provider))
    return "Este perfil abre una conversación concreta o usa un modo especial. Elige uno sin esas opciones.";
  if (profile.provider === "codex" && !codexChatSupported(profile.args))
    return "Este perfil usa opciones de terminal. Elige un perfil compatible con el chat.";
  return null;
}

export type HandoffDialogProps = {
  context: HandoffContext;
  prepared: PreparedHandoff | null;
  loading: boolean;
  error: string | null;
  profiles: LauncherProfile[];
  settings: Settings;
  onClose: () => void;
  onContinue: (profileId: string, instruction: string, model: string | null) => void;
  submitting: boolean;
} & FeatureDialogMotionProps;

export default function HandoffDialog({ context, prepared, loading, error, profiles, settings, onClose, onContinue, submitting, ...motion }: HandoffDialogProps) {
  const groupId = useId();
  const instructionId = useId();
  const modelId = useId();
  const targets = useMemo(() => profiles.map(profile => ({ profile, reason: handoffTargetReason(profile, context.source.profileId, settings) })),
    [profiles, context.source.profileId, settings]);
  const [profileId, setProfileId] = useState(() => targets.find(target => !target.reason && target.profile.id === settings.defaultProfileId)?.profile.id
    ?? targets.find(target => !target.reason)?.profile.id ?? "");
  const [instruction, setInstruction] = useState(DEFAULT_HANDOFF_INSTRUCTION);
  const [modelChoices, setModelChoices] = useState<Record<string, string>>({});
  const [modelRevision, setModelRevision] = useState(0);
  const [catalog, setCatalog] = useState<{ key: string; models: ModelInfo[]; loading: boolean; error: string | null }>({ key: "", models: [], loading: false, error: null });
  const selected = targets.find(target => target.profile.id === profileId);
  const catalogKey = selected && !selected.reason ? JSON.stringify([selected.profile, settings.shell, context.source.cwd]) : "";
  const models = catalog.key === catalogKey ? catalog.models : [];
  const modelsLoading = !!catalogKey && (catalog.key !== catalogKey || catalog.loading);
  const modelsError = catalog.key === catalogKey ? catalog.error : null;
  const model = modelChoices[profileId] ?? "";
  const validModel = !model || models.some(item => item.value === model);
  const ready = !!selected && !selected.reason && !!prepared && !loading && !submitting && !error && !modelsLoading && validModel;
  const limited = prepared?.truncated || context.truncated;

  useEffect(() => {
    if (!catalogKey || !selected || motion.leaving) return;
    const controller = new AbortController();
    setCatalog({ key: catalogKey, models: [], loading: true, error: null });
    void loadProfileModels(selected.profile, settings, context.source.cwd, controller.signal).then(available => {
      if (!controller.signal.aborted) setCatalog({ key: catalogKey, models: available.filter(item => normalizeModelChoice(item.value)), loading: false, error: null });
    }).catch(reason => {
      if (!controller.signal.aborted) setCatalog({ key: catalogKey, models: [], loading: false, error: formatError(reason) });
    });
    return () => controller.abort();
    // La clave contiene todos los ajustes que cambian el catálogo de este perfil.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogKey, modelRevision, motion.leaving]);

  const modelOptions = [
    { value: "", label: "Predeterminado del perfil", description: "Usa el modelo configurado en este perfil." },
    ...models.map(item => ({ value: item.value, label: item.value === "default" ? "Recomendado por el asistente" : modelName(item),
      description: modelDescription(item, models), group: item.featured ? "Modelos" : "Otras versiones" })),
  ];

  return <FeatureDialog {...motion} title="Continuar con otro asistente" onClose={onClose} className="handoff-dialog"
    footer={<>
      <span className="feature-hint">La conversación original queda guardada.</span>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancelar</button>
      <button type="button" className="btn btn-primary handoff-continue" disabled={!ready}
        onClick={() => { if (ready) onContinue(profileId, instruction.trim() || DEFAULT_HANDOFF_INSTRUCTION, model || null); }}>
        {submitting ? <span className="chat-spinner" aria-hidden="true" /> : <ArrowRightIcon size={14} />}
        {submitting ? "Abriendo conversación…" : selected ? `Continuar con ${selected.profile.name}` : "Continuar"}
      </button>
    </>}>
    <div className="handoff-source">
      <span className="handoff-source-icon"><AgentIcon kind={context.source.provider} size={21} /></span>
      <div><span className="handoff-eyebrow">Continuar el trabajo de {context.source.profileName}</span>
        <strong>{context.source.title || "Conversación"}</strong>
        <span className="handoff-source-project">{context.source.projectName}</span>
      </div>
    </div>
    <p className="handoff-explanation">Elige otro perfil para seguir en el mismo proyecto con el objetivo, las instrucciones y el historial disponible. Funciona aunque el asistente anterior ya no tenga cuota: no necesita otra respuesta suya.</p>
    <div className="handoff-destinations" role="radiogroup" aria-label="Asistente de destino">
      <span className="handoff-field-label">Continuar con</span>
      {targets.map(({ profile, reason }) => <label key={profile.id} className={`handoff-profile${profile.id === profileId ? " selected" : ""}${reason ? " unavailable" : ""}`}>
        <input type="radio" name={groupId} value={profile.id} checked={profile.id === profileId}
          disabled={!!reason || submitting} onChange={() => setProfileId(profile.id)}
          data-autofocus={profile.id === profileId && !reason ? true : undefined}
          aria-describedby={reason ? `${groupId}-${profile.id}` : undefined} />
        <AgentIcon kind={profile.provider} size={19} />
        <span className="handoff-profile-copy"><strong>{profile.name}</strong>
          <span>{PROVIDER_NAMES[profile.provider]}</span>
          {reason && <small id={`${groupId}-${profile.id}`}>{reason}</small>}
        </span>
        {profile.id === context.source.profileId && <span className="handoff-current">Actual</span>}
      </label>)}
      {!targets.some(target => !target.reason) && <p className="handoff-status" role="status">Añade otro perfil compatible en Ajustes para continuar el trabajo.</p>}
    </div>
    {selected && !selected.reason && <div className="handoff-model-field">
      <label className="handoff-field-label" id={modelId}>Modelo para continuar</label>
      <Select aria-label="Modelo para continuar" aria-labelledby={modelId} className="handoff-model-select" align="start"
        value={model} options={modelOptions} disabled={modelsLoading || submitting} onChange={value => setModelChoices(previous => ({ ...previous, [profileId]: value }))} />
      {modelsLoading ? <p className="handoff-model-hint" role="status"><span className="chat-spinner" aria-hidden="true" /> Cargando modelos de {selected.profile.name}…</p>
        : modelsError ? <div className="handoff-model-retry"><p className="handoff-model-hint" role="status">No se pudieron cargar los modelos: {modelsError} Puedes usar el predeterminado del perfil.</p>
          <button type="button" className="btn btn-small btn-ghost" disabled={submitting} onClick={() => setModelRevision(value => value + 1)}>Reintentar modelos</button></div>
        : <p className="handoff-model-hint">Se usará desde el primer mensaje de esta continuación.</p>}
    </div>}
    <div className="handoff-instruction-field">
      <label className="handoff-field-label" htmlFor={instructionId}>Siguiente paso <span>Opcional</span></label>
      <textarea id={instructionId} className="input handoff-instruction" tabIndex={0} rows={3} value={instruction}
        maxLength={4_000} disabled={submitting} onChange={event => setInstruction(event.currentTarget.value)}
        placeholder={DEFAULT_HANDOFF_INSTRUCTION} />
    </div>
    {loading ? <p className="handoff-status" role="status"><span className="chat-spinner" aria-hidden="true" /> Preparando el contexto del proyecto…</p>
      : error ? <p className="handoff-status error" role="alert">{error}</p>
      : <p className="handoff-status">{context.messageCount} {context.messageCount === 1 ? "mensaje disponible" : "mensajes disponibles"}
        {limited ? " · contexto acotado" : " · historial local"}
        {context.imagesOmitted > 0 ? ` · ${context.imagesOmitted} ${context.imagesOmitted === 1 ? "imagen omitida" : "imágenes omitidas"}` : ""}.
        <span>El nuevo asistente verificará el estado actual antes de continuar.</span>
      </p>}
    <details className="handoff-preview">
      <summary tabIndex={0}>Revisar contexto</summary>
      <pre tabIndex={0} aria-label="Contexto para el nuevo asistente">{prepared?.content ?? context.content}</pre>
    </details>
  </FeatureDialog>;
}
