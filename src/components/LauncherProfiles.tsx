import { useId, useRef, useState } from "react";
import type { AgentProvider, AppInfo, ClaudeInfo, LauncherProfile } from "../types";
import { PROVIDER_NAMES, trexProfileArgs } from "../profiles";
import { ChevronIcon, CopyIcon, PlusIcon, TrashIcon } from "./Icons";
import AgentIcon from "./AgentIcon";
import Select from "./Select";
import { useDialog } from "./DialogProvider";
import TrexCliProfiles, { trexConnectionName, useTrexCliProfiles, type TrexCliProfile } from "./TrexCliProfiles";
import "./LauncherProfiles.css";
import AntigravitySetup from "./AntigravitySetup";

type Props = {
  profiles: LauncherProfile[];
  defaultProfileId: string;
  appInfo: AppInfo | null;
  claudeInfo: ClaudeInfo | null;
  codexInfo: ClaudeInfo | null;
  onChange: (profiles: LauncherProfile[], defaultProfileId: string) => void;
  onRedetect: () => void;
  /** The settings host must keep Save/Close pending until native writes finish. */
  onBusyChange?: (busy: boolean) => void;
};

export default function LauncherProfiles({ profiles, defaultProfileId, appInfo, claudeInfo, codexInfo, onChange, onRedetect, onBusyChange }: Props) {
  const id = useId();
  const dialog = useDialog();
  const trex = useTrexCliProfiles();
  const [selectedId, setSelectedId] = useState(defaultProfileId);
  const [advanced, setAdvanced] = useState(false);
  const [customStartId, setCustomStartId] = useState<string | null>(null);
  const [creatingTrex, setCreatingTrex] = useState(false);
  const [trexBusy, setTrexBusy] = useState(false);
  const [trexNotice, setTrexNotice] = useState("");
  const latest = useRef({ profiles, defaultProfileId });
  latest.current = { profiles, defaultProfileId };
  const selected = profiles.find(profile => profile.id === selectedId) ?? profiles[0];
  const trexReady = !!trex.status?.installed && !trex.loading && !trex.error;
  const changeTrexBusy = (busy: boolean): void => { setTrexBusy(busy); onBusyChange?.(busy); };
  const focusProfile = (profileId: string): void => { requestAnimationFrame(() => document.getElementById(`${id}-profile-${profileId}`)?.focus()); };
  const patch = (changes: Partial<LauncherProfile>): void => onChange(profiles.map(profile => profile.id === selected.id ? { ...profile, ...changes } : profile), defaultProfileId);
  const uniqueName = (base: string): string => {
    let name = base, index = 2;
    while (profiles.some(profile => profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) name = `${base} ${index++}`;
    return name;
  };
  const add = (provider: AgentProvider, duplicate?: LauncherProfile): void => {
    if (provider === "trex") return;
    const profile: LauncherProfile = duplicate
      ? { ...duplicate, id: crypto.randomUUID(), name: uniqueName(`${duplicate.name} · copia`) }
      : { id: crypto.randomUUID(), name: uniqueName(PROVIDER_NAMES[provider]), provider, command: provider === "antigravity" ? "antigravity-acp" : provider, args: "", shell: "", launchMode: "arg", configDir: "" };
    onChange([...profiles, profile], defaultProfileId);
    setSelectedId(profile.id);
    setCreatingTrex(false);
    setTrexNotice("");
    setAdvanced(false);
    requestAnimationFrame(() => document.getElementById(`${id}-name`)?.focus());
  };
  const remove = (): void => {
    if (profiles.length <= 1) return;
    const remaining = profiles.filter(profile => profile.id !== selected.id);
    onChange(remaining, selected.id === defaultProfileId ? remaining[0].id : defaultProfileId);
    setSelectedId(remaining[0].id);
  };
  const sameConnection = (profile: LauncherProfile, name: string): boolean => profile.provider === "trex" && !profile.configDir.trim() && trexConnectionName(profile).toLocaleLowerCase() === name.toLocaleLowerCase();
  const savedConnection = (connection: TrexCliProfile): void => {
    trex.remember(connection);
    const current = latest.current;
    const existing = current.profiles.find(profile => sameConnection(profile, connection.name));
    if (existing) {
      setSelectedId(existing.id); setCreatingTrex(false);
      setTrexNotice(creatingTrex ? "Conexión seleccionada en tus asistentes." : "Conexión guardada en Trex CLI. Se aplicará a las sesiones nuevas.");
      focusProfile(existing.id); return;
    }
    let name = connection.name, index = 2;
    while (current.profiles.some(profile => profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) name = `${connection.name} ${index++}`;
    // A launcher is a reference only. API credentials never enter Settings or SessionLaunch.
    const profile: LauncherProfile = { id: crypto.randomUUID(), name, provider: "trex", command: "trex-agent",
      args: trexProfileArgs(connection.name), shell: "", launchMode: "arg", configDir: "" };
    onChange([...current.profiles, profile], current.defaultProfileId);
    setSelectedId(profile.id); setCreatingTrex(false);
    setTrexNotice("Conexión guardada en Trex CLI. Pulsa Guardar cambios para conservarla en tus asistentes.");
    focusProfile(profile.id);
  };
  const removedConnection = (name: string): void => {
    trex.forget(name);
    const current = latest.current;
    const remaining = current.profiles.filter(profile => !sameConnection(profile, name));
    setTrexNotice("Conexión eliminada de Trex CLI. Pulsa Guardar cambios si también se ha quitado de tus asistentes.");
    if (remaining.length === current.profiles.length || !remaining.length) return;
    const nextDefault = remaining.some(profile => profile.id === current.defaultProfileId) ? current.defaultProfileId : remaining[0].id;
    onChange(remaining, nextDefault);
    if (!remaining.some(profile => profile.id === selectedId)) { setSelectedId(nextDefault); setCreatingTrex(false); }
    focusProfile(remaining.some(profile => profile.id === selectedId) ? selectedId : nextDefault);
  };
  const detachTrex = async (trigger: HTMLButtonElement): Promise<void> => {
    if (profiles.length <= 1 || trexBusy) return;
    const profileId = selected.id;
    const confirmed = await dialog.confirm({ trigger, title: `¿Quitar «${selected.name}» de los asistentes?`,
      message: "La conexión y su clave se conservarán en Trex CLI. Puedes volver a añadirla después.",
      detail: "Pulsa Guardar cambios para conservar este cambio en la lista de asistentes.", confirmLabel: "Quitar perfil", cancelLabel: "Conservar" });
    if (!confirmed) return;
    const current = latest.current;
    const remaining = current.profiles.filter(profile => profile.id !== profileId);
    if (!remaining.length) return;
    const nextDefault = current.defaultProfileId === profileId ? remaining[0].id : current.defaultProfileId;
    onChange(remaining, nextDefault); setSelectedId(nextDefault);
    setTrexNotice("Perfil quitado de la lista. La conexión se conserva en Trex CLI. Pulsa Guardar cambios para conservar la lista.");
    focusProfile(nextDefault);
  };
  const info = selected.provider === "codex" ? codexInfo : claudeInfo;
  const standard = selected.command.trim() === selected.provider;
  const startOptions = selected.provider === "claude"
    ? [{ value: "", label: "Sesión nueva" }, { value: "--continue", label: "Continuar la última conversación" }, { value: "--resume", label: "Elegir una conversación anterior" }]
    : [{ value: "", label: "Sesión nueva" }, { value: "resume --last", label: "Continuar la última conversación" }, { value: "resume", label: "Elegir una conversación anterior" }];
  const startMode = customStartId !== selected.id && startOptions.some(option => option.value === selected.args) ? selected.args : "custom";

  return <div className="launcher-profiles">
    <p className="settings-note">Añade un perfil por cada comando o cuenta. Puedes abrir varios a la vez en el mismo proyecto.</p>
    <div className="profile-list" aria-label="Perfiles de asistentes">
      {profiles.map(profile => <button key={profile.id} id={`${id}-profile-${profile.id}`} type="button" className={`profile-card${!creatingTrex && profile.id === selected.id ? " selected" : ""}`} disabled={trexBusy}
        aria-pressed={!creatingTrex && profile.id === selected.id} onClick={() => { setSelectedId(profile.id); setCreatingTrex(false); setAdvanced(false); setTrexNotice(""); }}>
        <span className="profile-card-icon"><AgentIcon kind={profile.provider} size={16} /></span>
        <span className="profile-card-text"><span>{profile.name.trim() || "Sin nombre"}</span><span>{profile.provider === "trex" ? `${trexConnectionName(profile)} · ${trex.loading ? "Comprobando…" : trexReady ? "Trex API" : "No disponible"}` : profile.command.trim() || "Sin comando"}</span></span>
        {profile.id === defaultProfileId && <span className="profile-default-badge">Predeterminado</span>}
      </button>)}
    </div>
    <div className="profile-add-actions">
      <button type="button" className="btn btn-small btn-ghost" disabled={trexBusy} onClick={() => add("claude")}><PlusIcon size={13} /> Añadir Claude</button>
      <button type="button" className="btn btn-small btn-ghost" disabled={trexBusy} onClick={() => add("codex")}><PlusIcon size={13} /> Añadir Codex</button>
      <button type="button" className="btn btn-small btn-ghost" disabled={trexBusy} onClick={() => add("antigravity")}><PlusIcon size={13} /> Añadir Antigravity</button>
      <button type="button" className="btn btn-small btn-ghost" disabled={!trexReady || trexBusy} aria-describedby={`${id}-trex-hint`}
        onClick={() => { setCreatingTrex(true); setAdvanced(false); setTrexNotice(""); }}><PlusIcon size={13} /> Trex API</button>
    </div>

    <div className="trex-cli-availability" aria-busy={trex.loading}>
      <div className="trex-cli-heading"><span className="profile-card-icon"><AgentIcon kind="trex" size={16} /></span>
        <div><strong>Trex API <span>Opcional</span></strong><span role="status">{trex.loading ? "Comprobando Trex CLI…" : trex.status?.installed ? `Trex CLI disponible${trex.status.version ? ` · ${trex.status.version}` : ""}` : trex.error ? "Trex CLI no disponible" : "Trex CLI no instalado"}</span></div>
        <button type="button" className="btn btn-small btn-ghost" disabled={trex.loading || trexBusy} onClick={() => void trex.refresh()}>Comprobar</button></div>
      <p id={`${id}-trex-hint`}>{trex.error ?? (trex.status?.installed ? "Conecta DeepSeek, MiniMax, OpenRouter o una API compatible. Cada cuenta guarda su propio modelo y clave en Trex CLI." : "Trex CLI es opcional. Activa «Instalar Trex CLI» en el instalador de trex y pulsa Comprobar para añadir conexiones API. Tus perfiles de Claude y Codex siguen disponibles.")}</p>
      {trex.status?.path && <code className="trex-cli-path">{trex.status.path}</code>}
    </div>

    {trexNotice && <p className="trex-inline-note success" role="status">{trexNotice}</p>}
    {creatingTrex || selected.provider === "trex" ? <div className="profile-editor trex-profile-editor">
      <div className="profile-editor-heading"><span><AgentIcon kind="trex" size={16} /> {creatingTrex ? "Añadir Trex API" : selected.name}</span>
        {!creatingTrex && <div><button type="button" className="icon-btn" title="Quitar de los asistentes; conservar conexión en el CLI" aria-label="Quitar perfil de los asistentes"
          disabled={profiles.length <= 1 || trexBusy} onClick={event => void detachTrex(event.currentTarget)}><TrashIcon size={14} /></button></div>}</div>
      {trexReady && (creatingTrex || !selected.configDir.trim()) ? <TrexCliProfiles key={creatingTrex ? "new-trex" : selected.id} profile={creatingTrex ? undefined : selected}
        connections={trex.connections} launcherProfiles={profiles} onSaved={savedConnection} onRemoved={removedConnection} onBusyChange={changeTrexBusy}
        onCancel={creatingTrex ? () => setCreatingTrex(false) : undefined} />
        : <div className="trex-unavailable"><span className="trex-unavailable-badge">{!creatingTrex && selected.configDir.trim() ? "Carpeta personalizada" : trex.loading ? "Comprobando…" : "No disponible"}</span>
          <p>{!creatingTrex && selected.configDir.trim() ? "Esta cuenta utiliza una carpeta TREX_HOME personalizada. Gestiona su conexión desde el CLI con esa misma carpeta; estos ajustes solo administran las conexiones de la carpeta predeterminada." : trex.loading ? "Buscando Trex CLI y sus conexiones guardadas." : "Este perfil se conserva en tus ajustes. Para consultar o editar la conexión, Trex CLI debe estar instalado y disponible."}</p>
          {!creatingTrex && <dl><div><dt>Conexión</dt><dd>{trexConnectionName(selected)}</dd></div><div><dt>Comando</dt><dd>{selected.command}</dd></div><div><dt>Argumentos</dt><dd>{selected.args || "Sin argumentos"}</dd></div></dl>}
          {creatingTrex && <button type="button" className="btn btn-small btn-ghost" onClick={() => setCreatingTrex(false)}>Volver a los asistentes</button>}</div>}
      {!creatingTrex && <label className="profile-default-control"><input type="radio" name={`${id}-default-profile`} checked={selected.id === defaultProfileId} disabled={!trexReady || trexBusy} onChange={() => onChange(profiles, selected.id)} />
        <span>Usar este perfil con Ctrl+T y al iniciar trex</span></label>}
    </div> : <div className="profile-editor">
      <div className="profile-editor-heading"><span><AgentIcon kind={selected.provider} size={16} /> {PROVIDER_NAMES[selected.provider]}</span>
        <div><button type="button" className="icon-btn" title="Duplicar perfil" aria-label="Duplicar perfil" onClick={() => add(selected.provider, selected)}><CopyIcon size={14} /></button>
          <button type="button" className="icon-btn" title="Eliminar perfil" aria-label="Eliminar perfil" disabled={profiles.length <= 1} onClick={remove}><TrashIcon size={14} /></button></div>
      </div>
      {selected.provider === "antigravity" && <AntigravitySetup profile={selected} onBusyChange={changeTrexBusy} />}
      <div className="profile-field"><label htmlFor={`${id}-name`}>Nombre del perfil</label>
        <input id={`${id}-name`} className="input" value={selected.name} placeholder="Claude 1, Claude 2, Codex trabajo…" aria-invalid={!selected.name.trim()} onChange={event => patch({ name: event.currentTarget.value })} /></div>
      <div className="profile-field"><label htmlFor={`${id}-command`}>Comando</label>
        <input id={`${id}-command`} className="input settings-mono" value={selected.command} spellCheck={false} placeholder={selected.provider === "antigravity" ? "antigravity-acp" : selected.provider === "claude" ? "claude1" : "codex"}
          aria-invalid={!selected.command.trim()} aria-describedby={`${id}-command-hint`} onChange={event => patch({ command: event.currentTarget.value })} />
        <small id={`${id}-command-hint`}>{selected.provider === "antigravity" ? "Usa antigravity-acp para gestionar el componente automáticamente, o indica la ruta completa del servidor oficial." : `Nombre, ruta, alias o función de tu shell. Por ejemplo: ${selected.provider === "claude" ? "claude1 o claude2" : "codex"}.`}</small></div>
      {selected.provider !== "antigravity" && <><div className="profile-status" role="status">
        <span className={`settings-status-dot${standard && info && !info.found ? " missing" : ""}`} aria-hidden="true" />
        <span>{standard ? !info ? "Comprobando instalación…" : info.found ? `${PROVIDER_NAMES[selected.provider]} disponible${info.version ? ` · ${info.version}` : ""}` : `${PROVIDER_NAMES[selected.provider]} no detectado en el equipo` : "Comando personalizado · se ejecutará con tu shell"}</span>
        {standard && <button type="button" className="btn btn-small btn-ghost" disabled={!info} onClick={onRedetect}>Comprobar</button>}
      </div>
      {standard && info && !info.found && <p className="settings-note">Instala el CLI en tu equipo o indica la ruta de su ejecutable.</p>}
      <div className="profile-field"><label htmlFor={`${id}-start`}>Cómo empezar</label>
        <Select id={`${id}-start`} value={startMode} onChange={value => {
          if (value === "custom") { setCustomStartId(selected.id); setAdvanced(true); requestAnimationFrame(() => document.getElementById(`${id}-args`)?.focus()); }
          else { setCustomStartId(null); patch({ args: value }); }
        }} options={[...startOptions, { value: "custom", label: "Argumentos personalizados" }]} /></div></>}
      <label className="profile-default-control"><input type="radio" name={`${id}-default-profile`} checked={selected.id === defaultProfileId} onChange={() => onChange(profiles, selected.id)} />
        <span>Usar este perfil con Ctrl+T y al iniciar trex</span></label>
      <p className="settings-note">La cuenta se gestiona en el propio asistente. Cambiar un perfil solo afecta a las sesiones nuevas.</p>

      <div className="settings-advanced">
        <button type="button" className="settings-advanced-trigger" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced(!advanced)}><ChevronIcon size={13} />Opciones avanzadas del perfil</button>
        <div id={`${id}-advanced`} className={`settings-advanced-content${advanced ? " open" : ""}`} inert={!advanced} aria-hidden={!advanced || undefined}>
          <div className="settings-advanced-clip"><div className="settings-advanced-fields">
            <div className="profile-field"><label htmlFor={`${id}-args`}>Argumentos</label><input id={`${id}-args`} className="input settings-mono" value={selected.args} spellCheck={false} aria-invalid={selected.provider === "antigravity" && !!selected.args.trim()}
              placeholder={selected.provider === "codex" ? "Por ejemplo: --no-alt-screen" : "Sin argumentos adicionales"} onChange={event => patch({ args: event.currentTarget.value })} /></div>
            <div className="profile-field"><label htmlFor={`${id}-config-dir`}>Carpeta de configuración (opcional)</label><input id={`${id}-config-dir`} className="input settings-mono" value={selected.configDir} spellCheck={false}
              placeholder={selected.provider === "antigravity" ? "~/.gemini-trex-trabajo" : selected.provider === "codex" ? "~/.codex-trabajo" : "~/.claude-cuenta-2"} aria-describedby={`${id}-config-hint`} onChange={event => patch({ configDir: event.currentTarget.value })} />
              <small id={`${id}-config-hint`}>{selected.provider === "antigravity" ? "Carpeta GEMINI_HOME para una cuenta de Google independiente. Vacía: usa la cuenta de Antigravity de Trex." : `Para separar la configuración y la cuenta mediante ${selected.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}. Déjala vacía si tu comando ya lo gestiona.`}</small></div>
            <div className="profile-field"><label htmlFor={`${id}-shell`}>Shell del perfil</label><Select id={`${id}-shell`} value={selected.shell} disabled={selected.provider === "antigravity"} onChange={shell => patch({ shell })} options={[
              { value: "", label: "Usar el shell de trex" },
              ...(!appInfo?.shellOptions.some(option => option.id === selected.shell) && selected.shell ? [{ value: selected.shell, label: `${selected.shell} (actual)` }] : []),
              ...(appInfo?.shellOptions.map(option => ({ value: option.id, label: option.label, disabled: !option.available, description: option.available ? undefined : "No disponible" })) ?? []),
            ]} /></div>
            <div className="profile-field"><label htmlFor={`${id}-launch`}>Método de inicio</label><Select id={`${id}-launch`} value={selected.launchMode} disabled={selected.provider === "antigravity"} onChange={value => patch({ launchMode: value === "inject" ? "inject" : "arg" })} options={[
              { value: "arg", label: "Directo" }, { value: "inject", label: "Compatible", description: "Escribir el comando en la terminal" },
            ]} /></div>
          </div></div>
        </div>
      </div>
    </div>}
  </div>;
}
