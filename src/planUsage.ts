import { formatClock, getTimeFormat, type TimeFormat } from "./timeFormat";
/**
 * Uso del plan de cada cuenta: cuánto queda de la sesión de 5 horas, de la
 * semana y del uso extra, según lo cuenta cada asistente.
 *
 * Claude Code lo da con la petición `get_usage` (y lo actualiza en cada
 * respuesta con `rate_limit_event`); Codex, con `account/rateLimits/read` y
 * `account/rateLimits/updated`. Aquí solo se traducen esos datos a un modelo
 * común; quien los pide es el chat o la ventana de uso.
 */
import { list, record, text, type Json } from "./chatState";

export type UsageSeverity = "normal" | "warning" | "critical";

/** Una ventana de uso: la sesión de 5 horas, la semana o un límite propio de un modelo. */
export type PlanWindow = {
  id: string;
  label: string;
  /** Parte usada, de 0 a 100. */
  percent: number;
  /** Cuándo vuelve a empezar, en milisegundos. */
  resetsAt: number | null;
  severity: UsageSeverity;
  /** La ventana que se muestra cuando solo cabe un número. */
  headline: boolean;
};

export type PlanUsage = {
  /** Nombre del plan («Pro», «Max»…), si se conoce. */
  plan: string | null;
  windows: PlanWindow[];
  /** Uso extra de pago (Claude) o créditos (Codex). */
  extra: { used: number | null; limit: number | null; currency: string } | null;
  /** Reinicios gratuitos del límite que tiene la cuenta (Codex). */
  resetCredits: number;
};

const PLAN_NAMES: Record<string, string> = {
  free: "Free", pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", plus: "Plus", prolite: "Pro Lite",
  business: "Business", edu: "Edu", go: "Go", education: "Edu",
};

const planName = (value: unknown): string | null => {
  const name = text(value).trim();
  if (!name) return null;
  return PLAN_NAMES[name.toLowerCase()] ?? name.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));
const severityOf = (percent: number): UsageSeverity => percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal";
const isoTime = (value: unknown): number | null => {
  const time = typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};
const epochTime = (value: unknown): number | null => typeof value === "number" && value > 0 ? value * 1000 : null;

/** Si ninguna ventana es la principal, lo es la más usada. */
function withHeadline(windows: PlanWindow[]): PlanWindow[] {
  if (!windows.length || windows.some(window => window.headline)) return windows;
  const top = windows.reduce((best, window) => window.percent > best.percent ? window : best);
  return windows.map(window => window === top ? { ...window, headline: true } : window);
}

// --- Claude Code --------------------------------------------------------------

const CLAUDE_KINDS: Record<string, string> = { session: "Sesión (5 h)", weekly_all: "Semana", five_hour: "Sesión (5 h)", seven_day: "Semana" };
/** Ventanas de `rate_limit_event` y la fila de `get_usage` que corresponde a cada una. */
const CLAUDE_EVENT_WINDOWS: Record<string, string> = { five_hour: "session", seven_day: "weekly_all" };

function claudeLabel(row: Json): string {
  const kind = text(row.kind);
  const scope = text(record(row.scope)?.label) || text(record(row.scope)?.name) || text(row.scope);
  if (CLAUDE_KINDS[kind]) return CLAUDE_KINDS[kind];
  const base = text(row.group) === "weekly" || kind.startsWith("weekly") ? "Semana" : text(row.group) === "session" ? "Sesión (5 h)"
    : kind.replace(/_/g, " ");
  return scope ? `${base} · ${scope}` : base;
}

