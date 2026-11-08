import { useEffect, useState } from "react";
import { formatError } from "../api";
import { workflowEffortLevels } from "../agentWorkflow";
import { validAgentPermission } from "../agentPermissions";
import { EFFORT_LEVELS, fastSpeed, modelDescription, modelName, normalizeEffortChoice, normalizeModelChoice, type ModelInfo } from "../chatState";
import { loadProfileModels } from "../profileModels";
import type { SelectOption } from "../components/Select";
import type { AgentProvider, LauncherProfile, Settings } from "../types";

/** Lo que elige el usuario para un agente; `fast` null/ausente conserva la velocidad del perfil. */
export type WorkflowRequest = {
  planner: { profileId: string; model: string | null; effort: string | null; fast?: boolean | null; mode?: string | null };
  executor: { profileId: string; model: string | null; effort: string | null; fast?: boolean | null; mode?: string | null };
};

export type Target = { profile: LauncherProfile; reason: string | null };
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
  const [fastChoices, setFastChoices] = useState<Record<string, boolean | null>>(() => initial ? { [initial.profileId]: initial.fast ?? null } : {});
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
  // La velocidad rápida depende del modelo: sin un modelo que la admita no se envía ninguna elección.
  const speed = model && validModel ? fastSpeed(models, null, model) : null;
  const fast = speed ? fastChoices[selectedId] ?? null : null;

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
    { value: "", label: "Predeterminado", description: "El modelo configurado en el perfil." },
    ...models.map(item => ({ value: item.value,
      label: item.value === "default" ? "Recomendado" : modelName(item),
      description: modelDescription(item, models), group: item.featured ? "Modelos" : "Otras versiones" })),
    ...(!loading && model && !validModel ? [{ value: model, label: `No disponible · ${model}`, disabled: true }] : []),
  ];
  const effortOptions: SelectOption[] = [
    { value: "", label: "Predeterminado", description: "El esfuerzo del perfil o del asistente." },
    ...effortLevels.map(level => ({ value: level, label: EFFORT_LEVELS[level].label, description: EFFORT_LEVELS[level].hint })),
  ];
  /** Por qué el esfuerzo no se puede elegir (o qué se usará); solo se enseña a demanda. */
  const effortHint = inheritedEffort ? "Conserva el esfuerzo que ya elegiste en esta conversación."
    : !model ? "Elige un modelo para ver sus niveles de esfuerzo."
    : loading ? "Disponible cuando termine de cargar el catálogo."
    : error ? "No se pudieron verificar los niveles; se usará el predeterminado."
    : !validModel ? "Elige un modelo disponible."
    : !effortLevels.length ? "Este modelo no ofrece niveles de esfuerzo configurables."
    : "";
  const speedHint = !model ? "Elige un modelo para ver si admite velocidad rápida."
    : loading ? "Disponible cuando termine de cargar el catálogo."
    : !validModel || error ? "No se pudo comprobar la velocidad del modelo."
    : !speed ? "Este modelo no tiene velocidad rápida."
    : speed.hint;

  const mode = profile && validAgentPermission(profile.provider, permissionChoices[selectedId]) ? permissionChoices[selectedId] ?? null : null;
  return { profile, profileId: selectedId, setProfileId, model, models, options, loading, error, validModel, mode,
    setMode: (mode: string | null) => setPermissionChoices(previous => ({ ...previous, [selectedId]: mode })),
    effort, effortLevels, effortOptions, effortHint, fast, speed, speedHint,
    ready: !!profile && !loading && validModel,
    setModel: (value: string) => setModelChoices(previous => ({ ...previous, [selectedId]: value })),
    setFast: (value: boolean) => setFastChoices(previous => ({ ...previous, [selectedId]: value })),
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

export type Stage = ReturnType<typeof useWorkflowStage>;
