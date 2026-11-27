/**
 * Ajustes › Conexiones › Navegador › «Tu navegador»: la extensión de trex en el navegador de
 * siempre. Como el control remoto o la voz, se aplica al momento (no espera a «Guardar») y
 * nace apagada. La lógica vive en src-tauri/src/browser_bridge.rs y en la carpeta `extension/`.
 * Debajo, la recomendación de un perfil solo para los agentes y la limpieza del antiguo Trex Browser.
 */
import { useEffect, useId, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { browserBridgeConfigure, browserBridgeOpenExtension,browserBridgePairingCancel, browserBridgePairingStart, browserBridgeRevoke, browserBridgeStatus, formatError, type BrowserAfterAction, type BrowserBridgeStatus } from "../api";
import { Segmented } from "./AgentSetup";
import { GlobeIcon } from "./Icons";
import SettingInfo from "./SettingInfo";
import LegacyBrowserCleanup from "./LegacyBrowserCleanup";
import "./BrowserSettings.css";
import "./RemoteSettings.css";

/** `seen`: un estado de trex pedido después del código ya confirmó que el emparejado está abierto. */
type Pairing = { code: string; expiresAt: number; seen: boolean };

/** El de src-tauri/src/browser_bridge.rs (DEFAULT_PORT) y el que trae la extensión. */
const DEFAULT_PORT = 7341;
/** La extensión que sabe contar qué cambió tras cada acción (CAPTURE_EXTENSION en browser_bridge.rs). */
const CAPTURE_EXTENSION = [0, 3, 0];
const AFTER_OPTIONS: { value: BrowserAfterAction; label: string }[] = [
  { value: "off", label: "Nada" }, { value: "text", label: "Qué cambió" }, { value: "image", label: "Con imagen" },
];
/** Si una versión de la extensión («0.2.0») es anterior a `minimum`. */
function olderExtension(version: string | null, minimum = CAPTURE_EXTENSION): boolean {
  if (!version) return false;
  const parts = version.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    const part = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (part !== minimum[index]) return part < minimum[index];
  }
  return false;
}
const validPort = (value: number): boolean => Number.isInteger(value) && value >= 1024 && value <= 65535;
/** Las respuestas de trex pueden llegar desordenadas: solo vale la de la petición más reciente. */
const newest = (seq: number, applied: { current: number }): boolean => {
  if (seq < applied.current) return false;
  applied.current = seq;
  return true;
};

export default function ChromeBridgeSettings() {
  return <><BrowserBridge /><LegacyBrowserCleanup /></>;
}

