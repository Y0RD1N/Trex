/**
 * Uso del plan de cada cuenta, compartido por toda la app: la pestaña «Uso»
 * del chat, la ventana de uso y el equipo leen de aquí.
 *
 * Leer el uso arranca el CLI de la cuenta un momento (segundos). Para que no
 * haya que esperar: el último dato se guarda y se ve al instante, los chats
 * abiertos lo actualizan con lo que ya reciben en cada respuesta y la app lo
 * relee en segundo plano. Una lectura en curso se comparte, nunca se repite.
 */
import { readAccountUsage } from "./accountUsage";
import { formatError } from "./api";
import { currentPercent, type PlanUsage, type PlanWindow } from "./planUsage";
import type { LauncherProfile, Settings } from "./types";

export type UsageReading = {
  /** Último dato bueno; puede venir de antes de abrir la app. */
  usage: PlanUsage | null;
  /** Cuándo se obtuvo `usage`; null si nunca se leyó. */
  at: number | null;
  /** Hay una lectura en curso. */
  loading: boolean;
  /** Fallo de la última lectura; el dato anterior sigue valiendo. */
  error: string | null;
};

type Entry = UsageReading & { /** Último intento terminado, bien o mal. */ checkedAt: number | null };
export type UsageReadContext = { settings: Settings; cwd: string };

const STORE = "trex.account-usage";
const KEEP_MS = 14 * 24 * 3_600_000;
const EMPTY: UsageReading = { usage: null, at: null, loading: false, error: null };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<PlanUsage | null>>();
const listeners = new Set<() => void>();
let version = 0;
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let context: UsageReadContext | null = null;

/** Las cuentas con el mismo CLI, argumentos y configuración son la misma cuenta. */
export function usageKey(profile: LauncherProfile): string {
  const source = [profile.provider, profile.command, profile.args, profile.configDir, profile.shell].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  return `${profile.provider}:${(hash >>> 0).toString(36)}`;
}

const storage = (): Storage | null => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};

const validUsage = (value: unknown): value is PlanUsage | null => value === null
  || typeof value === "object" && Array.isArray((value as PlanUsage).windows);

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(storage()?.getItem(STORE) ?? "{}") as Record<string, { usage?: unknown; at?: unknown }>;
    const oldest = Date.now() - KEEP_MS;
    for (const [key, value] of Object.entries(saved)) {
      if (typeof value?.at !== "number" || value.at < oldest || !validUsage(value.usage ?? null) || entries.has(key)) continue;
      entries.set(key, { usage: (value.usage ?? null) as PlanUsage | null, at: value.at, checkedAt: null, loading: false, error: null });
    }
  } catch { /* dato guardado dañado: se vuelve a leer */ }
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data: Record<string, { usage: PlanUsage | null; at: number }> = {};
    for (const [key, entry] of entries) if (entry.at !== null) data[key] = { usage: entry.usage, at: entry.at };
    try { storage()?.setItem(STORE, JSON.stringify(data)); } catch { /* sin almacenamiento: vale mientras la app siga abierta */ }
  }, 500);
}

