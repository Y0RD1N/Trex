import { useEffect, useId, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { trexBrowserEngine, trexBrowserProfiles, trexBrowserSaveFolders, trexBrowserStatus, type BrowserEngineChoice } from "../api";
import { BROWSER_SPACE_LIMIT, type BrowserProfile, type BrowserStatus } from "../browser";
import type { Settings } from "../types";
import { FolderIcon, GlobeIcon, PlusIcon, RefreshIcon, TrashIcon } from "./Icons";
import Select from "./Select";
import "./BrowserSettings.css";

export default function BrowserSettings({ settings, cwd, onChange }: {
  settings: Settings; cwd?: string; onChange: (patch: Partial<Settings>) => void;
}) {
  const engineId = useId();
  const [engine, setEngine] = useState<{ engine: BrowserEngineChoice; engines: { trex: boolean; chrome: boolean } } | null>(null);
  const [savingEngine, setSavingEngine] = useState(false);
  const [folders, setFolders] = useState<string[] | null>(null), [savingFolders, setSavingFolders] = useState(false);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Fallos de lectura de cada ajuste: sin ellos, el control desaparece sin explicación.
  const [error, setError] = useState(""), [engineError, setEngineError] = useState(""), [foldersError, setFoldersError] = useState("");
  const generation = useRef(0), mounted = useRef(true);
  const refresh = async (): Promise<void> => {
    const token = ++generation.current; setLoading(true); setError(""); setEngineError(""); setFoldersError("");
    const current = (): boolean => mounted.current && generation.current === token;
    try {
      const next = await trexBrowserStatus();
      if (!current()) return;
      setStatus(next);
      if (next.installed) trexBrowserEngine().then(value => { if (current()) setEngine(value); })
        .catch(() => { if (current()) setEngineError("No se pudo leer qué navegador usan los agentes. Pulsa Comprobar para reintentarlo."); });
      if (next.installed && next.capabilities?.saveDownloads) trexBrowserSaveFolders().then(value => { if (current()) setFolders(value.folders); })
        .catch(() => { if (current()) setFoldersError("No se pudieron leer las carpetas de descargas. Pulsa Comprobar para reintentarlo."); });
      // Solo cuenta los espacios ocupados; si falla, simplemente no se muestra.
      if (next.ready && cwd) trexBrowserProfiles(cwd).then(result => { if (current()) setProfiles(result.profiles); }).catch(() => { if (current()) setProfiles(null); });
    } catch { if (current()) setError("No se pudo comprobar Trex Browser. Vuelve a intentarlo."); }
    finally { if (current()) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; }; }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const chooseEngine = async (value: BrowserEngineChoice): Promise<void> => {
    setSavingEngine(true); setError("");
    // El estado depende del navegador elegido ("Listo" solo si ese existe): se vuelve a comprobar.
    try { const result = await trexBrowserEngine(value); if (mounted.current) { setEngine(result); void refresh(); } }
    catch { if (mounted.current) setError("No se pudo cambiar el navegador. Vuelve a intentarlo."); }
    finally { if (mounted.current) setSavingEngine(false); }
  };
  const changeFolder = async (action: "add" | "remove", folder?: string): Promise<void> => {
    const target = folder ?? await openDialog({ directory: true, multiple: false, title: "Carpeta para las descargas de los agentes" }).catch(() => null);
    if (typeof target !== "string" || !target) return;
    setSavingFolders(true); setError("");
    try { const result = await trexBrowserSaveFolders(action, target); if (mounted.current) setFolders(result.folders); }
    catch (e) { if (mounted.current) setError(typeof e === "string" ? e : "No se pudo actualizar la carpeta. Vuelve a intentarlo."); }
    finally { if (mounted.current) setSavingFolders(false); }
  };
  // BROWSER1 es el perfil manual de siempre; el resto lo reserva cada chat.
  const spaces = profiles && cwd ? profiles.filter(profile => profile.id !== "BROWSER1").length : null;
  const label = loading ? "Comprobando…" : status?.ready ? "Listo para usar" : status?.installed ? "Necesita atención" : "Componente opcional";
  return <div className="browser-settings">
    <div className="browser-settings-card">
      <div className="browser-settings-heading"><span className="browser-settings-badge" aria-hidden="true"><GlobeIcon size={20} /></span>
        <div><h4>Trex Browser</h4><p>Un espacio independiente para cada agente.</p></div>
        <span className={`browser-settings-status${status?.ready ? " is-ready" : ""}`}>{label}</span>
      </div>
      <p className="settings-hint">Prueba tu aplicación con ratón y teclado, revisa consola y red, toma capturas y graba vídeos cuando lo necesites.</p>
      <label className="browser-settings-toggle"><span><strong>Permitir navegador a los agentes</strong><small>Las nuevas sesiones lo abren al utilizar una herramienta. La planificación conserva acceso de observación.</small></span>
        <input type="checkbox" role="switch" checked={settings.browserEnabled} onChange={event => onChange({ browserEnabled: event.target.checked })} />
      </label>
      {engine && <div className="browser-settings-field">
        <label htmlFor={engineId}>Navegador para los agentes</label>
        <Select id={engineId} value={engine.engine === "trex" ? "auto" : engine.engine} disabled={savingEngine} align="start"
          onChange={value => void chooseEngine(value as BrowserEngineChoice)}
          options={[
            { value: "auto", label: engine.engines.trex ? "Trex Browser (recomendado)" : "Trex Browser (no instalado: se usa Chrome)", icon: <GlobeIcon size={16} /> },
            { value: "chrome", label: engine.engines.chrome ? "Chrome o Chromium del sistema" : "Chrome del sistema (no encontrado)", icon: <GlobeIcon size={16} />, disabled: !engine.engines.chrome },
          ]} />
        <small className="settings-hint">Se aplica a los espacios que se abran a partir de ahora; los que ya están abiertos siguen igual.</small>
      </div>}
      {!loading && !status?.installed && <p className="browser-settings-note">Selecciona Trex Browser al instalar trex o utiliza su instalador independiente.</p>}
      {status?.installed && !status.ready && <p className="browser-settings-note">{status.error?.message ?? "Revisa la instalación y la disponibilidad de Chrome."}</p>}
      <div className="browser-settings-foot"><span>{status?.version ? `Versión ${status.version}` : "Instalación independiente"}</span>
        <button type="button" className="btn btn-small btn-ghost" disabled={loading} onClick={() => void refresh()}><RefreshIcon size={14} />Comprobar</button>
      </div>
    </div>
    <div className="browser-settings-card"><h4>Espacios de navegación</h4>
      <p className="settings-hint">Cada chat recibe su propio perfil de navegación automáticamente, de modo que varios agentes pueden navegar en paralelo sin mezclar sus sesiones iniciadas. Desde el botón del navegador, en el chat, puedes revisar un espacio o iniciar sesión en él. Tus perfiles personales de Chrome permanecen separados.</p>
      {spaces !== null && <p className="settings-hint">Este proyecto usa {spaces} de {BROWSER_SPACE_LIMIT} espacios.{spaces >= BROWSER_SPACE_LIMIT - 8 && " Quedan pocos: cuando se agoten, los chats nuevos de este proyecto no podrán conectar el navegador."}</p>}
      {!cwd && <p className="settings-hint">Abre un proyecto para ver sus espacios de navegación.</p>}
    </div>
    {folders && <div className="browser-settings-card"><h4>Carpetas para descargas</h4>
      <p className="settings-hint">Con permisos completos, los agentes pueden guardar lo que descargan en el proyecto abierto y en estas carpetas. Nunca sobrescriben archivos ni escriben en carpetas ocultas.</p>
      <ul className="browser-settings-folders">
        <li className="is-fixed"><FolderIcon size={15} /><span>{cwd ?? "Proyecto abierto"}</span><small>Siempre</small></li>
        {folders.map(folder => <li key={folder}><FolderIcon size={15} /><span title={folder}>{folder}</span>
          <button type="button" className="btn btn-small btn-ghost" aria-label={`Quitar ${folder}`} disabled={savingFolders} onClick={() => void changeFolder("remove", folder)}><TrashIcon size={14} /></button></li>)}
      </ul>
      <button type="button" className="btn btn-small" disabled={savingFolders} onClick={() => void changeFolder("add")}><PlusIcon size={14} />Añadir carpeta</button>
    </div>}
    {[error, engineError, foldersError].filter(Boolean).map(message => <p key={message} className="browser-settings-error" role="alert">{message}</p>)}
  </div>;
}
