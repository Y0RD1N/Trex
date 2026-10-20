/**
 * Uso del plan de todas las cuentas: una tarjeta por perfil con la sesión de
 * 5 horas, la semana y el uso extra, para ver de un vistazo cuánto queda en
 * cada una antes de elegir con cuál trabajar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readAccountUsage } from "../accountUsage";
import { formatError } from "../api";
import type { PlanUsage } from "../planUsage";
import type { LauncherProfile, Settings } from "../types";
import AgentIcon from "./AgentIcon";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import { PlanWindows } from "./chat/PlanMeter";
import { RefreshIcon } from "./Icons";

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
      <button className="btn btn-ghost" disabled={pending > 0} onClick={refresh}>
        {pending > 0 ? <span className="chat-spinner" aria-hidden="true" /> : <RefreshIcon size={14} />} {pending > 0 ? "Leyendo…" : "Actualizar"}
      </button>
    </>}>
    <div className="usage-accounts">
      {profiles.map(profile => {
        const reading = readings[profile.id] ?? { status: "loading" };
        const usage = reading.status === "ready" ? reading.usage : null;
        return <section key={profile.id} className="usage-account" aria-busy={reading.status === "loading"}>
          <header className="usage-account-head">
            <AgentIcon kind={profile.provider} size={18} />
            <strong>{profile.name}</strong>
            {usage?.plan && <span className="usage-plan">{usage.plan}</span>}
            <span className="usage-command">{profile.command}</span>
          </header>
          {reading.status === "error" ? <p className="usage-empty error">No se pudo leer el uso: {reading.message}</p>
            : usage && usage.windows.length ? <PlanWindows usage={usage} now={now} />
            : reading.status === "loading" ? <p className="usage-empty" role="status"><span className="chat-spinner" /> Leyendo el uso…</p>
            : <p className="usage-empty">Esta cuenta no tiene límites de plan (por ejemplo, usa una clave de API).</p>}
        </section>;
      })}
    </div>
  </FeatureDialog>;
}