function update(key: string, change: Partial<Entry>): void {
  const previous = entries.get(key) ?? { ...EMPTY, checkedAt: null };
  entries.set(key, { ...previous, ...change });
  version++;
  for (const listener of [...listeners]) listener();
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Cambia con cada lectura: sirve de instantánea para `useSyncExternalStore`. */
export const usageVersion = (): number => version;

export function usageReading(profile: LauncherProfile): UsageReading {
  load();
  const entry = entries.get(usageKey(profile));
  return entry ? { usage: entry.usage, at: entry.at, loading: entry.loading, error: entry.error } : EMPTY;
}

/** Ajustes y carpeta con los que se lanzan los CLI cuando nadie indica otros (la carpeta personal). */
export function setUsageContext(next: UsageReadContext): void { context = next; }
export const usageProfiles = (): LauncherProfile[] => context?.settings.profiles ?? [];

/**
 * Lee el uso de una cuenta. Con `maxAge`, un dato (o un intento fallido) más
 * reciente que eso se da por bueno y no se arranca nada.
 */
export function refreshAccount(profile: LauncherProfile, options: { maxAge?: number; read?: UsageReadContext } = {}): Promise<PlanUsage | null> {
  load();
  if (profile.provider === "trex") return Promise.resolve(null);
  const key = usageKey(profile), entry = entries.get(key);
  const running = inflight.get(key);
  if (running) return running;
  const checked = Math.max(entry?.checkedAt ?? 0, entry?.at ?? 0);
  if (options.maxAge && checked && Date.now() - checked < options.maxAge) return Promise.resolve(entry?.usage ?? null);
  const read = options.read ?? context;
  if (!read) return Promise.resolve(entry?.usage ?? null);
  update(key, { loading: true });
  const promise = readAccountUsage(profile, read.settings, read.cwd).then(usage => {
    const now = Date.now();
    update(key, { usage, at: now, checkedAt: now, loading: false, error: null });
    save();
    return usage;
  }, error => {
    update(key, { loading: false, checkedAt: Date.now(), error: formatError(error) });
    return entries.get(key)?.usage ?? null;
  }).finally(() => { inflight.delete(key); });
  inflight.set(key, promise);
  return promise;
}

/**
 * Lee varias cuentas, como mucho `concurrency` a la vez (arrancar varios CLI
 * juntos los hace más lentos a todos). En segundo plano no se toca
 * Antigravity: su lectura abre una sesión, así que solo se hace a la vista.
 */
export async function refreshAccounts(profiles: LauncherProfile[],
  options: { maxAge?: number; concurrency?: number; background?: boolean; read?: UsageReadContext } = {}): Promise<void> {
  const queue = profiles.filter(profile => profile.provider !== "trex" && !(options.background && profile.provider === "antigravity"));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) await refreshAccount(queue[next++], options);
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? queue.length, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
}

/** Lo nuevo manda; las ventanas que no trae (un límite por modelo, el plan) se conservan. */
export function mergeUsage(previous: PlanUsage | null, live: PlanUsage): PlanUsage {
  if (!previous) return live;
  const ids = new Set(live.windows.map(window => window.id));
  return {
    plan: live.plan ?? previous.plan,
    windows: [...live.windows, ...previous.windows.filter(window => !ids.has(window.id))],
    extra: live.extra ?? previous.extra,
    resetCredits: live.resetCredits || previous.resetCredits,
  };
}

/** Uso que acaba de recibir un chat abierto de esta cuenta: vale como lectura nueva. */
export function reportLiveUsage(profile: LauncherProfile, usage: PlanUsage | null): void {
  if (!usage || profile.provider === "trex") return;
  load();
  const key = usageKey(profile), now = Date.now();
  update(key, { usage: mergeUsage(entries.get(key)?.usage ?? null, usage), at: now, checkedAt: now, error: null });
  save();
}

export type AccountPeak = { profile: LauncherProfile; window: PlanWindow; percent: number };

/** La ventana más cargada de cada cuenta con límites, en el orden de los perfiles. */
export function accountPeaks(profiles: LauncherProfile[], now: number): AccountPeak[] {
  return profiles.flatMap(profile => {
    const windows = usageReading(profile).usage?.windows ?? [];
    if (!windows.length) return [];
    const window = windows.reduce((top, item) => currentPercent(item, now) > currentPercent(top, now) ? item : top);
    return [{ profile, window, percent: currentPercent(window, now) }];
  });
}

/** Pedir la pestaña «Uso»: la abre el chat a la vista (primero el que tiene el foco). */
type PanelOpener = (focusedOnly: boolean) => boolean;
const openers = new Set<PanelOpener>();
export function onUsagePanelRequest(opener: PanelOpener): () => void {
  openers.add(opener);
  return () => { openers.delete(opener); };
}
export function requestUsagePanel(): boolean {
  for (const focusedOnly of [true, false]) for (const opener of [...openers]) if (opener(focusedOnly)) return true;
  return false;
}
