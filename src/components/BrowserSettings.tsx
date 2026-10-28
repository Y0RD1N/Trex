import { useEffect, useId, useRef, useState } from "react";
import { trexBrowserCreateProfile, trexBrowserProfiles, trexBrowserStatus } from "../api";
import { validBrowserProfile, type BrowserProfile, type BrowserStatus } from "../browser";
import type { Settings } from "../types";
import { GlobeIcon, RefreshIcon } from "./Icons";
import Select from "./Select";
import "./BrowserSettings.css";

export default function BrowserSettings({ settings, cwd, onChange, onBusyChange }: {
  settings: Settings; cwd?: string; onChange: (patch: Partial<Settings>) => void; onBusyChange: (busy: boolean) => void;
}) {
  const profileId = useId();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [loading, setLoading] = useState(false), [creating, setCreating] = useState(false);
  const [name, setName] = useState(""), [error, setError] = useState("");
  const generation = useRef(0), mounted = useRef(true), busy = useRef(false);
  const refresh = async (): Promise<void> => {
    const token = ++generation.current; setLoading(true); setError("");
    try {
      const next = await trexBrowserStatus();
      if (!mounted.current || generation.current !== token) return;
      setStatus(next);
      if (next.ready && cwd) {
        const result = await trexBrowserProfiles(cwd);
        if (mounted.current && generation.current === token) setProfiles(result.profiles);
      }
    } catch { if (mounted.current && generation.current === token) setError("No se pudo comprobar Trex Browser. Vuelve a intentarlo."); }
    finally { if (mounted.current && generation.current === token) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; }; }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async (): Promise<void> => {
    if (!cwd || busy.current || !validBrowserProfile(name.trim())) return;
    busy.current = true; setCreating(true); onBusyChange(true); setError("");
    const value = name.trim();
    try {
      const result = await trexBrowserCreateProfile(cwd, value);
      if (mounted.current) { setProfiles(result.profiles); onChange({ browserProfile: value }); setName(""); }
    } catch { if (mounted.current) setError("No se pudo crear el perfil. Revisa su nombre y vuelve a intentarlo."); }
    finally { busy.current = false; onBusyChange(false); if (mounted.current) setCreating(false); }
  };
  const label = loading ? "Comprobando…" : status?.ready ? "Listo para usar" : status?.installed ? "Necesita atención" : "Componente opcional";
  return <div className="browser-settings">
    <div className="browser-settings-card">
      <div className="browser-settings-heading"><span className="browser-settings-badge" aria-hidden="true">◎</span>
        <div><h4>Trex Browser</h4><p>Un espacio independiente para cada agente.</p></div>
        <span className={`browser-settings-status${status?.ready ? " is-ready" : ""}`}>{label}</span>
      </div>
      <p className="settings-hint">Prueba tu aplicación con ratón y teclado, revisa consola y red, toma capturas y graba vídeos cuando lo necesites.</p>
      <label className="browser-settings-toggle"><span><strong>Permitir navegador a los agentes</strong><small>Las nuevas sesiones lo abren al utilizar una herramienta. La planificación conserva acceso de observación.</small></span>
        <input type="checkbox" role="switch" checked={settings.browserEnabled} onChange={event => onChange({ browserEnabled: event.target.checked })} />
      </label>
      {!loading && !status?.installed && <p className="browser-settings-note">Selecciona Trex Browser al instalar trex o utiliza su instalador independiente.</p>}
      {status?.installed && !status.ready && <p className="browser-settings-note">{status.error?.message ?? "Revisa la instalación y la disponibilidad de Chrome."}</p>}
      <div className="browser-settings-foot"><span>{status?.version ? `Versión ${status.version}` : "Instalación independiente"}</span>
        <button type="button" className="btn btn-small btn-ghost" disabled={loading || creating} onClick={() => void refresh()}><RefreshIcon size={14} />Comprobar</button>
      </div>
    </div>
    <div className="browser-settings-card"><h4>Perfil de navegación</h4>
      <p className="settings-hint">Los chats reciben su propio perfil automáticamente y pueden navegar en paralelo. Aquí puedes crear perfiles manuales; no sustituyen los espacios de otros agentes. Tus perfiles personales de Chrome permanecen separados.</p>
      <div className="browser-settings-field">
        <label htmlFor={profileId}>Perfil manual</label>
        <Select id={profileId} value={settings.browserProfile} disabled={creating} align="start"
          menuClassName="browser-profile-menu" onChange={browserProfile => onChange({ browserProfile })}
          options={[...new Set([...profiles.map(profile => profile.id), settings.browserProfile])].map(profile => ({
            value: profile, label: profile, icon: <GlobeIcon size={16} />, group: "Perfiles del proyecto",
          }))} />
      </div>
      <div className="browser-settings-create"><label className="browser-settings-field" htmlFor="browser-profile-name">Nuevo perfil (BROWSER1–BROWSER99)<input id="browser-profile-name" className="input" placeholder="BROWSER2" value={name} maxLength={9} disabled={creating} onChange={event => setName(event.target.value)} /></label>
        <button type="button" className="btn btn-small" disabled={!cwd || !status?.ready || creating || !validBrowserProfile(name.trim())} onClick={() => void create()}>{creating ? "Creando…" : "Crear perfil"}</button>
      </div>
      {!cwd && <p className="settings-hint">Abre un proyecto para crear sus perfiles de navegación.</p>}
    </div>
    {error && <p className="browser-settings-error" role="alert">{error}</p>}
  </div>;
}
