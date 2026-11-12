/**
 * Ajustes › Control remoto: activar el servidor, elegir la red (WireGuard, Tailscale o
 * la red local), emparejar un móvil con un QR y revocar dispositivos.
 *
 * Nace apagado. Todo se aplica al momento con los comandos de `remote.rs`; no forma
 * parte del borrador de Ajustes porque el servidor vive aparte de la configuración.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { formatError } from "../api";
import {
  REMOTE_DEFAULT_PORT, REMOTE_KIND_LABEL, remoteConfigure, remotePairingCancel, remotePairingStart, remoteRevoke, remoteStatus, suggestedInterface, validRemotePort,
  type RemotePairing, type RemoteServerSettings, type RemoteServerStatus,
} from "../remoteApi";
import { timeAgo } from "../remoteProtocol";
import { PhoneIcon } from "./Icons";
import "./BrowserSettings.css";
import "./RemoteSettings.css";

/** El QR se dibuja con los colores del tema: módulos oscuros con el color del texto. */
function QrCode({ qr, label }: { qr: NonNullable<RemotePairing["qr"]>; label: string }) {
  const path = useMemo(() => {
    let d = "";
    for (let y = 0; y < qr.width; y++) for (let x = 0; x < qr.width; x++) if (qr.modules[y * qr.width + x] === "1") d += `M${x} ${y}h1v1h-1z`;
    return d;
  }, [qr]);
  const margin = 2;
  return <svg className="remote-qr" role="img" aria-label={label} viewBox={`${-margin} ${-margin} ${qr.width + margin * 2} ${qr.width + margin * 2}`} shapeRendering="crispEdges">
    <rect x={-margin} y={-margin} width={qr.width + margin * 2} height={qr.width + margin * 2} className="remote-qr-bg" />
    <path d={path} className="remote-qr-fg" />
  </svg>;
}

