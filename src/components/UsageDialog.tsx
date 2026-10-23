/**
 * Uso del plan de todas las cuentas: una tarjeta por perfil con la sesión de
 * 5 horas, la semana y el uso extra, para ver de un vistazo cuánto queda en
 * cada una antes de elegir con cuál trabajar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readAccountUsage } from "../accountUsage";
import { formatError } from "../api";
import { PROVIDER_NAMES } from "../profiles";
import { extraLabel, type PlanUsage } from "../planUsage";
import type { LauncherProfile, Settings } from "../types";
import AgentIcon from "./AgentIcon";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import { PlanWindows } from "./chat/PlanMeter";
import { RefreshIcon } from "./Icons";
import "./UsageDialog.css";

type Reading = { status: "loading" } | { status: "ready"; usage: PlanUsage | null; at: number } | { status: "error"; message: string };

/** Lecturas recientes: al volver a abrir la ventana se ven al momento mientras se actualizan. */
const recent = new Map<string, Reading>();
const profileKey = (profile: LauncherProfile): string =>
  [profile.provider, profile.command, profile.args, profile.configDir, profile.shell].join("\u0000");

export default function UsageDialog({ settings, cwd, onClose, ...motion }: {
  settings: Settings;
  /** Carpeta donde se lanzan los CLI un momento (la carpeta personal). */
  cwd: string;
  onClose: () => void;
} & FeatureDialogMotionProps) {
  const profiles = settings.profiles;
  const [readings, setReadings] = useState<Record<string, Reading>>(() =>
    Object.fromEntries(profiles.map(profile => [profile.id, recent.get(profileKey(profile)) ?? { status: "loading" }])));
  const [now, setNow] = useState(() => Date.now());
  /** Cuentas que se están leyendo: lo anterior sigue a la vista mientras tanto. */
  const [pending, setPending] = useState(0);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const request = ++generation.current;
    setNow(Date.now());
    setPending(profiles.length);
    for (const profile of profiles) {
      setReadings(previous => ({ ...previous, [profile.id]: previous[profile.id]?.status === "ready" ? previous[profile.id] : { status: "loading" } }));
      void readAccountUsage(profile, settings, cwd)
        .then(usage => ({ status: "ready", usage, at: Date.now() }) as Reading)
        .catch(error => ({ status: "error", message: formatError(error) }) as Reading)
        .then(reading => {
          if (reading.status === "ready") recent.set(profileKey(profile), reading);
          if (generation.current !== request) return;
          setReadings(previous => ({ ...previous, [profile.id]: reading }));
          setPending(count => Math.max(0, count - 1));
        });
    }
  }, [profiles, settings, cwd]);

  useEffect(() => {
    refresh();
    return () => { generation.current++; };
    // Solo al abrir; después, con «Actualizar».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Los «se reinicia en…» siguen al día mientras la ventana está abierta.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);


  return <FeatureDialog {...motion} title="Uso de las cuentas" onClose={onClose} className="usage-dialog"
    footer={<>
      <span className="feature-hint">Lo mismo que muestra /usage en cada asistente; no gasta tokens.</span>
      <button type="button" className="btn btn-ghost usage-refresh" disabled={pending > 0} onClick={refresh} aria-busy={pending > 0}>
        {pending > 0 ? <span className="chat-spinner" aria-hidden="true" /> : <RefreshIcon size={14} />} {pending > 0 ? "Leyendo…" : "Actualizar"}
      </button>
    </>}>
    <div className="usage-intro">
      <p>La sesión de 5 h, la semana y los límites de cada cuenta.</p>
      <span className="usage-count">{profiles.length} {profiles.length === 1 ? "perfil" : "perfiles"}</span>
    </div>
    <div className="usage-accounts">
      {profiles.length === 0 && <div className="usage-no-accounts">
        <h3>No hay cuentas configuradas</h3>
        <p>Añade un perfil en Ajustes para consultar su uso.</p>
      </div>}
      {profiles.map(profile => {
        const reading = readings[profile.id] ?? { status: "loading" };
        const usage = reading.status === "ready" ? reading.usage : null;
        const hasUsage = usage && (usage.windows.length > 0 || extraLabel(usage.extra) !== null || usage.resetCredits > 0);
        const headingId = `usage-account-${profile.id}`;
        return <section key={profile.id} className="usage-account" aria-labelledby={headingId} aria-busy={reading.status === "loading"}>
          <header className="usage-account-head">
            <span className="usage-account-icon"><AgentIcon kind={profile.provider} size={20} /></span>
            <div className="usage-account-identity">
              <h3 id={headingId}>{profile.name}</h3>
              <div className="usage-account-meta">
                <span>{PROVIDER_NAMES[profile.provider]}</span>
                <span aria-hidden="true">·</span>
                <code className="usage-command">{profile.command}</code>
              </div>
            </div>
            {usage?.plan && <span className="usage-plan">{usage.plan}</span>}
          </header>
          {reading.status === "error" ? <p className="usage-empty error" role="status">No se pudo leer el uso: {reading.message}</p>
            : hasUsage ? <PlanWindows usage={usage} now={now} />
            : reading.status === "loading" ? <p className="usage-empty" role="status"><span className="chat-spinner" aria-hidden="true" /> Leyendo el uso…</p>
            : <p className="usage-empty">{profile.provider === "trex" ? "Conexión por API. Los tokens y el coste disponible se muestran en cada conversación; consulta el saldo en tu proveedor." : "Esta cuenta no tiene límites de plan (por ejemplo, usa una clave de API)."}</p>}
        </section>;
      })}
    </div>
  </FeatureDialog>;
}
