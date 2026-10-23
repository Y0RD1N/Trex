import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { LauncherProfile } from "../types";
import { trexProfileName } from "../profiles";
import { useDialog } from "./DialogProvider";
import { CheckIcon, PlusIcon, RotateIcon, TrashIcon } from "./Icons";
import Select from "./Select";
import "./TrexCliProfiles.css";

type ApiProvider = "deepseek" | "minimax" | "openrouter" | "custom";
export type TrexCliStatus = { installed: boolean; path: string | null; version?: string | null };
export type TrexCliProfile = {
  name: string;
  provider: ApiProvider;
  baseUrl: string;
  model: string;
  effort?: string | null;
  hasApiKey: boolean;
};

type ApiModel = { id: string; name: string; contextWindow?: number; efforts?: string[]; inputModalities?: string[] };
type ApiCatalog = { models: ApiModel[]; source: "remote" };
type CatalogState = { status: "idle" | "loading" | "ready" | "empty" | "error"; models: ApiModel[]; message?: string };

// A catalog supplies choices; only an explicit user choice changes the model.
const PROVIDERS: { id: ApiProvider; label: string; name: string; baseUrl: string }[] = [
  { id: "deepseek", label: "DeepSeek", name: "TREX1", baseUrl: "https://api.deepseek.com" },
  { id: "minimax", label: "MiniMax", name: "TREX2", baseUrl: "https://api.minimax.io/v1" },
  { id: "openrouter", label: "OpenRouter", name: "TREX3", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "custom", label: "Personalizada", name: "TREX4", baseUrl: "" },
];
const providerLabel = (provider: ApiProvider): string => PROVIDERS.find(item => item.id === provider)?.label ?? "Personalizada";
const sameName = (one: string, two: string): boolean => one.trim().toLocaleLowerCase() === two.trim().toLocaleLowerCase();
const safeName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
const endpoint = (url: string): string => url.trim().replace(/\/+$/, "");
const validEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    const local = ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !!url.hostname
      && !url.username && !url.password && !url.search && !url.hash && !/[\s\0]/.test(value);
  } catch { return false; }
};
// Only these complete, fixed bridge messages are safe to render. Unknown
// failures (including provider diagnostics) always receive our generic text.
const CATALOG_ERRORS = new Set([
  "La credencial no es válida o ha caducado. Comprueba la clave del proveedor.",
  "La credencial no tiene acceso al catálogo de modelos. Puedes indicar un modelo manualmente.",
  "El proveedor no ofrece un catálogo compatible. Puedes indicar un modelo manualmente.",
  "No se pudo conectar con el catálogo del proveedor. Vuelve a intentarlo.",
  "Revisa el proveedor, la dirección y la credencial. Pega la clave sin el prefijo Bearer.",
  "Trex CLI devolvió un catálogo de modelos no válido.",
]);

/** Only non-secret fields may enter component state or cross a callback. */
function summaryOnly(profile: TrexCliProfile): TrexCliProfile {
  return { name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model,
    effort: profile.effort, hasApiKey: profile.hasApiKey };
}

export function trexConnectionName(profile: LauncherProfile): string {
  return trexProfileName(profile);
}

/** Reading availability is independent of the ordinary Claude/Codex settings. */
export function useTrexCliProfiles() {
  const [status, setStatus] = useState<TrexCliStatus | null>(null);
  const [connections, setConnections] = useState<TrexCliProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    let readingProfiles = false;
    try {
      const nextStatus = await invoke<TrexCliStatus>("trex_cli_status");
      if (current !== generation.current) return;
      setStatus(nextStatus);
      if (!nextStatus.installed) { setConnections([]); return; }
      readingProfiles = true;
      const nextProfiles = await invoke<TrexCliProfile[]>("trex_cli_profiles");
      if (current === generation.current) setConnections(nextProfiles.map(summaryOnly));
    } catch {
      if (current !== generation.current) return;
      if (!readingProfiles) setStatus(null);
      setError(readingProfiles ? "No se pudieron leer las conexiones. Vuelve a comprobar antes de editarlas."
        : "No se pudo comprobar Trex CLI. Vuelve a intentarlo desde la aplicación de escritorio.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  const remember = (profile: TrexCliProfile): void => setConnections(previous => {
    const summary = summaryOnly(profile);
    return previous.some(item => sameName(item.name, summary.name))
      ? previous.map(item => sameName(item.name, summary.name) ? summary : item) : [...previous, summary];
  });
  const forget = (name: string): void => setConnections(previous => previous.filter(item => !sameName(item.name, name)));
  return { status, connections, loading, error, refresh, remember, forget };
}

