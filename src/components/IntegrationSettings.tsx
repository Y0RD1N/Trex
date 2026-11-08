import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { a11yStatus, desktopStatus, formatError, githubConnectionStatus, integrationDependencies, type A11yStatus, type DesktopStatus, type GitHubConnectionStatus, type IntegrationDependencies } from "../api";
import "./BrowserSettings.css";
import "./IntegrationSettings.css";
import type { ApplicationIntegrations } from "../types";
import { SystemIcon } from "./Icons";

const guides = {
  blender: "https://www.blender.org/download/",
  hyperframes: "https://hyperframes.app/docs/5-packages/cli",
  github: "https://cli.github.com/manual/",
};

/** Availability is a file probe only; it never launches or configures an integration. */
export default function IntegrationSettings({ cwd, desktopEnabled, onDesktopChange, a11yEnabled, onA11yChange, a11yKeyboard, onA11yKeyboardChange, integrations, onIntegrationsChange }: { cwd?: string; desktopEnabled: boolean; onDesktopChange: (enabled: boolean) => void; a11yEnabled: boolean; onA11yChange: (enabled: boolean) => void; a11yKeyboard: boolean; onA11yKeyboardChange: (enabled: boolean) => void; integrations: ApplicationIntegrations; onIntegrationsChange: (value: ApplicationIntegrations) => void }) {
  const [status, setStatus] = useState<IntegrationDependencies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [github, setGithub] = useState<GitHubConnectionStatus | null>(null);
  const [checkingGithub, setCheckingGithub] = useState(false);
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [a11y, setA11y] = useState<A11yStatus | null>(null);
  const [a11yError, setA11yError] = useState<string | null>(null);
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
  // El motor de accesibilidad va dentro de Trex (Windows y Linux): no hay nada que instalar.
  const engineReady = a11y?.available === true;
  const linux = a11y?.platform === "linux";
  const engineLabel = !a11y && !a11yError ? "Comprobando…" : engineReady ? "Motor de Trex listo" : a11yError ? "Revisar instalación"
    : a11y?.reason === "a11yBusUnavailable" || a11y?.reason === "sessionBusUnavailable" ? "Bus de accesibilidad no disponible" : "Solo en Windows y Linux";
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
      <label className="browser-settings-toggle"><span><strong>Usar en nuevos chats</strong><small>Independiente del control de computadora: activa el que quieras usar. Planificar solo permite leer.</small></span><input type="checkbox" role="switch" aria-label="Activar el control por accesibilidad para los agentes" checked={a11yEnabled} onChange={event => onA11yChange(event.currentTarget.checked)} /></label>
      <label className="browser-settings-toggle integration-keyboard"><span><strong>Permitir atajos de teclado</strong><small>{linux
        ? "Para lo que no tiene botón ni menú (Ctrl+S, F5…). Solo si no estás tecleando y solo en la ventana que ya está activa (Linux no deja traer ventanas al frente); la primera vez el escritorio te pide permiso."
        : "Para lo que no tiene botón ni menú (Ctrl+S, F5…). Solo si no estás tecleando: trae la ventana al frente un instante, pulsa y te devuelve el foco."}</small></span><input type="checkbox" role="switch" aria-label="Permitir atajos de teclado en el control por accesibilidad" checked={a11yKeyboard} onChange={event => onA11yKeyboardChange(event.currentTarget.checked)} /></label>
      {a11yError && <p className="browser-settings-error" role="alert">{a11yError}</p>}
      {a11y && !engineReady && linux && <p className="browser-settings-note">No se pudo usar el bus de accesibilidad (AT-SPI). Instala at-spi2-core e inicia sesión en un escritorio gráfico, y vuelve a comprobar.</p>}
      <p className="browser-settings-note">Claude, Codex, Trex CLI y Antigravity leen el árbol de accesibilidad de las ventanas y actúan sobre sus elementos (pulsar, escribir, elegir, desplegar) sin mover el ratón, así puedes seguir trabajando. {linux ? "En Linux usa AT-SPI (GNOME, KDE…) y, mientras lo usa, pide a las apps Chromium, Electron, Firefox y Qt que publiquen su árbol; no hay marco en pantalla. Cada" : "Un marco naranja muestra dónde actúa, cada"} acción se comprueba releyendo el control, y si estás usando esa misma ventana el agente espera; en un equipo, cada agente trabaja en su propia ventana. Lo que leen, incluido el texto visible de los documentos, llega al proveedor del modelo; los campos de contraseña nunca se leen. El motor de Trex no guarda nada en disco y, salvo los atajos de teclado, nunca trae ventanas al frente. Puedes detenerlo con «Detener» o Esc.</p>
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