function BrowserBridge() {
  const id = useId();
  const [status, setStatus] = useState<BrowserBridgeStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Lo que se escribe en el campo del puerto; `null` muestra el de trex. */
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const issued = useRef(0), applied = useRef(0);

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      const seq = ++issued.current;
      void browserBridgeStatus().then(value => { if (alive && newest(seq, applied)) setStatus(value); }).catch(reason => { if (alive) setError(formatError(reason)); });
    };
    refresh();
    const stop = listen("browser-bridge://status", refresh);
    return () => { alive = false; void stop.then(unlisten => unlisten()); void browserBridgePairingCancel().catch(() => undefined); };
  }, []);

  // El código caduca: la cuenta atrás solo corre mientras se muestra.
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);
  // Código caducado o función apagada: el código deja de mostrarse. Emparejado hecho (o cerrado
  // tras los intentos fallidos): trex, que ya lo había dado por abierto, lo da por cerrado.
  // Hasta ese primer «abierto» no se mira, porque el estado de antes de pulsar «Emparejar»
  // todavía dice que no hay emparejado y borraría el código recién llegado.
  useEffect(() => {
    if (!pairing || !status) return;
    if (!status.enabled || pairing.expiresAt <= now) setPairing(null);
    else if (status.pairing && !pairing.seen) setPairing({ ...pairing, seen: true });
    else if (!status.pairing && pairing.seen) setPairing(null);
  }, [pairing, status, now]);

  const run = async (action: () => Promise<BrowserBridgeStatus | void>): Promise<void> => {
    setBusy(true); setError(null);
    const seq = ++issued.current;
    try { const next = await action(); if (next && newest(seq, applied)) setStatus(next); }
    catch (reason) { setError(formatError(reason)); }
    finally { setBusy(false); }
  };

  if (!status) return <div className="browser-settings-card"><p className="settings-hint">{error ?? "Comprobando…"}</p></div>;

  const seconds = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
  const state = !status.enabled ? "Apagado" : status.connected ? "Conectado" : status.running ? "Esperando a la extensión" : status.error ? "Sin conexión" : "Arrancando…";
  const portText = portDraft ?? String(status.port);
  const portValue = Number(portText);
  // Se aplica al salir del campo; un puerto no válido se queda escrito y marcado.
  const applyPort = (): void => {
    if (portDraft === null) return;
    if (!validPort(portValue)) return;
    if (portValue === status.port) { setPortDraft(null); return; }
    void run(() => browserBridgeConfigure({ enabled: status.enabled, port: portValue })).then(() => setPortDraft(null));
  };

  return <><div className="browser-settings-card chrome-bridge">
    <div className="browser-settings-heading"><span className="browser-settings-badge" aria-hidden="true"><GlobeIcon size={20} /></span>
      <div><h4>Tu navegador<SettingInfo text="Con la extensión de trex, los agentes ven y manejan tu navegador (Chrome, Brave o Edge) con las sesiones iniciadas en el perfil donde la instales. Solo alcanzan sus propias pestañas, que cada chat agrupa con su nombre, y las que tú compartes desde el botón de la extensión." /></h4></div>
      <span className={`browser-settings-status${status.connected ? " is-ready" : ""}`} role="status">{state}</span>
    </div>
    <label className="browser-settings-toggle"><span><strong>Los agentes pueden usar tu navegador</strong></span>
      <input type="checkbox" role="switch" aria-label="Los agentes pueden usar tu navegador" checked={status.enabled} disabled={busy}
        onChange={event => void run(() => browserBridgeConfigure({ enabled: event.currentTarget.checked, port: status.port }))} /></label>
    {status.enabled && status.error && <p className="browser-settings-error" role="alert">{status.error}</p>}

    {status.enabled && <>
      <p className="browser-settings-note">En una pestaña compartida el agente actúa con tu sesión de ese sitio, y lo que lee se envía al proveedor del modelo.</p>
      <div className="remote-port">
        <label htmlFor={`${id}-port`}>Puerto <SettingInfo text={`Solo en este equipo (127.0.0.1). Cámbialo si otro programa ya usa el ${status.port}. Los navegadores ya emparejados se quedan con el anterior: en la extensión, «Desvincular» y vuelve a emparejar con el puerto nuevo en «Avanzado».`} /></label>
        <input id={`${id}-port`} className="input" inputMode="numeric" value={portText} disabled={busy} aria-invalid={!validPort(portValue)}
          onChange={event => setPortDraft(event.currentTarget.value.replace(/\D/g, "").slice(0, 5))}
          onBlur={applyPort} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </div>

      <div className="browser-settings-after">
        <span id={`${id}-after`}>Tras cada acción, el agente ve <SettingInfo text="Después de hacer clic, escribir o navegar, la extensión le cuenta al agente qué cambió en la página: lo que apareció o desapareció, la dirección, el foco. «Con imagen» añade una captura de solo esa zona (unos cientos de tokens), con las contraseñas y los datos de pago tapados. Con «Nada» lo comprueba el agente cuando lo necesita." /></span>
        <Segmented labelledBy={`${id}-after`} value={status.afterAction} options={AFTER_OPTIONS} disabled={busy}
          onChange={value => void run(() => browserBridgeConfigure({ enabled: status.enabled, port: status.port, afterAction: value }))} />
        {status.afterAction !== "off" && status.browsers.some(browser => browser.connected && olderExtension(browser.version))
          && <small>La extensión de tu navegador es anterior a la 0.3.0: recárgala en chrome://extensions para que esto funcione.</small>}
      </div>

      {pairing
        ? <div className="remote-pairing">
          <div className="remote-pairing-info">
            <ol className="remote-steps">
              <li><span>01</span>Pulsa el botón de trex en tu navegador.</li>
              <li><span>02</span>Escribe este código.</li>
              {status.port !== DEFAULT_PORT && <li><span>03</span>En «Avanzado», pon el puerto {status.port}.</li>}
            </ol>
            <div className="remote-code" aria-label={`Código ${pairing.code}`}>{pairing.code.slice(0, 3)}<i>–</i>{pairing.code.slice(3)}</div>
            <div className="remote-pairing-foot"><span>Caduca en {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => { setPairing(null); void browserBridgePairingCancel().catch(() => undefined); }}>Cancelar</button></div>
          </div>
        </div>
        : <div className="browser-settings-foot">
          <span>{status.browsers.length ? `${status.browsers.length} ${status.browsers.length === 1 ? "navegador emparejado" : "navegadores emparejados"}` : "Sin navegadores emparejados"}</span>
          {status.extensionPath && <button type="button" className="btn btn-small btn-ghost" data-tip="Cárgala en chrome://extensions con «Cargar descomprimida»"
            onClick={() => void browserBridgeOpenExtension().catch(reason => setError(formatError(reason)))}>Carpeta de la extensión</button>}
          <button type="button" className="btn btn-small btn-primary" disabled={busy || !status.running}
            onClick={() => void run(async () => {
              setNow(Date.now());
              const started = await browserBridgePairingStart();
              setPairing({ code: started.code, expiresAt: started.expiresAt, seen: false });
            })}>Emparejar</button>
        </div>}

      {status.browsers.length > 0 && <ul className="remote-devices">
        {status.browsers.map(browser => <li key={browser.id}>
          <span className="remote-device-name">{browser.name}</span>
          <small>{browser.connected ? <b>conectado{browser.version ? ` · v${browser.version}` : ""}</b> : "sin conexión"}</small>
          <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(() => browserBridgeRevoke(browser.id))}>Desvincular</button>
        </li>)}
      </ul>}
    </>}
    {error && <p className="browser-settings-error" role="alert">{error}</p>}
  </div>
  {status.enabled && <div className="browser-settings-card">
    <h4>Un perfil solo para los agentes</h4>
    <p className="settings-hint">Recomendado: así no ven tus sesiones personales, solo las que inicies en ese perfil.</p>
    <ol className="remote-steps">
      <li><span>01</span>En Chrome, Brave o Edge, crea un perfil nuevo desde el icono de tu perfil.</li>
      <li><span>02</span>En ese perfil, carga la extensión de trex (botón «Carpeta de la extensión»).</li>
      <li><span>03</span>Pulsa «Emparejar» y escribe el código en la extensión.</li>
    </ol>
  </div>}
  </>;
}
