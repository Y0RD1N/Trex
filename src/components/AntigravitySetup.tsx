import { useEffect, useState } from "react";
import { antigravityRuntime, formatError, installAntigravity, type AntigravityRuntime } from "../api";
import type { LauncherProfile } from "../types";

export default function AntigravitySetup({ profile, onBusyChange }: { profile: LauncherProfile; onBusyChange: (busy: boolean) => void }) {
  const [status, setStatus] = useState<AntigravityRuntime | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true; setStatus(null); setError("");
    void antigravityRuntime(profile.command, profile.configDir).then(value => { if (current) setStatus(value); }).catch(reason => { if (current) setError(formatError(reason)); });
    return () => { current = false; };
  }, [profile.command, profile.configDir]);
  const install = async (): Promise<void> => {
    if (busy) return; setBusy(true); onBusyChange(true); setError("");
    try { await installAntigravity(); setStatus(await antigravityRuntime(profile.command, profile.configDir)); }
    catch (reason) { setError(formatError(reason)); }
    finally { setBusy(false); onBusyChange(false); }
  };
  return <div className="trex-unavailable">
    <span className="trex-unavailable-badge">{busy ? "Descargando…" : status?.installed ? `Disponible${status.version ? ` · ${status.version}` : ""}` : status ? "Componente pendiente" : "Comprobando…"}</span>
    <p>Antigravity usa el servidor oficial de Google para el chat. Conecta tu cuenta al abrir una conversación. Tu instalación de <code>agy</code> sigue disponible desde una terminal normal.</p>
    {!status?.installed && <button type="button" className="btn btn-small" disabled={busy || !status} onClick={() => void install()}>{busy ? "Descargando y verificando…" : "Instalar componente oficial"}</button>}
    {error && <p className="settings-note error" role="alert">{error}</p>}
  </div>;
}