export default function RemoteSettings() {
  const id = useId();
  const [status, setStatus] = useState<RemoteServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [port, setPort] = useState(String(REMOTE_DEFAULT_PORT));
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const next = await remoteStatus();
      setStatus(next);
      setPort(previous => previous === String(next.port) || busy ? previous : String(next.port));
    } catch (failure) { setError(formatError(failure)); }
  }, [busy]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); setNow(Date.now()); }, 4000);
    const unlisten = Promise.all([
      listen("remote://status", () => void refresh()),
      listen("remote://active", () => void refresh()),
      listen("remote://paired", () => { setPairing(null); void refresh(); }),
    ]);
    return () => { window.clearInterval(timer); void unlisten.then(list => list.forEach(stop => stop())); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El código caduca: la cuenta atrás se ve cada segundo mientras esté abierto.
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= pairing.expiresAt) setPairing(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);
  // Al salir de la sección, el código deja de valer.
  useEffect(() => () => { void remotePairingCancel().catch(() => undefined); }, []);

  const apply = async (patch: Partial<RemoteServerSettings>): Promise<void> => {
    if (!status) return;
    const next: RemoteServerSettings = { enabled: status.enabled, address: status.address, port: status.port, tailscaleServe: status.tailscaleServe, ...patch };
    if (next.enabled && !next.address) {
      const suggested = suggestedInterface(status.interfaces);
      if (!suggested) { setError("Elige primero en qué red escucha."); return; }
      next.address = suggested.ip;
    }
    setBusy(true); setError(null);
    try { setStatus(await remoteConfigure(next)); }
    catch (failure) { setError(formatError(failure)); }
    finally { setBusy(false); }
  };

  const pair = async (): Promise<void> => {
    setError(null);
    try { setPairing(await remotePairingStart()); setNow(Date.now()); }
    catch (failure) { setError(formatError(failure)); }
  };

  const revoke = async (device: string): Promise<void> => {
    try { await remoteRevoke(device); await refresh(); }
    catch (failure) { setError(formatError(failure)); }
  };

  if (!status) return <div className="browser-settings"><div className="browser-settings-card"><p className="settings-hint">{error ?? "Comprobando el control remoto…"}</p></div></div>;

  const selected = status.interfaces.find(item => item.ip === status.address) ?? null;
  const missing = !!status.address && !selected;
  const portValue = Number(port);
  const state = !status.enabled ? "Apagado" : status.running ? "Escuchando" : status.error ? "Sin conexión" : "Arrancando…";
  const seconds = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
  const tailscaleReady = status.tailscale.installed && status.tailscale.running && !!status.tailscale.dnsName;

  return <div className="browser-settings remote-settings">
    <div className="browser-settings-card">
      <div className="browser-settings-heading">
        <span className="browser-settings-badge" aria-hidden="true"><PhoneIcon size={20} /></span>
        <div><h4>Control remoto</h4><p>Tus sesiones siguen en este PC. Desde el móvil u otro equipo las ves y las diriges.</p></div>
        <span className={`browser-settings-status${status.running ? " is-ready" : ""}`} role="status">{state}</span>
      </div>
      <label className="browser-settings-toggle"><span><strong>Activar el control remoto</strong>
        <small>Abre un servidor solo en la red que elijas. Cada móvil se empareja una vez con un código y puedes desvincularlo cuando quieras.</small></span>
        <input type="checkbox" role="switch" aria-label="Activar el control remoto" checked={status.enabled} disabled={busy}
          onChange={event => void apply({ enabled: event.currentTarget.checked })} /></label>
      {status.error && status.enabled && <p className="browser-settings-error" role="alert">{status.error}</p>}
      {status.running && status.urls.length > 0 && <div className="remote-urls" aria-label="Direcciones del control remoto">
        {status.urls.map(url => <code key={url}>{url}</code>)}
      </div>}
    </div>

    <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Red</h4><p>Dónde escucha. Fuera de casa usa tu túnel de WireGuard o Tailscale.</p></div>
        <button type="button" className="btn btn-small" onClick={() => void refresh()}>Volver a buscar</button></div>
      <div className="remote-networks" role="radiogroup" aria-labelledby={`${id}-net`}>
        <span id={`${id}-net`} className="sr-only">Red del control remoto</span>
        {status.interfaces.map(item => <label key={`${item.name}-${item.ip}`} className={`remote-network${item.ip === status.address ? " is-selected" : ""}`}>
          <input type="radio" name={`${id}-network`} checked={item.ip === status.address} disabled={busy}
            onChange={() => void apply({ address: item.ip })} />
          <span className="remote-network-name">{item.name}</span>
          <code>{item.ip}</code>
          <span className={`remote-kind is-${item.kind}`}>{REMOTE_KIND_LABEL[item.kind]}</span>
        </label>)}
        {missing && <label className="remote-network is-selected is-missing"><input type="radio" checked readOnly />
          <span className="remote-network-name">No conectada ahora</span><code>{status.address}</code><span className="remote-kind">Se reintentará</span></label>}
        {!status.interfaces.length && !missing && <p className="settings-hint">No se encontró ninguna red. Conecta tu VPN y pulsa «Volver a buscar».</p>}
      </div>
      {selected?.kind === "lan" && <p className="browser-settings-note">En la red local el tráfico no va cifrado: úsala solo en casa. Para entrar desde fuera, elige la red de WireGuard o de Tailscale.</p>}
      {selected?.kind === "other" && <p className="browser-settings-note">Esta dirección podría ser accesible desde internet. Usa mejor WireGuard o Tailscale.</p>}
      <div className="remote-port">
        <label htmlFor={`${id}-port`}>Puerto</label>
        <input id={`${id}-port`} className="input" inputMode="numeric" value={port} aria-invalid={!validRemotePort(portValue)}
          onChange={event => setPort(event.currentTarget.value.replace(/\D/g, "").slice(0, 5))}
          onBlur={() => { if (validRemotePort(portValue) && portValue !== status.port) void apply({ port: portValue }); }} />
      </div>
    </div>

    <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Tailscale</h4><p>{status.tailscale.installed
        ? status.tailscale.running ? `Conectado${status.tailscale.dnsName ? ` como ${status.tailscale.dnsName}` : ""}` : "Instalado, pero no conectado"
        : "No está instalado en este PC"}</p></div>
        <span className={`browser-settings-status${tailscaleReady ? " is-ready" : ""}`}>{tailscaleReady ? "Disponible" : "No disponible"}</span></div>
      <label className="browser-settings-toggle"><span><strong>Publicar con HTTPS (tailscale serve)</strong>
        <small>Tu móvil abre https://{status.tailscale.dnsName ?? "tu-pc.ts.net"} con un certificado válido: así la app se puede instalar en la pantalla de inicio. Requiere HTTPS activado en tu tailnet.</small></span>
        <input type="checkbox" role="switch" aria-label="Publicar con HTTPS mediante tailscale serve" checked={status.tailscaleServe} disabled={busy || (!tailscaleReady && !status.tailscaleServe)}
          onChange={event => void apply({ tailscaleServe: event.currentTarget.checked })} /></label>
    </div>

    <div className="browser-settings-card">
      <div className="browser-settings-heading"><div><h4>Dispositivos</h4><p>{status.devices.length ? `${status.devices.length} emparejado${status.devices.length === 1 ? "" : "s"}` : "Todavía no hay ningún móvil emparejado"}</p></div>
        {!pairing && <button type="button" className="btn btn-small btn-primary" disabled={!status.running} onClick={() => void pair()}>Emparejar un móvil</button>}</div>
      {pairing && <div className="remote-pairing">
        {pairing.qr && <QrCode qr={pairing.qr} label="Código QR para emparejar el móvil" />}
        <div className="remote-pairing-info">
          <ol className="remote-steps">
            <li><span>01</span>En el móvil, escanea el código con la cámara.</li>
            <li><span>02</span>O abre <code>{status.urls[0] ?? "la dirección de arriba"}</code> y escribe el código.</li>
            <li><span>03</span>El móvil aparecerá aquí al terminar.</li>
          </ol>
          <div className="remote-code" aria-label={`Código ${pairing.code}`}>{pairing.code.slice(0, 3)}<i>–</i>{pairing.code.slice(3)}</div>
          <div className="remote-pairing-foot"><span>Caduca en {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => { setPairing(null); void remotePairingCancel(); }}>Cancelar</button></div>
        </div>
      </div>}
      {status.devices.length > 0 && <ul className="remote-devices">
        {status.devices.map(device => <li key={device.id}>
          <span className="remote-device-name">{device.name}</span>
          <small>{device.connected ? <b>conectado ahora</b> : `visto ${timeAgo(device.lastSeen, now) === "ahora" ? "ahora" : `hace ${timeAgo(device.lastSeen, now)}`}`}</small>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => void revoke(device.id)}>Desvincular</button>
        </li>)}
      </ul>}
      {!status.running && status.enabled && <p className="settings-hint">Cuando el servidor esté escuchando podrás emparejar un móvil.</p>}
    </div>
    {error && <p className="browser-settings-error" role="alert">{error}</p>}
  </div>;
}