type Props = {
  profile?: LauncherProfile;
  connections: TrexCliProfile[];
  launcherProfiles: LauncherProfile[];
  onSaved: (connection: TrexCliProfile) => void;
  onRemoved: (name: string) => void;
  onBusyChange: (busy: boolean) => void;
  onCancel?: () => void;
};

/** A saved CLI connection can be attached without resubmitting its credentials. */
export default function TrexCliProfiles(props: Props) {
  const [activeName, setActiveName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = props.profile ? trexConnectionName(props.profile) : activeName;
  const connection = props.connections.find(item => name !== null && sameName(item.name, name));
  const changeBusy = (value: boolean): void => { setBusy(value); props.onBusyChange(value); };
  const canRemove = !name || props.launcherProfiles.some(profile => profile.provider !== "trex" || !!profile.configDir.trim() || !sameName(trexConnectionName(profile), name));

  return <div className="trex-connections">
    {!props.profile && props.connections.length > 0 && <div className="trex-saved-connections">
      <span className="trex-section-label">Conexiones guardadas en Trex CLI</span>
      <div className="trex-connection-list" aria-label="Conexiones API guardadas">
        {props.connections.map(item => <button key={item.name} type="button" disabled={busy}
          className={`trex-connection-choice${name === item.name ? " selected" : ""}`} aria-pressed={name === item.name}
          onClick={() => setActiveName(item.name)}>
          <span><strong>{item.name}</strong><small>{providerLabel(item.provider)} · {item.model}</small></span>
          <span className="trex-key-state">{item.hasApiKey ? "Clave guardada" : "Sin clave"}</span>
        </button>)}
      </div>
      <button type="button" className="btn btn-small btn-ghost trex-new-connection" disabled={busy || name === null} onClick={() => setActiveName(null)}><PlusIcon size={13} /> Crear otra conexión</button>
    </div>}
    <TrexConnectionForm key={`${props.profile?.id ?? "new"}:${props.profile?.configDir ?? ""}:${name === null ? "create" : `existing:${name}`}`} {...props} connection={connection} fixedName={name}
      canRemove={canRemove} onBusyChange={changeBusy} onRemoved={removed => { setActiveName(null); props.onRemoved(removed); }} />
  </div>;
}

function TrexConnectionForm({ profile, connections, launcherProfiles, connection, fixedName, canRemove, onSaved, onRemoved, onBusyChange, onCancel }: Props & {
  connection?: TrexCliProfile; fixedName: string | null; canRemove: boolean;
}) {
  const id = useId();
  const dialog = useDialog();
  const nextName = (base: string): string => {
    let candidate = base, index = 2;
    while (connections.some(item => sameName(item.name, candidate)) || launcherProfiles.some(item => sameName(item.name, candidate))) candidate = `${base}_${index++}`;
    return candidate;
  };
  const [name, setName] = useState(() => fixedName ?? nextName("TREX1"));
  const [provider, setProvider] = useState<ApiProvider>(connection?.provider ?? "deepseek");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? PROVIDERS[0].baseUrl);
  const [model, setModel] = useState(connection?.model ?? "");
  const [keyEntered, setKeyEntered] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [catalog, setCatalog] = useState<CatalogState>({ status: "idle", models: [] });
  const [manualModel, setManualModel] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const catalogGeneration = useRef(0);
  const catalogPending = useRef<number | null>(null);
  const needsKey = !connection?.hasApiKey || provider !== connection.provider || endpoint(baseUrl) !== endpoint(connection.baseUrl);
  const effort = connection && provider === connection.provider && model.trim() === connection.model ? connection.effort ?? null : null;
  const changed = !connection || name.trim() !== connection.name || provider !== connection.provider || baseUrl.trim() !== connection.baseUrl
    || model.trim() !== connection.model;
  const isImport = !profile && !!connection;
  const invalidateCatalog = useCallback((): void => {
    catalogGeneration.current++;
    catalogPending.current = null;
    setCatalog({ status: "idle", models: [] });
  }, []);
  const clearSecret = (): void => {
    if (passwordRef.current) passwordRef.current.value = "";
    setKeyEntered(false);
    invalidateCatalog();
  };
  useEffect(() => {
    alive.current = true;
    const input = passwordRef.current;
    // Settings keeps hidden sections mounted. Clear the password on navigation too.
    const panel = input?.closest('[role="tabpanel"]');
    const observer = panel ? new MutationObserver(() => {
      if (panel.hasAttribute("hidden")) { if (input) input.value = ""; setKeyEntered(false); invalidateCatalog(); }
    }) : null;
    if (panel) observer?.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    return () => {
      alive.current = false; catalogGeneration.current++; catalogPending.current = null;
      if (input) input.value = "";
      observer?.disconnect(); onBusyChange(false);
    };
    // onBusyChange is deliberately excluded: form edits must not trigger cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queryModels = useCallback(async (savedConnection?: TrexCliProfile): Promise<void> => {
    if (!alive.current || inFlight.current || passwordRef.current?.closest('[role="tabpanel"]')?.hasAttribute("hidden")) return;
    const saved = savedConnection ?? connection;
    const canUseStoredKey = saved?.hasApiKey && saved.provider === provider && endpoint(saved.baseUrl) === endpoint(baseUrl);
    // Keep a fresh credential only in this local request, never in state or refs.
    let apiKey = passwordRef.current?.value.trim() ?? "";
    if (!validEndpoint(baseUrl.trim()) || (!apiKey && !canUseStoredKey)) { apiKey = ""; return; }
    if (/[\r\n\0]/.test(apiKey) || /^Bearer\s/i.test(apiKey)) {
      apiKey = "";
      setCatalog({ status: "error", models: [], message: "Pega una sola credencial, sin el prefijo Bearer ni saltos de línea." });
      return;
    }
    if (catalogPending.current === catalogGeneration.current) { apiKey = ""; return; }
    const current = ++catalogGeneration.current;
    catalogPending.current = current;
    setCatalog({ status: "loading", models: [] });
    try {
      const operation = invoke<ApiCatalog>("trex_cli_models", { request: {
        ...(canUseStoredKey && saved ? { name: saved.name } : {}), provider, baseUrl: baseUrl.trim(),
        ...(apiKey ? { apiKey } : {}), ...(profile?.configDir ? { configDir: profile.configDir } : {}),
      } });
      apiKey = "";
      const result = await operation;
      if (!alive.current || current !== catalogGeneration.current || passwordRef.current?.closest('[role="tabpanel"]')?.hasAttribute("hidden")) return;
      const models = result.models.filter((item, index, all) => item.id && all.findIndex(other => other.id === item.id) === index);
      setCatalog({ status: models.length ? "ready" : "empty", models });
    } catch (failure) {
      apiKey = "";
      // Provider bodies and arbitrary native errors may contain credentials.
      if (alive.current && current === catalogGeneration.current && !passwordRef.current?.closest('[role="tabpanel"]')?.hasAttribute("hidden")) setCatalog({ status: "error", models: [],
        message: typeof failure === "string" && CATALOG_ERRORS.has(failure) ? failure
          : "No se pudieron consultar los modelos. Revisa la credencial y la dirección de la API, reintenta o usa un ID manual." });
    } finally {
      apiKey = "";
      if (current === catalogGeneration.current) catalogPending.current = null;
    }
  }, [baseUrl, provider, connection?.name, connection?.provider, connection?.baseUrl, connection?.hasApiKey, profile?.configDir]);

  useEffect(() => {
    invalidateCatalog();
    const queryStoredModels = (): void => {
      if (connection?.hasApiKey && !needsKey && !passwordRef.current?.value.trim()) void queryModels();
    };
    queryStoredModels();
    const panel = passwordRef.current?.closest('[role="tabpanel"]');
    const observer = panel ? new MutationObserver(() => { if (!panel.hasAttribute("hidden")) queryStoredModels(); }) : null;
    if (panel) observer?.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    return () => { catalogGeneration.current++; catalogPending.current = null; observer?.disconnect(); };
  }, [queryModels, connection?.hasApiKey, needsKey, profile?.id, invalidateCatalog]);

  const showError = (field: string, message: string): void => {
    setError({ field, message }); setNotice("");
    requestAnimationFrame(() => document.getElementById(`${id}-${field}`)?.focus());
  };
  const fail = (field: string, message: string): void => { clearSecret(); showError(field, message); };
  const chooseProvider = (next: ApiProvider): void => {
    if (next === provider) return;
    const preset = PROVIDERS.find(item => item.id === next)!;
    if (!fixedName && name === nextName(PROVIDERS.find(item => item.id === provider)!.name)) setName(nextName(preset.name));
    setProvider(next); setBaseUrl(preset.baseUrl); setModel(""); clearSecret(); setError(null); setNotice("");
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (inFlight.current) return;
    setError(null); setNotice("");
    const validName = name.trim(), validModel = model.trim(), validUrl = baseUrl.trim();
    if (!changed && !passwordRef.current?.value.trim() && connection) { onSaved(summaryOnly(connection)); setNotice("Conexión añadida. Pulsa Guardar cambios para conservarla en tus asistentes."); return; }
    // Client corrections keep the catalog and uncontrolled credential usable.
    // Read the credential only once the ordinary form fields are valid.
    if (fixedName === null && !safeName(validName)) { showError("name", "Usa entre 1 y 64 letras, números, guiones o guiones bajos; empieza por una letra o un número."); return; }
    if (!fixedName && connections.some(item => sameName(item.name, validName))) { showError("name", "Ya existe una conexión con ese nombre. Selecciónala en las conexiones guardadas o elige otro nombre."); return; }
    if (!validModel || /[\r\n\0]/.test(validModel)) { showError("model", manualModel ? "Escribe el ID del modelo en una sola línea, tal como aparece en tu proveedor." : "Elige un modelo del catálogo o activa la opción de ID manual."); return; }
    if (!validEndpoint(validUrl)) { showError("url", "Usa una URL HTTPS sin claves, credenciales ni parámetros. HTTP solo está disponible para localhost."); return; }
    // Passwords live only in this uncontrolled field and this explicit native call.
    let apiKey = passwordRef.current?.value.trim() ?? "";
    if (needsKey && !apiKey) { showError("key", connection?.hasApiKey ? "Introduce la clave de la nueva API al cambiar el proveedor o su dirección." : "Introduce la clave API para guardar esta conexión."); return; }
    if (/[\r\n\0]/.test(apiKey) || /^Bearer\s/i.test(apiKey)) { apiKey = ""; fail("key", "Pega una sola credencial, sin el prefijo Bearer ni saltos de línea."); return; }
    clearSecret();
    inFlight.current = true; setPending(true); onBusyChange(true);
    let saved: TrexCliProfile;
    try {
      const operation = invoke<TrexCliProfile>("trex_cli_save_profile", { request: {
        name: validName, provider, baseUrl: validUrl, model: validModel, effort,
        ...(apiKey ? { apiKey } : {}),
      } });
      apiKey = "";
      saved = summaryOnly(await operation);
    } catch {
      apiKey = "";
      if (alive.current) fail("save", "No se pudo guardar la conexión. Comprueba Trex CLI y vuelve a intentarlo. Si escribiste una clave, introdúcela de nuevo.");
      return;
    } finally {
      inFlight.current = false;
      if (alive.current) { setPending(false); onBusyChange(false); }
    }
    if (alive.current) {
      // A successful save can rotate a key without changing any account fields.
      // Re-read its catalog by saved name; the cleared password is never needed.
      void queryModels(saved);
      onSaved(saved); setNotice("Conexión guardada en Trex CLI. Se aplicará a las sesiones nuevas.");
    }
  };

  const remove = async (trigger: HTMLButtonElement): Promise<void> => {
    if (!connection || inFlight.current || !canRemove) return;
    clearSecret();
    inFlight.current = true; setPending(true); onBusyChange(true);
    try {
      const confirmed = await dialog.confirm({ trigger, title: `¿Eliminar «${connection.name}»?`,
        message: "Se eliminarán esta conexión y su clave de Trex CLI al confirmar.",
        detail: "También se quitará de la lista de asistentes de estos ajustes. Las sesiones que la usen dejarán de poder reconectarse. Este cambio en el CLI es inmediato.",
        confirmLabel: "Eliminar conexión", cancelLabel: "Conservar", tone: "danger" });
      if (!confirmed || !alive.current) return;
      await invoke<void>("trex_cli_remove_profile", { name: connection.name });
      if (alive.current) onRemoved(connection.name);
    } catch {
      if (alive.current) fail("save", "No se pudo eliminar la conexión. Se ha conservado en tus asistentes. Comprueba Trex CLI y vuelve a intentarlo.");
    } finally {
      inFlight.current = false;
      if (alive.current) { setPending(false); onBusyChange(false); }
    }
  };
  const fieldError = (field: string): boolean => error?.field === field;
  const hint = (field: string): string => `${id}-${field}-hint${fieldError(field) ? ` ${id}-error` : ""}`;
  const missingModel = !!model && !catalog.models.some(item => item.id === model);
  const modelOptions = [
    ...(missingModel ? [{ value: model, label: `${model} (selección conservada)`, description: "No aparece en el catálogo consultado. Solo se cambia si eliges otro modelo." }] : []),
    ...catalog.models.map(item => ({ value: item.id, label: item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id })),
  ];
  const canQuery = validEndpoint(baseUrl.trim()) && (keyEntered || !needsKey);
  const catalogMessage = catalog.status === "loading" ? "Consultando modelos…"
    : catalog.status === "ready" ? `${catalog.models.length} modelo${catalog.models.length === 1 ? "" : "s"} en el catálogo del proveedor.`
    : catalog.status === "empty" ? "El proveedor devolvió un catálogo vacío. Puedes reintentar o usar un ID manual."
    : catalog.status === "error" ? catalog.message!
    : !validEndpoint(baseUrl.trim()) ? "Introduce una dirección base válida para consultar los modelos."
    : needsKey ? "Introduce la credencial completa. Al salir del campo se consultarán los modelos."
    : "Puedes consultar los modelos con la clave guardada.";

  return <form className="trex-connection-form" onSubmit={event => void save(event)} noValidate aria-label={profile ? "Editar conexión Trex API" : "Añadir conexión Trex API"} aria-busy={pending}>
    <div className="trex-form-intro"><span className="trex-section-label">{profile ? "Configuración de la conexión" : connection ? "Usar una conexión guardada" : "Nueva conexión API"}</span>
      <p>{profile ? "El modelo y la clave pertenecen a esta conexión de Trex CLI." : "Una conexión por cuenta. Elige el proveedor y el modelo que quieras usar."}</p></div>
    {profile && !connection && <p className="trex-inline-note warning" role="status">Esta conexión no aparece en Trex CLI. Puedes recuperarla con el mismo nombre y una nueva clave.</p>}
    <fieldset className="trex-provider-fieldset" disabled={pending}>
      <legend>Proveedor API</legend>
      <div className="trex-provider-options">{PROVIDERS.map(item => <button key={item.id} type="button" className={`trex-provider-option${provider === item.id ? " selected" : ""}`}
        aria-pressed={provider === item.id} onClick={() => chooseProvider(item.id)}>
        <span>{item.label}{provider === item.id && <CheckIcon size={12} />}</span><small>{item.id === "custom" ? "API compatible" : item.name}</small>
      </button>)}</div>
    </fieldset>
    <div className="profile-field"><label htmlFor={`${id}-name`}>Nombre de conexión</label>
      <input id={`${id}-name`} className="input settings-mono" value={name} disabled={pending} readOnly={fixedName !== null} maxLength={64}
        aria-invalid={fieldError("name")} aria-describedby={hint("name")} spellCheck={false} autoComplete="off" onChange={event => { setName(event.currentTarget.value); setError(null); setNotice(""); }} />
      <small id={`${id}-name-hint`}>{fixedName !== null ? "El nombre identifica esta cuenta. Para usar otro nombre, crea una conexión nueva." : "Por ejemplo: TREX1, TREX2 o TREX_trabajo. Usa un nombre distinto para cada cuenta."}</small></div>
    <div className="profile-field"><label htmlFor={`${id}-url`}>Dirección base de la API</label>
      <input id={`${id}-url`} className="input settings-mono" type="url" value={baseUrl} disabled={pending} placeholder="https://tu-proveedor.com/v1" spellCheck={false} autoComplete="off"
        aria-invalid={fieldError("url")} aria-describedby={hint("url")} onChange={event => { setBaseUrl(event.currentTarget.value); clearSecret(); setError(null); setNotice(""); }} />
      <small id={`${id}-url-hint`}>{provider === "custom" ? "Endpoint compatible con la API de OpenAI. Introduce solo la dirección base." : `Dirección de ${providerLabel(provider)}. Puedes adaptarla si tu cuenta usa otro endpoint.`}</small></div>
    <div className="profile-field trex-secret-field"><label htmlFor={`${id}-key`}>{provider === "minimax" ? "API Key o Subscription Key" : "Clave API"}{connection?.hasApiKey && !needsKey && <span className="trex-key-state"><CheckIcon size={11} /> Clave guardada</span>}</label>
      <input ref={passwordRef} id={`${id}-key`} className="input settings-mono" type="password" disabled={pending} autoComplete="new-password" spellCheck={false}
        autoCapitalize="none" aria-invalid={fieldError("key")} aria-describedby={hint("key")} placeholder={needsKey ? "Introduce la clave de esta API" : "Deja vacío para conservar la clave"}
        onChange={event => { invalidateCatalog(); setKeyEntered(!!event.currentTarget.value.trim()); setError(null); setNotice(""); }}
        onBlur={() => { if (passwordRef.current?.value.trim()) void queryModels(); }} />
      <small id={`${id}-key-hint`}>{needsKey ? "Necesaria para esta conexión. " : "Escribe una clave solo si quieres reemplazarla. "}Se usa para consultar modelos; solo se guarda al guardar la conexión. El campo se vacía al guardar o salir de estos ajustes.
        {provider === "minimax" && <> MiniMax acepta una API Key de pago por uso o una Subscription Key de M Plan / Token Plan: son productos distintos. Pega una sola credencial, sin «Bearer»; Trex lo añade automáticamente. <a href="https://platform.minimax.io/docs/m-plan/other-tools" target="_blank" rel="noreferrer">Documentación de MiniMax</a>.</>}</small></div>
    <div className="profile-field trex-model-field"><label htmlFor={`${id}-model`}>{manualModel ? "ID del modelo (manual)" : "Modelo"}</label>
      {manualModel ? <input id={`${id}-model`} className="input settings-mono" value={model} disabled={pending} placeholder="ID exacto del proveedor" spellCheck={false} autoComplete="off"
        aria-invalid={fieldError("model")} aria-describedby={hint("model")} onChange={event => { setModel(event.currentTarget.value); setError(null); setNotice(""); }} />
        : <Select id={`${id}-model`} className="settings-mono" value={model} options={modelOptions} disabled={pending || !modelOptions.length}
          placeholder={catalog.status === "loading" ? "Consultando modelos…" : "Elige un modelo del catálogo"}
          aria-invalid={fieldError("model")} aria-describedby={hint("model")} onChange={value => { setModel(value); setError(null); setNotice(""); }} />}
      <div className="trex-catalog-status-row">
        <p id={`${id}-catalog-status`} className={`trex-catalog-status${catalog.status === "error" ? " error" : ""}`} role="status" aria-live="polite" aria-atomic="true">{catalogMessage}</p>
        <button type="button" className="btn btn-small btn-ghost trex-catalog-refresh" disabled={pending || catalog.status === "loading" || !canQuery}
          aria-describedby={`${id}-catalog-status`} onClick={() => void queryModels()}><RotateIcon size={12} />{catalog.status === "loading" ? "Consultando…" : catalog.status === "error" ? "Reintentar" : catalog.status === "idle" ? "Consultar modelos" : "Actualizar"}</button>
      </div>
      <button type="button" className="trex-model-fallback" disabled={pending}
        aria-pressed={manualModel} onClick={() => { setManualModel(!manualModel); setError(null); }}>
        {manualModel ? "Volver al catálogo de modelos" : "Usar un ID manual si no hay catálogo"}</button>
      <small id={`${id}-model-hint`}>{manualModel ? `Usa el identificador exacto de tu proveedor${provider === "openrouter" ? " con su prefijo: proveedor/modelo" : ""}. ` : "Elige el modelo que se guardará para esta conexión. "}
        {missingModel && catalog.status === "ready" && "El modelo elegido no aparece en este catálogo y se conserva hasta que elijas otro. "}
        El catálogo no confirma saldo ni acceso a cada modelo. El esfuerzo se elige en el chat o en cada etapa.</small></div>
    {error && <p className="trex-inline-note error" id={`${id}-error`} role="alert">{error.message}</p>}
    {notice && <p className="trex-inline-note success" role="status"><CheckIcon size={14} />{notice}</p>}
    <div className="trex-save-notice">Guardar o eliminar una conexión modifica Trex CLI al instante. {profile ? "Cerrar estos ajustes no deshace ese cambio." : "Después, pulsa Guardar cambios para conservarla en tus asistentes."}</div>
    <div className="trex-form-actions">
      {connection && <button type="button" className="btn btn-small btn-ghost trex-delete" disabled={pending || !canRemove}
        title={canRemove ? "Eliminar conexión y clave del CLI" : "Añade otro asistente antes de eliminar esta conexión"} onClick={event => void remove(event.currentTarget)}><TrashIcon size={13} /> Eliminar conexión</button>}
      <div>{onCancel && <button type="button" className="btn btn-small btn-ghost" disabled={pending} onClick={() => { clearSecret(); onCancel(); }}>Cancelar</button>}
        <button id={`${id}-save`} type="submit" className="btn btn-small btn-primary" disabled={pending || (!!profile && !changed && !keyEntered)}>
          {pending ? "Procesando…" : isImport ? changed || keyEntered ? "Guardar y añadir" : "Añadir a asistentes" : "Guardar conexión"}</button></div>
    </div>
    {connection && !canRemove && <p className="settings-note">Añade otro asistente antes de eliminar esta conexión: siempre debe quedar un perfil.</p>}
  </form>;
}
