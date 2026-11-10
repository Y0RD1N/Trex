/**
 * Uso de las cuentas, en órbitas: un anillo por cuenta con límites (lleno
 * según su ventana más cargada) y, debajo, una tarjeta por cuenta con cada
 * ventana, su reinicio y el ritmo de gasto frente al reloj.
 *
 * Se ve al instante con el último dato guardado y se actualiza solo; lo
 * comparten la pestaña «Uso» del chat y la ventana de uso.
 */
import { useEffect, type CSSProperties, type Ref } from "react";
import {
  accountPeaks, refreshAccounts, usageReading, type AccountPeak, type UsageReading,
} from "../accountUsageStore";
import { useClock, useUsageVersion } from "../hooks/useAccountUsage";
import { useTimeFormat } from "../hooks/useTimeFormat";
import {
  currentPercent, extraLabel, PACE_LABELS, windowPace, type PlanUsage, type PlanWindow,
} from "../planUsage";
import { PROVIDER_NAMES } from "../profiles";
import { formatClock, type TimeFormat } from "../timeFormat";
import type { AgentProvider, LauncherProfile } from "../types";
import AgentIcon from "./AgentIcon";
import { AlertIcon, BoltIcon, RefreshIcon } from "./Icons";
import "./AccountUsage.css";

/** Un dato más viejo que esto se marca como antiguo. */
const STALE_MS = 15 * 60_000;
/** Al abrir, lo que tenga más de esto se relee. */
const OPEN_MAX_AGE_MS = 2 * 60_000;
const MAX_ORBITS = 4;

/** Tono de cada cuenta: el de su asistente; la segunda del mismo, un paso más claro. */
const HUES: Record<AgentProvider, string[]> = {
  claude: ["var(--usage-claude)", "var(--usage-claude-2)"],
  codex: ["var(--usage-codex)", "var(--usage-codex-2)"],
  antigravity: ["var(--usage-agy)", "var(--usage-agy-2)"],
  trex: ["var(--accent)"],
};
function huesFor(profiles: LauncherProfile[]): Map<string, string> {
  const seen: Partial<Record<AgentProvider, number>> = {}, hues = new Map<string, string>();
  for (const profile of profiles) {
    const index = seen[profile.provider] ?? 0;
    seen[profile.provider] = index + 1;
    const options = HUES[profile.provider];
    hues.set(profile.id, options[index % options.length]);
  }
  return hues;
}
const hueStyle = (hue: string | undefined): CSSProperties => ({ ["--hue" as string]: hue ?? "var(--text-muted)" });

const hasLimits = (usage: PlanUsage | null): boolean =>
  !!usage && (usage.windows.length > 0 || extraLabel(usage.extra) !== null || usage.resetCredits > 0);

export function agoLabel(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "ahora mismo";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} ${days === 1 ? "día" : "días"}`;
}

/** «en 4 h 44 min», «vie 17:59»: cabe en una línea del panel. */
function resetShort(resetsAt: number | null, now: number, timeFormat: TimeFormat): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.round((resetsAt - now) / 60_000);
  if (minutes <= 0) return "ya se reinició";
  if (minutes < 60) return `reinicia en ${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return `reinicia en ${hours} h${rest ? ` ${rest} min` : ""}`;
  }
  const date = new Date(resetsAt);
  const day = minutes < 7 * 24 * 60 ? date.toLocaleDateString("es", { weekday: "short" }).replace(/\.$/, "")
    : date.toLocaleDateString("es", { day: "numeric", month: "short" });
  return `reinicia ${day} ${formatClock(date, timeFormat)}`;
}

/** Nombre corto de una ventana para la leyenda. */
const shortWindow = (window: PlanWindow): string => window.label.replace(/\s*\(5 h\)/, " 5 h").toLowerCase();

// --- Mini órbita (pestaña) ----------------------------------------------------

