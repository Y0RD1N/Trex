import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { a11yStatus, blenderBridge, desktopStatus, formatError, githubConnectionStatus, hyperframesAdmin, integrationDependencies, type A11yStatus, type DesktopStatus, type GitHubConnectionStatus, type IntegrationDependencies } from "../api";
import { describeBridge, type BlenderBridgeStatus, type BridgeAction } from "../blenderBridge";
import { describeHyperframes, type HyperframesAction, type HyperframesStatus } from "../hyperframesStatus";
import "./BrowserSettings.css";
import "./IntegrationSettings.css";
import type { ApplicationIntegrations } from "../types";
import { CheckIcon, CloseIcon, SystemIcon } from "./Icons";

/** Marca de si una pieza del navegador está instalada, con el mismo set de iconos que el resto. */
function RuntimeMark({ ok }: { ok: boolean }) {
  return (
    <span className={`integration-runtime-mark ${ok ? "is-ok" : "is-missing"}`} role="img" aria-label={ok ? "instalado" : "falta"}>
      {ok ? <CheckIcon size={12} strokeWidth={2} /> : <CloseIcon size={12} strokeWidth={2} />}
    </span>
  );
}
import SettingInfo from "./SettingInfo";

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
  const [bridge, setBridge] = useState<BlenderBridgeStatus | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState<BridgeAction | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [hyperframes, setHyperframes] = useState<HyperframesStatus | null>(null);
  const [hyperframesBusy, setHyperframesBusy] = useState<HyperframesAction | null>(null);
  const [hyperframesError, setHyperframesError] = useState<string | null>(null);
  useEffect(() => {
    if (!cwd) return;
    let current = true;
    setHyperframes(null); setHyperframesError(null);
    void hyperframesAdmin("status", cwd).then(result => { if (current) setHyperframes(result); })
      .catch(reason => { if (current) setHyperframesError(formatError(reason)); });
    return () => { current = false; };
  }, [cwd, revision]);
  useEffect(() => {
    let current = true;
    setBridge(null); setBridgeError(null);
    void blenderBridge("status").then(result => { if (current) setBridge(result); })
      .catch(reason => { if (current) setBridgeError(formatError(reason)); });
    return () => { current = false; };
  }, [revision]);
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
  const runBridge = async (action: BridgeAction) => {
    setBridgeBusy(action); setBridgeError(null);
    try { setBridge(await blenderBridge(action)); }
    catch (reason) { setBridgeError(formatError(reason)); }
    finally { setBridgeBusy(null); }
  };
  const runHyperframes = async (action: HyperframesAction) => {
    if (!cwd) return;
    setHyperframesBusy(action); setHyperframesError(null);
    try { setHyperframes(await hyperframesAdmin(action, cwd)); }
    catch (reason) { setHyperframesError(formatError(reason)); }
    finally { setHyperframesBusy(null); }
  };
  const summary = describeBridge(bridge);
  const hyperframesSummary = describeHyperframes(hyperframes, !!cwd);
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
      <div className="browser-settings-heading"><div><h4>Control de computadora<SettingInfo text="Los agentes capturan la pantalla y manejan ratón y teclado. Experimental en Windows; no controla ventanas elevadas ni pantallas de seguridad. Vale para chats nuevos: cierra los abiertos para retirarles el acceso." /></h4></div><span className={`browser-settings-status${desktop?.available ? " is-ready" : ""}`} role="status">{desktop?.available ? "Escritorio disponible" : desktopError ? "Revisar instalación" : desktop ? "No disponible" : "Comprobando…"}</span></div>
      <label className="browser-settings-toggle"><span><strong>Activar en chats nuevos</strong></span><input type="checkbox" role="switch" aria-label="Activar control de computadora para los agentes" checked={desktopEnabled} onChange={event => onDesktopChange(event.currentTarget.checked)} /></label>
      {desktop?.available && <div className="integration-displays" aria-label="Pantallas disponibles">{desktop.monitors.map(monitor => <div className="integration-display" key={monitor.id}><span aria-hidden="true"><SystemIcon size={21}/></span><div><strong>{monitor.primary ? "Pantalla principal" : monitor.name}</strong><small>{monitor.width} × {monitor.height} · {Math.round(monitor.scaleFactor * 100)} %</small></div></div>)}</div>}
      {desktop && !desktop.available && <p className="browser-settings-note">{desktop.reason === "waylandUnsupported" ? "Esta sesión usa Wayland; el control necesita X11." : "No hay un escritorio interactivo al que conectarse."}</p>}
      {desktopError && <p className="browser-settings-error" role="alert">{desktopError}</p>}
      {desktopEnabled && <p className="browser-settings-note">La pantalla se envía al proveedor del modelo.</p>}
    </div>
    <div className="browser-settings-card integration-a11y">
      <div className="browser-settings-heading"><div><h4>Control por accesibilidad <span className="integration-badge">Experimental</span><SettingInfo text={`Los agentes leen los controles de las ventanas y actúan sobre ellos sin mover tu ratón, así puedes seguir trabajando. ${linux ? "En Linux usa AT-SPI." : "Un marco naranja muestra dónde actúan."} Si usas esa misma ventana, esperan. Se detiene con «Detener» o Esc.`} /></h4></div>
        <span className={`browser-settings-status${engineReady ? " is-ready" : ""}`} role="status">{engineLabel}</span></div>
      <label className="browser-settings-toggle"><span><strong>Activar en chats nuevos</strong></span><input type="checkbox" role="switch" aria-label="Activar el control por accesibilidad para los agentes" checked={a11yEnabled} onChange={event => onA11yChange(event.currentTarget.checked)} /></label>
      <label className="browser-settings-toggle integration-keyboard"><span><strong>Permitir atajos de teclado <SettingInfo text={linux
        ? "Para lo que no tiene botón ni menú (Ctrl+S, F5…). Solo si no estás tecleando y solo en la ventana activa; la primera vez el escritorio te pide permiso."
        : "Para lo que no tiene botón ni menú (Ctrl+S, F5…). Solo si no estás tecleando: trae la ventana al frente un instante, pulsa y te devuelve el foco."} /></strong></span><input type="checkbox" role="switch" aria-label="Permitir atajos de teclado en el control por accesibilidad" checked={a11yKeyboard} onChange={event => onA11yKeyboardChange(event.currentTarget.checked)} /></label>
      {a11yError && <p className="browser-settings-error" role="alert">{a11yError}</p>}
      {a11y && !engineReady && linux && <p className="browser-settings-note">Falta el bus de accesibilidad: instala at-spi2-core.</p>}
      {a11yEnabled && <p className="browser-settings-note">Lo que leen en las ventanas se envía al proveedor del modelo; las contraseñas, nunca.</p>}
    </div>
    <div className="browser-settings-card"><div className="browser-settings-heading"><div><h4>Aplicaciones<SettingInfo text="Las que actives se anuncian a tus agentes al abrir o reiniciar un chat." /></h4></div><button type="button" className="btn btn-small" onClick={() => setRevision(value => value + 1)}>Comprobar</button></div>
      <div className="integration-apps">{apps.map(app => <div className={`integration-app${integrations[app.id] ? " is-enabled" : ""}`} key={app.id}>
        <div className="integration-app-title"><strong>{app.name}</strong></div>
        <label className="integration-app-switch"><input type="checkbox" role="switch" aria-label={`Activar ${app.name} para los agentes`} checked={integrations[app.id]}
          onChange={event => onIntegrationsChange({ ...integrations, [app.id]: event.currentTarget.checked })} /></label>
        <p>{app.description}</p><div className="integration-app-footer"><span>{status ? app.found ? "Detectado" : "No detectado" : "Comprobando…"}</span><button type="button" className="btn btn-small" onClick={() => guide(app.url)}>Guía</button></div>
      </div>)}</div>
      {integrations.github && status?.githubCli && <div className="browser-settings-foot"><span>GitHub: {github === "connected" ? "conectado" : github === "timeout" ? "sin respuesta" : github ? "sin sesión" : "sin comprobar"}</span><button type="button" className="btn btn-small" disabled={checkingGithub} onClick={() => void checkGithub()}>{checkingGithub ? "Comprobando…" : "Comprobar"}</button></div>}
      {status && <p className="browser-settings-note">Node <RuntimeMark ok={status.node} /> · FFmpeg <RuntimeMark ok={status.ffmpeg} /></p>}
      {error && <p className="browser-settings-error" role="alert">{error}</p>}
    </div>
    <div className="browser-settings-card integration-bridge">
      <div className="browser-settings-heading"><div><h4>Blender en vivo<SettingInfo text="Tus agentes ven y manejan el Blender que tienes abierto, ejecutando Python según su modo de permisos. Instalar el puente lo activa en cada Blender que abras; se pausa desde el indicador «Trex» de su barra de estado. Las capturas de la escena llegan al proveedor del modelo." /></h4></div>
        <span className={`browser-settings-status${summary.tone === "ready" ? " is-ready" : ""}`} role="status">{summary.label}</span></div>
      {summary.lines.length > 0 && <ul className="integration-bridge-lines" aria-label="Estado del puente con Blender">{summary.lines.map(line => <li key={line}>{line}</li>)}</ul>}
      <div className="integration-bridge-actions">
        <button type="button" className="btn btn-small" disabled={!summary.canOpen || bridgeBusy !== null} onClick={() => void runBridge("open")}>{bridgeBusy === "open" ? "Abriendo Blender…" : "Abrir Blender con Trex"}</button>
        {summary.installLabel && <button type="button" className="btn btn-small" disabled={bridgeBusy !== null} onClick={() => void runBridge("install")}>{bridgeBusy === "install" ? "Instalando…" : summary.installLabel}</button>}
        {summary.canUninstall && <button type="button" className="btn btn-small" disabled={bridgeBusy !== null} onClick={() => void runBridge("uninstall")}>{bridgeBusy === "uninstall" ? "Quitando…" : "Quitar el puente"}</button>}
      </div>
      {bridgeError && <p className="browser-settings-error" role="alert">{bridgeError}</p>}
    </div>
    <div className="browser-settings-card integration-bridge">
      <div className="browser-settings-heading"><div><h4>HyperFrames<SettingInfo text="Vídeo con HTML: tus agentes lo crean, lo ven y lo renderizan con la versión que tengas instalada. Las skills son sus instrucciones oficiales y solo se instalan al pulsar el botón. Los fotogramas llegan al proveedor del modelo." /></h4></div>
        <span className={`browser-settings-status${hyperframesSummary.tone === "ready" ? " is-ready" : ""}`} role="status">{hyperframesSummary.label}</span></div>
      {hyperframesSummary.lines.length > 0 && <ul className="integration-bridge-lines" aria-label="Estado de HyperFrames">{hyperframesSummary.lines.map(line => <li key={line}>{line}</li>)}</ul>}
      {hyperframesSummary.skillsLabel && <div className="integration-bridge-actions">
        <button type="button" className="btn btn-small" disabled={hyperframesBusy !== null} onClick={() => void runHyperframes("skillsUpdate")}>{hyperframesBusy === "skillsUpdate" ? "Instalando skills…" : hyperframesSummary.skillsLabel}</button>
      </div>}
      {hyperframesError && <p className="browser-settings-error" role="alert">{hyperframesError}</p>}
    </div>
  </div>;
}
