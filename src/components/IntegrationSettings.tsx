import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { a11yStatus, desktopStatus, formatError, githubConnectionStatus, integrationDependencies, writeClipboard, type A11yStatus, type DesktopStatus, type GitHubConnectionStatus, type IntegrationDependencies } from "../api";
import "./BrowserSettings.css";
import "./IntegrationSettings.css";
import type { ApplicationIntegrations, Settings } from "../types";
import { SystemIcon } from "./Icons";

const guides = {
  blender: "https://www.blender.org/download/",
  hyperframes: "https://hyperframes.app/docs/5-packages/cli",
  github: "https://cli.github.com/manual/",
  agentDesktop: "https://github.com/vercel-labs/agent-desktop",
};
const A11Y_INSTALL = "npm install -g agent-desktop";

/** Availability is a file probe only; it never launches or configures an integration. */
export default function IntegrationSettings({ cwd, desktopEnabled, onDesktopChange, a11yEnabled, onA11yChange, a11yEngine, onA11yEngineChange, integrations, onIntegrationsChange }: { cwd?: string; desktopEnabled: boolean; onDesktopChange: (enabled: boolean) => void; a11yEnabled: boolean; onA11yChange: (enabled: boolean) => void; a11yEngine: Settings["a11yEngine"]; onA11yEngineChange: (engine: Settings["a11yEngine"]) => void; integrations: ApplicationIntegrations; onIntegrationsChange: (value: ApplicationIntegrations) => void }) {
  const [status, setStatus] = useState<IntegrationDependencies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [github, setGithub] = useState<GitHubConnectionStatus | null>(null);
  const [checkingGithub, setCheckingGithub] = useState(false);
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [a11y, setA11y] = useState<A11yStatus | null>(null);
  const [a11yError, setA11yError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let current = true;
    setA11y(null); setA11yError(null);
    void a11yStatus().then(result => { if (current) setA11y(result); })
      .catch(reason => { if (current) setA11yError(formatError(reason)); });
    return () => { current = false; };
  }, [revision]);
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
  // Motor de accesibilidad: el de Trex si la plataforma lo tiene; si no, agent-desktop.
  const nativeAvailable = a11y?.native?.available === true;
  const usesAgentDesktop = a11yEngine === "agent-desktop" || (!!a11y && !nativeAvailable);
  const engineReady = usesAgentDesktop ? a11y?.available === true : nativeAvailable;
  const engineLabel = !a11y && !a11yError ? "Comprobando…" : !usesAgentDesktop ? "Motor de Trex listo"
    : a11y?.available ? `agent-desktop ${a11y.version}` : a11y?.reason === "unsupportedVersion" ? "Versión antigua" : a11y?.reason === "notInstalled" ? "agent-desktop no instalado" : "Revisar instalación";
  const engines: { id: Settings["a11yEngine"]; name: string; detail: string; disabled: boolean }[] = [
    { id: "trex", name: "Motor de Trex", detail: a11y && !nativeAvailable ? "Solo disponible en Windows" : "Integrado: no hay que instalar nada", disabled: !!a11y && !nativeAvailable },
    { id: "agent-desktop", name: "agent-desktop", detail: a11y?.available ? `Externo · versión ${a11y.version}` : "Externo · hay que instalarlo", disabled: false },
  ];
  const checkGithub = async () => {
    setCheckingGithub(true); setError(null);
    try { setGithub(await githubConnectionStatus()); }
    catch (reason) { setError(formatError(reason)); }
    finally { setCheckingGithub(false); }
  };
  const apps = [
    { id: "blender" as const, name: "Blender", found: status?.blender, description: "Diseño y renderizado 3D", url: guides.blender },
    { id: "hyperframes" as const, name: "HyperFrames", found: status?.hyperframes, description: status?.hyperframesLocal ? "Detectado en el proyecto actual" : "Creación y renderizado de vídeo", url: guides.hyperframes },
    { id: "github" as const, name: "GitHub CLI", found: status?.githubCli, description: "Repositorios y pull requests", url: guides.github },
  ];
  return <div className="browser-settings integration-settings">
    <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Control de computadora</h4><p>Escritorio, ratón y teclado para tus agentes</p></div><span className={`browser-settings-status${desktop?.available ? " is-ready" : ""}`} role="status">{desktop?.available ? "Escritorio disponible" : desktopError ? "Revisar instalación" : desktop ? "No disponible" : "Comprobando…"}</span></div>
      <label className="browser-settings-toggle"><span><strong>Permitir el control en nuevos chats</strong><small>Planificar permite observar; los demás modos aplican los permisos del agente.</small></span><input type="checkbox" role="switch" aria-label="Activar control de computadora para los agentes" checked={desktopEnabled} onChange={event => onDesktopChange(event.currentTarget.checked)} /></label>
      {desktop?.available && <div className="integration-displays" aria-label="Pantallas disponibles">{desktop.monitors.map(monitor => <div className="integration-display" key={monitor.id}><span aria-hidden="true"><SystemIcon size={21}/></span><div><strong>{monitor.primary ? "Pantalla principal" : monitor.name}</strong><small>{monitor.width} × {monitor.height} · {Math.round(monitor.scaleFactor * 100)} %</small></div></div>)}</div>}
      {desktop && !desktop.available && <p className="browser-settings-note">{desktop.reason === "waylandUnsupported" ? "Esta sesión usa Wayland. El control completo requiere X11; la captura y la entrada no se simulan mediante XWayland." : "No se pudo conectar a un escritorio interactivo. Comprueba que la sesión esté abierta y vuelve a comprobar."}</p>}
      {desktopError && <p className="browser-settings-error" role="alert">{desktopError}</p>}
      <p className="browser-settings-note">Trex API, Claude y Codex pueden capturar la pantalla y controlar ratón y teclado. Windows utiliza coordenadas físicas y permite elegir pantalla, incluido el escalado DPI; sigue siendo experimental. No controla ventanas elevadas ni pantallas de seguridad. Se aplica a nuevas sesiones; cierra las sesiones abiertas para retirarles el acceso. La pantalla puede enviarse al proveedor del modelo y requiere visión. Esta comprobación no toma capturas ni envía entrada.</p>
    </div>
    <div className="browser-settings-card integration-a11y">
      <div className="browser-settings-heading"><div><h4>Control por accesibilidad <span className="integration-badge">Experimental</span></h4><p>Tus agentes manejan las apps sin tu ratón ni tu teclado</p></div>
        <span className={`browser-settings-status${engineReady ? " is-ready" : ""}`} role="status">{engineLabel}</span></div>
      <label className="browser-settings-toggle"><span><strong>Usar en nuevos chats</strong><small>Una alternativa en desarrollo: no sustituye al control de computadora. Planificar solo permite leer.</small></span><input type="checkbox" role="switch" aria-label="Activar el control por accesibilidad para los agentes" checked={a11yEnabled} onChange={event => onA11yChange(event.currentTarget.checked)} /></label>
      <div className="integration-engines" role="radiogroup" aria-label="Motor de accesibilidad">
        {engines.map(option => <button type="button" role="radio" key={option.id} className="integration-engine" aria-checked={a11yEngine === option.id} disabled={option.disabled}
          onClick={() => onA11yEngineChange(option.id)}><span className="integration-engine-dot" aria-hidden="true" /><span><strong>{option.name}</strong><small>{option.detail}</small></span></button>)}
      </div>
      {usesAgentDesktop && (a11y && !a11y.available || a11yError) && <div className="browser-settings-foot"><span>{a11y?.reason === "unsupportedVersion" ? `Hace falta agent-desktop ${a11y.minimumVersion} o posterior. Actualízalo con:` : "Instala agent-desktop (requiere Node.js) con:"}<br /><code className="integration-command">{A11Y_INSTALL}</code></span>
        <span className="integration-actions"><button type="button" className="btn btn-small" onClick={() => void writeClipboard(A11Y_INSTALL).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }, reason => setError(formatError(reason)))}>{copied ? "Copiado" : "Copiar"}</button>
        <button type="button" className="btn btn-small" onClick={() => guide(guides.agentDesktop)}>Guía</button></span></div>}
      <p className="browser-settings-note">Claude, Codex, Trex CLI y Antigravity leen el árbol de accesibilidad de las ventanas y actúan sobre sus elementos (pulsar, escribir, elegir, desplegar) sin mover el ratón, así puedes seguir trabajando. Cada acción se comprueba releyendo el control, y si estás usando esa misma ventana el agente espera. Lo que leen, incluido el texto visible de los documentos, llega al proveedor del modelo; los campos de contraseña nunca se leen. {usesAgentDesktop ? "Con agent-desktop algunas acciones pueden traer la ventana al frente; Trex guarda sus datos en una carpeta temporal que borra al cerrar el chat. " : "El motor de Trex no guarda nada en disco y nunca trae ventanas al frente. "}Solo en chats normales, no en equipos.</p>
    </div>
    <div className="browser-settings-card"><div className="browser-settings-heading"><div><h4>Aplicaciones</h4><p>Elige qué aplicaciones se anuncian a tus agentes.</p></div><button type="button" className="btn btn-small" onClick={() => setRevision(value => value + 1)}>Volver a comprobar</button></div>
      <div className="integration-apps">{apps.map(app => <div className={`integration-app${integrations[app.id] ? " is-enabled" : ""}`} key={app.id}>
        <div className="integration-app-title"><strong>{app.name}</strong><span className="integration-app-state">{integrations[app.id] ? "Activada" : "Desactivada"}</span></div>
        <label className="integration-app-switch"><input type="checkbox" role="switch" aria-label={`Activar ${app.name} para los agentes`} checked={integrations[app.id]}
          onChange={event => onIntegrationsChange({ ...integrations, [app.id]: event.currentTarget.checked })} /></label>
        <p>{app.description}</p><div className="integration-app-footer"><span>{status ? app.found ? "Detectado" : "No detectado" : "Comprobando…"}</span><button type="button" className="btn btn-small" onClick={() => guide(app.url)}>Guía de instalación</button></div>
      </div>)}</div>
      <p className="integration-session-note">Se aplica al abrir o reiniciar un chat. Las sesiones activas conservan su configuración.</p>
      {integrations.github && status?.githubCli && <div className="browser-settings-foot"><span>Conexión de GitHub<br />{github === "connected" ? "Sesión confirmada" : github === "timeout" ? "La comprobación agotó el tiempo" : github ? "No se pudo confirmar una sesión" : "Aún no comprobada"}</span><button type="button" className="btn btn-small" disabled={checkingGithub} onClick={() => void checkGithub()}>{checkingGithub ? "Comprobando…" : "Comprobar conexión"}</button></div>}
      {status && <p className="browser-settings-note">Node: {status.node ? "detectado" : "no detectado"} · FFmpeg: {status.ffmpeg ? "detectado" : "no detectado"}. La detección no comprueba versiones. Las aplicaciones desactivadas no se anuncian como integraciones. Las herramientas generales de cada agente conservan sus propios permisos.</p>}
      {error && <p className="browser-settings-error" role="alert">{error}</p>}
    </div>
  </div>;
}