/** Icono de la pestaña: hasta tres anillos, uno por cuenta. */
export function UsageOrbitGlyph({ peaks, hues, size = 18, busy = false, alert = false }: {
  peaks: AccountPeak[]; hues: Map<string, string>; size?: number; busy?: boolean; alert?: boolean;
}) {
  const rings = peaks.slice(0, 3);
  const radii = [8.2, 5.3, 2.4];
  return <svg className={`usage-glyph${busy ? " is-busy" : ""}`} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
    {rings.length === 0 && <circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" strokeOpacity=".45" strokeWidth="1.6" />}
    {rings.map((peak, index) => {
      const color = alert && index === 0 ? "var(--warn)" : hues.get(peak.profile.id) ?? "currentColor";
      return <g key={peak.profile.id} style={{ color }}>
        <circle cx="10" cy="10" r={radii[index]} fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="1.8" />
        {peak.percent > 0 && <circle cx="10" cy="10" r={radii[index]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
          pathLength={100} strokeDasharray={`${Math.max(peak.percent, 4)} 100`} transform="rotate(-90 10 10)" />}
      </g>;
    })}
    {busy && <circle className="usage-glyph-spin" cx="10" cy="10" r="9.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
      pathLength={100} strokeDasharray="14 100" />}
  </svg>;
}

/** Pestaña «Uso» de la barra derecha: la órbita y la cuenta más cargada. */
export function UsageToggle({ profiles, expanded, controls, onClick, ref }: {
  profiles: LauncherProfile[]; expanded: boolean; controls?: string; onClick: () => void; ref?: Ref<HTMLButtonElement>;
}) {
  useUsageVersion();
  const now = useClock(60_000);
  const peaks = accountPeaks(profiles, now), hues = huesFor(profiles);
  const ordered = [...peaks].sort((a, b) => b.percent - a.percent);
  const top = ordered[0] ?? null;
  const alert = top && top.percent >= 75 ? top : null;
  const busy = profiles.some(profile => usageReading(profile).loading);
  const label = alert ? `Uso: ${alert.profile.name} al ${alert.percent} %`
    : top ? `Uso de las cuentas: lo más alto, ${top.profile.name} al ${top.percent} %` : "Uso de las cuentas";
  return <button ref={ref} type="button" className={`chat-usage-toggle tip-below${alert ? " is-alert" : ""}`} aria-label={label} data-tip={label}
    aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
    <UsageOrbitGlyph peaks={alert ? [alert, ...peaks.filter(peak => peak !== alert)] : peaks} hues={hues} busy={busy} alert={!!alert} />
    <span className="chat-side-label">Uso</span>
    {alert ? <small className="chat-usage-peak"><AlertIcon size={12} />{alert.profile.name} {alert.percent} %</small>
      : top && <small className="chat-usage-peak">{top.percent} %</small>}
  </button>;
}

// --- Panel ----------------------------------------------------------------------

function OrbitHero({ peaks, hues, readings, now, loading }: {
  peaks: AccountPeak[]; hues: Map<string, string>; readings: Map<string, UsageReading>; now: number; loading: boolean;
}) {
  const shown = peaks.slice(0, MAX_ORBITS);
  const top = peaks.reduce<AccountPeak | null>((best, peak) => !best || peak.percent > best.percent ? peak : best, null);
  const size = 168, center = size / 2, stroke = 9, step = 13, outer = 74;
  const description = peaks.map(peak => `${peak.profile.name} ${peak.percent} %`).join(", ");
  return <section className="usage-hero" aria-label="Resumen del uso de las cuentas">
    <span className="usage-hero-stars" aria-hidden="true" />
    <header className="usage-hero-kicker"><span>Tus órbitas</span><span>{peaks.length} con límite</span></header>
    <svg className="usage-hero-orbits" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
      aria-label={description || "Sin datos de uso todavía"}>
      {shown.map((peak, index) => {
        const radius = outer - index * step, hue = hues.get(peak.profile.id);
        const stale = readingStale(readings.get(peak.profile.id), now);
        const color = peak.window.severity === "critical" || peak.percent >= 90 ? "var(--danger)" : peak.percent >= 75 ? "var(--warn)" : "var(--hue)";
        return <g key={peak.profile.id} style={hueStyle(hue)} className={stale ? "is-stale" : undefined}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--hue)" strokeOpacity=".16" strokeWidth={stroke} />
          {peak.percent > 0 && <>
            <circle className="usage-hero-arc" cx={center} cy={center} r={radius} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
              pathLength={100} strokeDasharray={`${Math.max(peak.percent, 1.5)} 100`} transform={`rotate(-90 ${center} ${center})`} />
            <circle className="usage-hero-moon" cx={center} cy={center} r={radius} fill="none" strokeWidth={3.2} strokeLinecap="round"
              pathLength={100} strokeDasharray="0.01 99.99" strokeDashoffset={-(Math.max(peak.percent, 1.5) - 0.01)} transform={`rotate(-90 ${center} ${center})`} />
          </>}
        </g>;
      })}
      {shown.length === 0 && <circle cx={center} cy={center} r={outer} fill="none" stroke="var(--border)" strokeWidth={stroke} strokeDasharray="2 6" />}
      <text x={center} y={center + 2} textAnchor="middle" className="usage-hero-value">{top ? `${top.percent} %` : "—"}</text>
      <text x={center} y={center + 21} textAnchor="middle" className="usage-hero-caption">
        {top ? "lo más alto" : loading ? "leyendo…" : "sin datos aún"}</text>
    </svg>
    {peaks.length > 0 && <ul className="usage-hero-legend">
      {peaks.map(peak => {
        const reading = readings.get(peak.profile.id);
        const stale = readingStale(reading, now);
        return <li key={peak.profile.id} style={hueStyle(hues.get(peak.profile.id))}>
          <span className="usage-dot" aria-hidden="true" />
          <span className="usage-hero-name">{peak.profile.name}</span>
          <em>{stale && reading?.at ? agoLabel(reading.at, now) : shortWindow(peak.window)}</em>
          <b className={stale ? "is-stale" : undefined}>{peak.percent} %</b>
        </li>;
      })}
    </ul>}
  </section>;
}

const readingStale = (reading: UsageReading | undefined, now: number): boolean =>
  !!reading && (reading.loading || reading.at !== null && now - reading.at > STALE_MS);

function WindowRow({ window, now, timeFormat }: { window: PlanWindow; now: number; timeFormat: TimeFormat }) {
  const percent = currentPercent(window, now);
  const pace = percent === window.percent ? windowPace(window, now) : null;
  const severity = percent >= 90 || window.severity === "critical" && percent === window.percent ? "critical" : percent >= 75 ? "warning" : "normal";
  const reset = resetShort(window.resetsAt, now, timeFormat);
  return <li className={`usage-window is-${severity}`}>
    <div className="usage-window-head">
      <span>{window.label}</span>
      <b>{severity !== "normal" && <AlertIcon size={12} />}{percent} %</b>
    </div>
    <div className="usage-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      aria-label={`${window.label}: ${percent} % usado${pace ? `; ha pasado el ${pace.elapsed} % de la ventana` : ""}`}>
      {percent > 0 && <i style={{ width: `${Math.max(percent, 2)}%` }} />}
      {pace && <u style={{ left: `${pace.elapsed}%` }} title={`Ha pasado el ${pace.elapsed} % de esta ventana`} />}
    </div>
    {(reset || pace?.tone) && <small>
      <span>{reset}</span>
      {pace?.tone && <span className={`usage-pace is-${pace.tone}`}>{PACE_LABELS[pace.tone]}</span>}
    </small>}
  </li>;
}

function AccountCard({ profile, reading, hue, now, timeFormat }: {
  profile: LauncherProfile; reading: UsageReading; hue: string | undefined; now: number; timeFormat: TimeFormat;
}) {
  const usage = reading.usage, stale = readingStale(reading, now);
  const extra = extraLabel(usage?.extra ?? null);
  const meta = reading.loading ? (reading.at ? `${agoLabel(reading.at, now)} · actualizando…` : "leyendo el uso…")
    : reading.error && reading.at ? `${agoLabel(reading.at, now)} · no se pudo actualizar`
    : stale && reading.at ? agoLabel(reading.at, now) : null;
  const headingId = `usage-card-${profile.id}`;
  return <section className={`usage-card${stale ? " is-stale" : ""}${reading.loading ? " is-loading" : ""}`} style={hueStyle(hue)}
    aria-labelledby={headingId} aria-busy={reading.loading}>
    <header className="usage-card-head">
      <span className="usage-card-icon"><AgentIcon kind={profile.provider} size={15} /></span>
      <div className="usage-card-identity">
        <h3 id={headingId}>{profile.name}</h3>
        <div className="usage-card-meta" title={reading.error ?? undefined}>
          {meta ?? <code>{profile.command || PROVIDER_NAMES[profile.provider]}</code>}
        </div>
      </div>
      {reading.loading ? <span className="usage-card-spin" aria-hidden="true"><RefreshIcon size={13} /></span> : usage?.plan && <span className="usage-card-plan">{usage.plan}</span>}
    </header>
    {usage && usage.windows.length > 0 && <ul className="usage-windows">
      {usage.windows.map(window => <WindowRow key={window.id} window={window} now={now} timeFormat={timeFormat} />)}
    </ul>}
    {!usage && reading.error && <p className="usage-card-error" role="status">No se pudo leer el uso: {reading.error}</p>}
    {!usage && !reading.error && reading.loading && <div className="usage-card-skeleton" aria-hidden="true"><i /><i /></div>}
    {(extra || (usage?.resetCredits ?? 0) > 0) && <div className="usage-chips">
      {extra && <span className="usage-chip">{extra}</span>}
      {usage && usage.resetCredits > 0 && <span className="usage-chip"><BoltIcon size={11} />
        {usage.resetCredits} {usage.resetCredits === 1 ? "reinicio gratis" : "reinicios gratis"}</span>}
    </div>}
  </section>;
}

const QUIET_NOTES: Record<AgentProvider, { short: string; long: string }> = {
  trex: { short: "uso en cada chat", long: "Los tokens y el coste se ven en «Uso y contexto» de cada chat; el saldo de la API se consulta en tu proveedor." },
  antigravity: { short: "sin cuotas", long: "Antigravity no informó cuotas disponibles para esta cuenta." },
  claude: { short: "sin límites", long: "Esta cuenta no tiene límites de plan (por ejemplo, usa una clave de API)." },
  codex: { short: "sin límites", long: "Esta cuenta no tiene límites de plan (por ejemplo, usa una clave de API)." },
};

function QuietAccounts({ profiles, hues }: { profiles: LauncherProfile[]; hues: Map<string, string> }) {
  if (!profiles.length) return null;
  return <section className="usage-quiet" aria-label="Cuentas sin límites de plan">
    <h4>Sin límites de plan</h4>
    <ul>{profiles.map(profile => <li key={profile.id} style={hueStyle(hues.get(profile.id))} title={QUIET_NOTES[profile.provider].long}>
      <span className="usage-card-icon"><AgentIcon kind={profile.provider} size={12} /></span>
      <span className="usage-quiet-name">{profile.name}{profile.command && <code>{profile.command}</code>}</span>
      <span className="usage-quiet-note">{QUIET_NOTES[profile.provider].short}</span>
    </li>)}</ul>
  </section>;
}

/** Contenido completo: órbitas, frescura, tarjetas y cuentas sin límites. */
export function AccountUsagePanel({ profiles, id }: { profiles: LauncherProfile[]; id?: string }) {
  useUsageVersion();
  const now = useClock();
  const timeFormat = useTimeFormat();

  // Al abrir se relee lo que tenga unos minutos; lo reciente ya está a la vista.
  useEffect(() => {
    void refreshAccounts(profiles, { maxAge: OPEN_MAX_AGE_MS });
    // Solo al abrir; después, con «Actualizar».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readings = new Map(profiles.map(profile => [profile.id, usageReading(profile)]));
  const hues = huesFor(profiles);
  const peaks = accountPeaks(profiles, now);
  const limited = profiles.filter(profile => {
    const reading = readings.get(profile.id)!;
    return profile.provider !== "trex" && (hasLimits(reading.usage) || reading.at === null || reading.error !== null && !reading.usage);
  });
  const quiet = profiles.filter(profile => !limited.includes(profile));
  const loading = profiles.some(profile => readings.get(profile.id)!.loading);
  const newest = Math.max(0, ...profiles.map(profile => readings.get(profile.id)!.at ?? 0));
  const live = newest > 0 && now - newest < OPEN_MAX_AGE_MS;

  return <div id={id} className="usage-panel">
    {profiles.length === 0 ? <div className="usage-none">
      <h3>No hay cuentas configuradas</h3>
      <p>Añade un perfil en Ajustes para ver su uso.</p>
    </div> : <>
      <OrbitHero peaks={peaks} hues={hues} readings={readings} now={now} loading={loading} />
      <div className="usage-fresh" role="status">
        <span className={`usage-fresh-dot${live ? " is-live" : ""}`} aria-hidden="true" />
        <span>{loading ? "Actualizando…" : newest ? `Al día · ${agoLabel(newest, now)}` : "Sin leer todavía"}</span>
        <button type="button" className="usage-refresh" aria-disabled={loading} onClick={() => { if (!loading) void refreshAccounts(profiles); }}>
          <RefreshIcon size={12} />Actualizar</button>
      </div>
      {limited.map(profile => <AccountCard key={profile.id} profile={profile} reading={readings.get(profile.id)!} hue={hues.get(profile.id)}
        now={now} timeFormat={timeFormat} />)}
      <QuietAccounts profiles={quiet} hues={hues} />
      <p className="usage-legend"><u aria-hidden="true" />Marca: cuánto ha pasado de cada ventana. Leer el uso no gasta tokens.</p>
    </>}
  </div>;
}