/** Respuesta de `get_usage`; null si no trae nada que mostrar. */
export function parseClaudeUsage(raw: unknown): PlanUsage | null {
  const data = record(raw);
  if (!data) return null;
  const limits = record(data.rate_limits);
  const rows = list(limits?.limits).map(record).filter((row): row is Json => !!row && typeof row.percent === "number");
  let windows: PlanWindow[] = rows.map((row, index) => {
    const percent = clampPercent(row.percent as number);
    const severity = text(row.severity);
    return {
      id: [text(row.kind) || `row${index}`, text(record(row.scope)?.label) || text(row.scope)].filter(Boolean).join(":"),
      label: claudeLabel(row),
      percent,
      resetsAt: isoTime(row.resets_at),
      severity: severity === "warning" || severity === "critical" ? severity : severity === "normal" ? "normal" : severityOf(percent),
      headline: row.is_active === true,
    };
  });
  // Un servidor anterior a las filas: solo las ventanas sueltas.
  if (!rows.length && limits) {
    windows = (["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const).flatMap(key => {
      const window = record(limits[key]);
      if (!window || typeof window.utilization !== "number") return [];
      const percent = clampPercent(window.utilization);
      const scope = key === "seven_day_opus" ? "Opus" : key === "seven_day_sonnet" ? "Sonnet" : "";
      return [{ id: CLAUDE_EVENT_WINDOWS[key] ?? key, label: scope ? `Semana · ${scope}` : CLAUDE_KINDS[key], percent,
        resetsAt: isoTime(window.resets_at), severity: severityOf(percent), headline: false }];
    });
  }
  const extraData = record(limits?.extra_usage);
  const scale = 10 ** (typeof extraData?.decimal_places === "number" ? extraData.decimal_places : 2);
  const money = (value: unknown): number | null => typeof value === "number" ? value / scale : null;
  const extra = extraData?.is_enabled === true
    ? { used: money(extraData.used_credits), limit: money(extraData.monthly_limit), currency: text(extraData.currency) || "USD" } : null;
  const plan = planName(data.subscription_type);
  if (!windows.length && !extra && !plan) return null;
  return { plan, windows: withHeadline(windows), extra, resetCredits: 0 };
}

/** Ventanas que manda Claude Code al empezar cada petición (`rate_limit_event`). */
export function claudeRateLimitUsage(usage: PlanUsage | null, info: Json): PlanUsage | null {
  const unified = record(info.unifiedWindows);
  if (!unified) return usage;
  let windows = usage?.windows ?? [];
  for (const [key, raw] of Object.entries(unified)) {
    const window = record(raw);
    if (!window || typeof window.utilization !== "number") continue;
    const id = CLAUDE_EVENT_WINDOWS[key] ?? key;
    const percent = clampPercent(window.utilization * 100);
    const resetsAt = epochTime(window.resetsAt);
    const index = windows.findIndex(entry => entry.id === id);
    windows = index === -1
      ? [...windows, { id, label: CLAUDE_KINDS[key] ?? key.replace(/_/g, " "), percent, resetsAt, severity: severityOf(percent), headline: false }]
      : windows.map((entry, position) => position === index
        ? { ...entry, percent, resetsAt: resetsAt ?? entry.resetsAt, severity: percent === entry.percent ? entry.severity : severityOf(percent) } : entry);
  }
  return windows.length ? { ...(usage ?? { plan: null, extra: null, resetCredits: 0 }), windows: withHeadline(windows) } : usage;
}

// --- Codex --------------------------------------------------------------------

