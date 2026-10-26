import { useId, useRef, useState } from "react";
import { trexBrowserCall, trexBrowserOpenArtifact, trexBrowserStatus } from "../../api";
import { browserResultArtifacts, brokerArtifactId, type BrowserArtifact, type BrowserOptions, type BrowserStatus } from "../../browser";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import DropdownMenu from "../DropdownMenu";
import { CloseIcon, GlobeIcon, ImageIcon } from "../Icons";
import "./BrowserMenu.css";

/** Explicit human controls use a separate full grant; agent grants remain immutable. */
export default function BrowserMenu({ cwd, browser }: { cwd: string; browser: BrowserOptions }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null), [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("http://localhost:3000"), [error, setError] = useState("");
  const [paused, setPaused] = useState(false), [recording, setRecording] = useState(false), [otherOwner, setOtherOwner] = useState(false);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [artifacts, setArtifacts] = useState<BrowserArtifact[]>([]);
  const inFlight = useRef(false);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await trexBrowserCall({ name, arguments: args, cwd, mode: "full", clientId: browser.clientId, profile: browser.profile,
        operationId: crypto.randomUUID(), timeoutMs: 60_000 });
      if (result.isError) {
        const code = (result.structuredContent?.error as Record<string, unknown> | undefined)?.code;
        if (code === "UNCERTAIN" || code === "PAUSED") { setPaused(true); setPauseReason(code === "UNCERTAIN" ? "uncertain" : null); }
        if (code === "RECOVERY_PENDING") { setPaused(true); setPauseReason("uncertain"); setNeedsRestart(true); }
        setError(code === "READ_TIMEOUT" ? "La consulta tardó demasiado. El navegador sigue disponible; puedes volver a consultar o tomar una captura."
          : code === "RECOVERY_PENDING" ? "La ejecución anterior no terminó. Puedes tomar una captura y reiniciar este perfil para continuar."
          : code === "OWNERSHIP" ? "Otro chat controla este perfil. Utiliza Tomar control para trabajar desde aquí."
          : code === "PAUSED" ? "Los controles están pausados. Las capturas siguen disponibles."
          : "La acción no se confirmó. Puedes revisar el estado con una captura antes de continuar."); return;
      }
      const refs = browserResultArtifacts(result); if (refs.length) setArtifacts(before => [...refs, ...before].slice(0, 8));
      const data = result.structuredContent?.data as Record<string, unknown> | undefined;
      if (typeof data?.paused === "boolean") setPaused(data.paused);
      if (typeof data?.pauseReason === "string" || data?.pauseReason === null) setPauseReason(data.pauseReason);
      if (name === "browser_start_video") setRecording(true);
      if (name === "browser_stop_video") setRecording(false);
      if (name === "browser_status") {
        setRecording(!!data?.capture && (data.capture as Record<string, unknown>).kind === "video");
        setOtherOwner(data?.owner === "other");
        setNeedsRestart(data?.paused === true && (data?.pendingAction as Record<string, unknown> | undefined)?.cancelRequested === true);
      }
      if (name === "browser_takeover") setOtherOwner(false);
      if (name === "browser_resume") setNeedsRestart(false);
      if (name === "browser_close") { setNeedsRestart(false); setRecording(false); setPaused(data?.paused === true); }
    } catch { setError("No se pudo conectar con Trex Browser. Comprueba su instalación en Ajustes."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const show = (): void => {
    setAnchor({ element: trigger.current! }); setError("");
    void trexBrowserStatus().then(next => { setStatus(next); if (next.ready) void call("browser_status"); })
      .catch(() => setError("No se pudo comprobar la instalación del navegador."));
  };
  const open = async (artifact: BrowserArtifact): Promise<void> => {
    const artifactId = brokerArtifactId(artifact); if (!artifactId || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { const result = await trexBrowserOpenArtifact(artifactId, cwd, "full", browser.clientId, browser.profile); if (result.isError) setError("No se pudo abrir el archivo del navegador."); }
    catch { setError("No se pudo abrir el archivo del navegador."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const close = (): void => { setAnchor(null); trigger.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={trigger} type="button" className="chat-tray-chip chat-browser-trigger" aria-label="Controles del navegador" aria-expanded={!!anchor} aria-haspopup="dialog" aria-controls={anchor ? id : undefined}
      onClick={() => anchor ? close() : show()}><GlobeIcon size={14} /><span>Navegador</span>{recording && <i aria-label="Grabando vídeo" />}</button>
    <DropdownMenu id={id} anchor={anchor} triggerRef={trigger} label="Controles del navegador" role="dialog" className="chat-glass-menu chat-browser-menu" onClose={() => setAnchor(null)}>
      <div className="chat-browser-head"><div><strong>Trex Browser</strong><small>{browser.profile} · navegador del proyecto</small></div><button type="button" className="icon-btn" aria-label="Cerrar controles del navegador" data-menu-autofocus onClick={close}><CloseIcon size={14} /></button></div>
      {status?.ready ? <>
        <form className="chat-browser-address" onSubmit={event => { event.preventDefault(); void call("browser_navigate", { url }); }}>
          <label htmlFor={`${id}-url`}>Abrir una página</label><div><input id={`${id}-url`} type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:3000" disabled={busy} /><button type="submit" disabled={busy || paused}>Abrir</button></div>
        </form>
        <div className="chat-browser-actions">
          <button type="button" disabled={busy} onClick={() => void call("browser_take_screenshot")}><ImageIcon size={15} />Tomar captura</button>
          <button type="button" disabled={busy || (paused && !recording)} onClick={() => void call(recording ? "browser_stop_video" : "browser_start_video")}>{recording ? "■ Detener vídeo" : "○ Grabar vídeo"}</button>
          <button type="button" disabled={busy || needsRestart} onClick={() => void call(paused ? "browser_resume" : "browser_pause")}>{paused ? "Reanudar automatización" : "Pausar para revisar"}</button>
          {needsRestart && <button type="button" disabled={busy} onClick={() => void call("browser_close")}>Reiniciar perfil del navegador</button>}
          {otherOwner && <button type="button" disabled={busy} onClick={() => void call("browser_takeover")}>Tomar control para este chat</button>}
        </div>
        <p className="chat-browser-hint">{paused ? pauseReason === "uncertain" ? "Una acción quedó sin confirmar. Las capturas y consultas siguen disponibles. Revisa la página y reanuda los controles para continuar."
          : pauseReason === "runtime" ? "El servicio del navegador necesita atención. Revisa su instalación antes de reanudar los controles."
          : "Controles pausados para revisión. Las capturas y consultas siguen disponibles; reanuda cuando termines."
          : recording ? "Grabación en curso. Detén el vídeo para guardarlo." : "El agente puede revisar consola, red, rendimiento y contenido de la página."}</p>
        {needsRestart && <p className="chat-browser-hint">Reiniciar cierra las pestañas de este perfil y descarta la ejecución pendiente. Tus sesiones guardadas y los archivos se conservan; después puedes abrir la página de nuevo.</p>}
        {!!artifacts.length && <div className="chat-browser-recent"><small>Archivos recientes</small>{artifacts.map(artifact => <button type="button" key={artifact.id} disabled={busy || !brokerArtifactId(artifact)} onClick={() => void open(artifact)}>{artifact.mimeType.startsWith("video/") ? "Abrir vídeo" : "Abrir captura"}<span>{Math.max(1, Math.round(artifact.sizeBytes / 1024))} kB ↗</span></button>)}</div>}
      </> : <p className="chat-browser-hint">{!status ? "Comprobando instalación…" : status.error?.message ?? "Selecciona Trex Browser al instalar trex o utiliza su instalador independiente."}</p>}
      {error && <p className="chat-browser-error" role="alert">{error}</p>}
      <div className="chat-browser-foot">Capturas y vídeos guardados en este dispositivo.</div>
    </DropdownMenu>
  </>;
}
