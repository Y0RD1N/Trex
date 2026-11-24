/**
 * Ajustes › Conexiones › Navegador: lo que dejó en este equipo el antiguo Trex Browser.
 *
 * Sus perfiles guardan las sesiones que iniciaron los agentes, así que nunca se borran solos:
 * aquí la persona ve cuánto ocupan y los borra (con confirmación) o abre el desinstalador de la
 * instalación aparte. Sin nada que limpiar, no se muestra. La lógica vive en
 * src-tauri/src/legacy_browser.rs.
 */
import { useEffect, useRef, useState } from "react";
import { formatError, legacyBrowserRemove, legacyBrowserStatus, legacyBrowserUninstallStandalone, type LegacyBrowserStatus } from "../api";
import { formatBytes } from "../sharedFiles";
import { useDialog } from "./DialogProvider";

export default function LegacyBrowserCleanup() {
  const dialog = useDialog();
  const [status, setStatus] = useState<LegacyBrowserStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Se borró desde aquí: la tarjeta se queda para decirlo aunque ya no quede nada. */
  const [removed, setRemoved] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Una versión de trex sin estos comandos, o un fallo al leer, simplemente no muestra nada.
    const refresh = (): void => { void legacyBrowserStatus().then(value => { if (mounted.current) setStatus(value); }).catch(() => undefined); };
    refresh();
    // El desinstalador corre aparte: al volver a la app se mira si ya terminó.
    window.addEventListener("focus", refresh);
    return () => { mounted.current = false; window.removeEventListener("focus", refresh); };
  }, []);

  if (!status || !status.found && !status.standaloneUninstaller && !removed) return null;
  const size = formatBytes(status.bytes);

  const remove = async (trigger: HTMLElement): Promise<void> => {
    const ok = await dialog.confirm({
      trigger,
      title: "Borrar los datos del antiguo Trex Browser",
      message: `Se borrarán sus perfiles, con las sesiones que iniciaron los agentes, y lo que guardó (${size}).`,
      detail: status.running ? "Trex Browser se cerrará antes. No se puede deshacer." : "No se puede deshacer.",
      confirmLabel: "Borrar datos",
      cancelLabel: "Cancelar",
      tone: "danger",
    });
    if (!ok || !mounted.current) return;
    setBusy(true); setError(null); setNote(null);
    try {
      const next = await legacyBrowserRemove();
      if (!mounted.current) return;
      setStatus(next); setRemoved(true);
      if (next.found) setError(`No se pudo borrar todo: quedan ${formatBytes(next.bytes)} en uso. Cierra Trex Browser y vuelve a intentarlo.`);
    } catch (reason) { if (mounted.current) setError(formatError(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const uninstall = async (): Promise<void> => {
    setBusy(true); setError(null); setNote(null);
    try {
      await legacyBrowserUninstallStandalone();
      if (mounted.current) setNote("Se abrió el desinstalador de Trex Browser. Sigue sus pasos para terminar.");
    } catch (reason) { if (mounted.current) setError(formatError(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <div className="browser-settings-card" role="group" aria-label="Antiguo Trex Browser">
    <h4>Antiguo Trex Browser</h4>
    {status.found
      ? <p className="settings-hint">Quedan datos del antiguo Trex Browser ({size}). Guardan sesiones iniciadas de los agentes.</p>
      : removed && <p className="settings-hint" role="status">Datos del antiguo Trex Browser borrados.</p>}
    {status.found && status.running && <p className="browser-settings-note">Trex Browser sigue abierto: se cerrará al borrar sus datos.</p>}
    {status.standaloneUninstaller && <p className="settings-hint">Sigue instalado aparte en este equipo; trex ya no lo usa.</p>}
    {(status.found || status.standaloneUninstaller) && <div className="browser-settings-foot">
      <span>No toca tu navegador ni la extensión.</span>
      <div className="browser-settings-buttons">
        {status.standaloneUninstaller && <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void uninstall()}>Desinstalar Trex Browser</button>}
        {status.found && <button type="button" className="btn btn-small" disabled={busy} onClick={event => void remove(event.currentTarget)}>Borrar datos</button>}
      </div>
    </div>}
    {note && !error && <p className="settings-hint" role="status">{note}</p>}
    {error && <p className="browser-settings-error" role="alert">{error}</p>}
  </div>;
}
