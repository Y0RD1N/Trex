import { useId, useState } from "react";
import type { AgentProvider, AppInfo, ClaudeInfo, LauncherProfile } from "../types";
import { PROVIDER_NAMES } from "../profiles";
import { ChevronIcon, CopyIcon, PlusIcon, TrashIcon } from "./Icons";
import AgentIcon from "./AgentIcon";
import "./LauncherProfiles.css";

type Props = {
  profiles: LauncherProfile[];
  defaultProfileId: string;
  appInfo: AppInfo | null;
  claudeInfo: ClaudeInfo | null;
  codexInfo: ClaudeInfo | null;
  onChange: (profiles: LauncherProfile[], defaultProfileId: string) => void;
  onRedetect: () => void;
};

export default function LauncherProfiles({ profiles, defaultProfileId, appInfo, claudeInfo, codexInfo, onChange, onRedetect }: Props) {
  const id = useId();
  const [selectedId, setSelectedId] = useState(defaultProfileId);
  const [advanced, setAdvanced] = useState(false);
  const [customStartId, setCustomStartId] = useState<string | null>(null);
  const selected = profiles.find(profile => profile.id === selectedId) ?? profiles[0];
  const patch = (changes: Partial<LauncherProfile>): void => onChange(profiles.map(profile => profile.id === selected.id ? { ...profile, ...changes } : profile), defaultProfileId);
  const uniqueName = (base: string): string => {
    let name = base, index = 2;
    while (profiles.some(profile => profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) name = `${base} ${index++}`;
    return name;
  };
  const add = (provider: AgentProvider, duplicate?: LauncherProfile): void => {
    const profile: LauncherProfile = duplicate
      ? { ...duplicate, id: crypto.randomUUID(), name: uniqueName(`${duplicate.name} · copia`) }
      : { id: crypto.randomUUID(), name: uniqueName(PROVIDER_NAMES[provider]), provider, command: provider, args: "", shell: "", launchMode: "arg", configDir: "" };
    onChange([...profiles, profile], defaultProfileId);
    setSelectedId(profile.id);
    setAdvanced(false);
    requestAnimationFrame(() => document.getElementById(`${id}-name`)?.focus());
  };
  const remove = (): void => {
    if (profiles.length <= 1) return;
    const remaining = profiles.filter(profile => profile.id !== selected.id);
    onChange(remaining, selected.id === defaultProfileId ? remaining[0].id : defaultProfileId);
    setSelectedId(remaining[0].id);
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
      {profiles.map(profile => <button key={profile.id} type="button" className={`profile-card${profile.id === selected.id ? " selected" : ""}`}
        aria-pressed={profile.id === selected.id} onClick={() => { setSelectedId(profile.id); setAdvanced(false); }}>
        <span className="profile-card-icon"><AgentIcon kind={profile.provider} size={17} /></span>
        <span className="profile-card-text"><span>{profile.name.trim() || "Sin nombre"}</span><span>{profile.command.trim() || "Sin comando"}</span></span>
        {profile.id === defaultProfileId && <span className="profile-default-badge">Predeterminado</span>}
      </button>)}
    </div>
    <div className="profile-add-actions">
      <button type="button" className="btn btn-small btn-ghost" onClick={() => add("claude")}><PlusIcon size={13} /> Añadir Claude</button>
      <button type="button" className="btn btn-small btn-ghost" onClick={() => add("codex")}><PlusIcon size={13} /> Añadir Codex</button>
    </div>

    <div className="profile-editor">
      <div className="profile-editor-heading"><span><AgentIcon kind={selected.provider} /> {PROVIDER_NAMES[selected.provider]}</span>
        <div><button type="button" className="icon-btn" title="Duplicar perfil" aria-label="Duplicar perfil" onClick={() => add(selected.provider, selected)}><CopyIcon size={14} /></button>
          <button type="button" className="icon-btn" title="Eliminar perfil" aria-label="Eliminar perfil" disabled={profiles.length <= 1} onClick={remove}><TrashIcon size={14} /></button></div>
      </div>
      <div className="profile-field"><label htmlFor={`${id}-name`}>Nombre del perfil</label>
        <input id={`${id}-name`} className="input" value={selected.name} placeholder="Claude 1, Claude 2, Codex trabajo…" aria-invalid={!selected.name.trim()} onChange={event => patch({ name: event.currentTarget.value })} /></div>
      <div className="profile-field"><label htmlFor={`${id}-command`}>Comando</label>
        <input id={`${id}-command`} className="input settings-mono" value={selected.command} spellCheck={false} placeholder={selected.provider === "claude" ? "claude1" : "codex"}
          aria-invalid={!selected.command.trim()} aria-describedby={`${id}-command-hint`} onChange={event => patch({ command: event.currentTarget.value })} />
        <small id={`${id}-command-hint`}>Nombre, ruta, alias o función de tu shell. Por ejemplo: {selected.provider === "claude" ? "claude1 o claude2" : "codex"}.</small></div>
      <div className="profile-status" role="status">
        <span className={`settings-status-dot${standard && info && !info.found ? " missing" : ""}`} aria-hidden="true" />
        <span>{standard ? !info ? "Comprobando instalación…" : info.found ? `${PROVIDER_NAMES[selected.provider]} disponible${info.version ? ` · ${info.version}` : ""}` : `${PROVIDER_NAMES[selected.provider]} no detectado en el equipo` : "Comando personalizado · se ejecutará con tu shell"}</span>
        {standard && <button type="button" className="btn btn-small btn-ghost" disabled={!info} onClick={onRedetect}>Comprobar</button>}
      </div>
      {standard && info && !info.found && <p className="settings-note">Instala el CLI en tu equipo o indica la ruta de su ejecutable.</p>}
      <div className="profile-field"><label htmlFor={`${id}-start`}>Cómo empezar</label>
        <select id={`${id}-start`} className="input" value={startMode} onChange={event => {
          if (event.currentTarget.value === "custom") { setCustomStartId(selected.id); setAdvanced(true); requestAnimationFrame(() => document.getElementById(`${id}-args`)?.focus()); }
          else { setCustomStartId(null); patch({ args: event.currentTarget.value }); }
        }}>{startOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="custom">Argumentos personalizados</option></select></div>
      <label className="profile-default-control"><input type="radio" name={`${id}-default-profile`} checked={selected.id === defaultProfileId} onChange={() => onChange(profiles, selected.id)} />
        <span>Usar este perfil con Ctrl+T y al iniciar trex</span></label>
      <p className="settings-note">La cuenta se gestiona en el propio asistente. Cambiar un perfil solo afecta a las sesiones nuevas.</p>

      <div className="settings-advanced">
        <button type="button" className="settings-advanced-trigger" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced(!advanced)}><ChevronIcon size={13} />Opciones avanzadas del perfil</button>
        <div id={`${id}-advanced`} className={`settings-advanced-content${advanced ? " open" : ""}`} inert={!advanced} aria-hidden={!advanced || undefined}>
          <div className="settings-advanced-clip"><div className="settings-advanced-fields">
            <div className="profile-field"><label htmlFor={`${id}-args`}>Argumentos</label><input id={`${id}-args`} className="input settings-mono" value={selected.args} spellCheck={false}
              placeholder={selected.provider === "codex" ? "Por ejemplo: --no-alt-screen" : "Sin argumentos adicionales"} onChange={event => patch({ args: event.currentTarget.value })} /></div>
            <div className="profile-field"><label htmlFor={`${id}-config-dir`}>Carpeta de configuración (opcional)</label><input id={`${id}-config-dir`} className="input settings-mono" value={selected.configDir} spellCheck={false}
              placeholder={selected.provider === "codex" ? "~/.codex-trabajo" : "~/.claude-cuenta-2"} aria-describedby={`${id}-config-hint`} onChange={event => patch({ configDir: event.currentTarget.value })} />
              <small id={`${id}-config-hint`}>Para separar la configuración y la cuenta mediante {selected.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}. Déjala vacía si tu comando ya lo gestiona.</small></div>
            <div className="profile-field"><label htmlFor={`${id}-shell`}>Shell del perfil</label><select id={`${id}-shell`} className="input" value={selected.shell} onChange={event => patch({ shell: event.currentTarget.value })}>
              <option value="">Usar el shell de trex</option>
              {!appInfo?.shellOptions.some(option => option.id === selected.shell) && selected.shell && <option value={selected.shell}>{selected.shell} (actual)</option>}
              {appInfo?.shellOptions.map(option => <option key={option.id} value={option.id} disabled={!option.available}>{option.label}</option>)}
            </select></div>
            <div className="profile-field"><label htmlFor={`${id}-launch`}>Método de inicio</label><select id={`${id}-launch`} className="input" value={selected.launchMode} onChange={event => patch({ launchMode: event.currentTarget.value === "inject" ? "inject" : "arg" })}>
              <option value="arg">Directo</option><option value="inject">Compatible · escribir el comando en la terminal</option>
            </select></div>
          </div></div>
        </div>
      </div>
    </div>
  </div>;
}