/** Nombre de una ventana de Codex por su duración. */
export function windowLabel(minutes: number | null): string {
  if (!minutes) return "Límite";
  if (minutes === 300) return "Sesión (5 h)";
  if (minutes >= 10_000 && minutes <= 10_100) return "Semana";
  if (minutes >= 43_000 && minutes <= 44_700) return "Mes";
  if (minutes === 1440) return "Día";
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} días`;
}

function codexWindows(snapshot: Json, limitId: string, primaryBucket: boolean): PlanWindow[] {
  const prefix = primaryBucket ? "" : text(snapshot.limitName) || limitId;
  return (["primary", "secondary"] as const).flatMap(slot => {
    const window = record(snapshot[slot]);
    if (!window || typeof window.usedPercent !== "number") return [];
    const minutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
    const percent = clampPercent(window.usedPercent);
    const label = windowLabel(minutes);
    return [{ id: `${limitId}:${slot}`, label: prefix ? `${prefix} · ${label}` : label, percent,
      resetsAt: epochTime(window.resetsAt), severity: snapshot.rateLimitReachedType ? "critical" as const : severityOf(percent), headline: false }];
  });
}

/**
 * Respuesta de `account/rateLimits/read` o aviso `account/rateLimits/updated`
 * (que solo trae lo que cambió: se mezcla con lo anterior).
 */
export function parseCodexUsage(raw: unknown, previous: PlanUsage | null = null): PlanUsage | null {
  const data = record(raw);
  if (!data) return previous;
  const main = record(data.rateLimits);
  const buckets: [string, Json][] = Object.entries(record(data.rateLimitsByLimitId) ?? {})
    .flatMap(([id, value]) => record(value) ? [[id, record(value)!] as [string, Json]] : []);
  if (!buckets.length && main) buckets.push([text(main.limitId) || "codex", main]);
  const mainId = text(main?.limitId) || "codex";
  let windows = previous?.windows ?? [];
  for (const [id, snapshot] of buckets) {
    const fresh = codexWindows(snapshot, id, id === mainId);
    if (!fresh.length) continue;
    // Las ventanas de este límite se sustituyen; las de otros se conservan.
    windows = [...windows.filter(window => !window.id.startsWith(`${id}:`)), ...fresh];
  }
  windows = withHeadline(windows.map(window => ({ ...window, headline: false })));
  const credits = record(main?.credits);
  const balance = Number(text(credits?.balance));
  const extra = credits?.hasCredits === true && Number.isFinite(balance)
    ? { used: null, limit: balance, currency: "créditos" } : previous?.extra ?? null;
  const resetCredits = record(data.rateLimitResetCredits);
  return {
    plan: planName(main?.planType) ?? previous?.plan ?? null,
    windows,
    extra,
    resetCredits: typeof resetCredits?.availableCount === "number" ? resetCredits.availableCount : previous?.resetCredits ?? 0,
  };
}

// --- Presentación -------------------------------------------------------------

export const headlineWindow = (usage: PlanUsage | null): PlanWindow | null =>
  usage?.windows.find(window => window.headline) ?? usage?.windows[0] ?? null;

/** Ventanas generales: los límites propios de un modelo no sustituyen al de la cuenta. */
export function accountUsageWindows(usage: PlanUsage | null): { session: PlanWindow | null; weekly: PlanWindow | null } {
  const windows = usage?.windows ?? [];
  const byId = (...ids: string[]): PlanWindow | undefined => ids.map(id => windows.find(window => window.id === id)).find(Boolean);
  const codexWindow = (label: string): PlanWindow | undefined => windows.find(window =>
    (window.id === "codex:primary" || window.id === "codex:secondary") && window.label === label);
  return {
    session: byId("session", "five_hour") ?? codexWindow("Sesión (5 h)") ?? null,
    weekly: byId("weekly_all", "seven_day") ?? codexWindow("Semana") ?? null,
  };
}

/** Cuándo se reinicia una ventana, en palabras: «en 3 h 20 min», «el jueves a las 18:59». */
export function resetLabel(resetsAt: number | null, now: number, timeFormat: TimeFormat = getTimeFormat()): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.round((resetsAt - now) / 60_000);
  if (minutes <= 0) return "se reinicia ahora";
  if (minutes < 60) return `se reinicia en ${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return `se reinicia en ${hours} h${rest ? ` ${rest} min` : ""}`;
  }
  const date = new Date(resetsAt);
  const day = date.toLocaleDateString("es", { weekday: "long" });
  const time = formatClock(date, timeFormat);
  return minutes < 7 * 24 * 60 ? `se reinicia el ${day} a las ${time}`
    : `se reinicia el ${date.toLocaleDateString("es", { day: "numeric", month: "short" })} a las ${time}`;
}

export function moneyLabel(value: number, currency: string): string {
  if (currency === "créditos") return `${value.toLocaleString("es", { maximumFractionDigits: 2 })} créditos`;
  try {
    return value.toLocaleString("es", { style: "currency", currency });
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Línea del uso extra: lo gastado y el tope del mes, o los créditos que quedan. */
export function extraLabel(extra: PlanUsage["extra"]): string | null {
  if (!extra) return null;
  if (extra.currency === "créditos") return extra.limit !== null ? `Créditos disponibles: ${moneyLabel(extra.limit, extra.currency)}` : null;
  if (extra.used !== null && extra.limit !== null) return `Uso extra: ${moneyLabel(extra.used, extra.currency)} de ${moneyLabel(extra.limit, extra.currency)}`;
  return extra.used !== null ? `Uso extra: ${moneyLabel(extra.used, extra.currency)}` : "Uso extra activado";
}
