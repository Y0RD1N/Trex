import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { desktopStatus, formatError, githubConnectionStatus, integrationDependencies, type DesktopStatus, type GitHubConnectionStatus, type IntegrationDependencies } from "../api";
import "./BrowserSettings.css";
import { SystemIcon } from "./Icons";

const guides = {
  blender: "https://www.blender.org/download/",
  hyperframes: "https://hyperframes.app/docs/5-packages/cli",
  github: "https://cli.github.com/manual/",
};

/** Availability is a file probe only; it never launches or configures an integration. */
export default function IntegrationSettings({ cwd, desktopEnabled, onDesktopChange }: { cwd?: string; desktopEnabled: boolean; onDesktopChange: (enabled: boolean) => void }) {
  const [status, setStatus] = useState<IntegrationDependencies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [github, setGithub] = useState<GitHubConnectionStatus | null>(null);
  const [checkingGithub, setCheckingGithub] = useState(false);
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setDesktop(null); setDesktopError(null);
    void desktopStatus().then(result => { if (current) setDesktop(result); })
      .catch(reason => { if (current) setDesktopError(formatError(reason)); });
    return () => { current = false; };
  }, [revision]);
  useEffect(() => {
    let current = true;
    setStatus(null); setError(null); setGithub(null);
    void integrationDependencies(cwd).then(result => { if (current) setStatus(result); })
      .catch(reason => { if (current) setError(formatError(reason)); });
    return () => { current = false; };
  }, [cwd, revision]);
  const guide = (url: string) => void openUrl(url).catch(reason => setError(formatError(reason)));
  const checkGithub = async () => {
    setCheckingGithub(true); setError(null);
    try { setGithub(await githubConnectionStatus()); }
    catch (reason) { setError(formatError(reason)); }
    finally { setCheckingGithub(false); }
  };
  const apps = [
    { name: "Blender", found: status?.blender, description: "Diseño y renderizado 3D", url: guides.blender },
    { name: "HyperFrames", found: status?.hyperframes, description: status?.hyperframesLocal ? "Detectado en el proyecto actual" : "Creación y renderizado de vídeo", url: guides.hyperframes },
    { name: "GitHub CLI", found: status?.githubCli, description: "Repositorios y pull requests", url: guides.github },
  ];
  return <div className="browser-settings">
    <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Control de computadora</h4><p>Escritorio, ratón y teclado para tus agentes</p></div><span className={`browser-settings-status${desktop?.available ? " is-ready" : ""}`} role="status">{desktop?.available ? "Escritorio disponible" : desktopError ? "Revisar instalación" : desktop ? "No disponible" : "Comprobando…"}</span></div>
      <label className="browser-settings-toggle"><span><strong>Permitir el control en nuevos chats</strong><small>Planificar permite observar; los demás modos aplican los permisos del agente.</small></span><input type="checkbox" role="switch" aria-label="Activar control de computadora para los agentes" checked={desktopEnabled} onChange={event => onDesktopChange(event.currentTarget.checked)} /></label>
      {desktop?.available && <div className="integration-displays" aria-label="Pantallas disponibles">{desktop.monitors.map(monitor => <div className="integration-display" key={monitor.id}><span aria-hidden="true"><SystemIcon size={21}/></span><div><strong>{monitor.primary ? "Pantalla principal" : monitor.name}</strong><small>{monitor.width} × {monitor.height} · {Math.round(monitor.scaleFactor * 100)} %</small></div></div>)}</div>}
      {desktop && !desktop.available && <p className="browser-settings-note">{desktop.reason === "waylandUnsupported" ? "Esta sesión usa Wayland. El control completo requiere X11; la captura y la entrada no se simulan mediante XWayland." : "No se pudo conectar a un escritorio interactivo. Comprueba que la sesión esté abierta y vuelve a comprobar."}</p>}
      {desktopError && <p className="browser-settings-error" role="alert">{desktopError}</p>}
      <p className="browser-settings-note">Trex API, Claude y Codex pueden capturar la pantalla y controlar ratón y teclado. Windows utiliza coordenadas físicas y permite elegir pantalla, incluido el escalado DPI; sigue siendo experimental. No controla ventanas elevadas ni pantallas de seguridad. Se aplica a nuevas sesiones; cierra las sesiones abiertas para retirarles el acceso. La pantalla puede enviarse al proveedor del modelo y requiere visión. Esta comprobación no toma capturas ni envía entrada.</p>
    </div>
    <div className="browser-settings-card"><div className="browser-settings-heading"><div><h4>Aplicaciones</h4><p>Comprueba qué programas están instalados.</p></div><button type="button" className="btn btn-small" onClick={() => setRevision(value => value + 1)}>Volver a comprobar</button></div>
      {apps.map(app => <div className="browser-settings-foot" key={app.name}><span><strong>{app.name}</strong><br />{app.description}<br />{status ? app.found ? "Detectado" : "No detectado" : "Comprobando…"}</span><button type="button" className="btn btn-small" onClick={() => guide(app.url)}>Guía de instalación</button></div>)}
      {status?.githubCli && <div className="browser-settings-foot"><span>Conexión de GitHub<br />{github === "connected" ? "Sesión confirmada" : github === "timeout" ? "La comprobación agotó el tiempo" : github ? "No se pudo confirmar una sesión" : "Aún no comprobada"}</span><button type="button" className="btn btn-small" disabled={checkingGithub} onClick={() => void checkGithub()}>{checkingGithub ? "Comprobando…" : "Comprobar conexión"}</button></div>}
      {status && <p className="browser-settings-note">Node: {status.node ? "detectado" : "no detectado"} · FFmpeg: {status.ffmpeg ? "detectado" : "no detectado"}. La detección no comprueba versiones. Trex API ofrece GitHub, Blender en segundo plano y comandos de HyperFrames. Claude y Codex pueden utilizar los programas instalados mediante sus herramientas habituales.</p>}
      {error && <p className="browser-settings-error" role="alert">{error}</p>}
    </div>
  </div>;
}
