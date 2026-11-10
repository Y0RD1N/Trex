import { useEffect, useState, useSyncExternalStore } from "react";
import { refreshAccounts, setUsageContext, subscribeUsage, usageProfiles, usageVersion } from "../accountUsageStore";
import type { Settings } from "../types";

/** Vuelve a pintar el componente con cada lectura de uso nueva. */
export function useUsageVersion(): number {
  return useSyncExternalStore(subscribeUsage, usageVersion);
}

/** La hora, al día cada `interval`: los «se reinicia en…» y «hace 3 min» no se quedan quietos. */
export function useClock(interval = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  return now;
}

/** Primera lectura poco después de arrancar; después, cada tanto si la ventana se ve. */
const FIRST_READ_MS = 8_000;
const BACKGROUND_EVERY_MS = 10 * 60_000;

/**
 * Mantiene el uso de las cuentas al día sin que nadie lo pida: así la pestaña
 * «Uso» siempre abre con datos. Lo que un chat abierto ya informó no se relee.
 */
export function useAccountUsageUpkeep(settings: Settings | null, cwd: string | null): void {
  useEffect(() => {
    if (settings && cwd) setUsageContext({ settings, cwd });
  }, [settings, cwd]);
  const ready = !!settings && !!cwd;
  useEffect(() => {
    if (!ready) return;
    const run = (): void => {
      if (document.visibilityState !== "visible") return;
      void refreshAccounts(usageProfiles(), { maxAge: BACKGROUND_EVERY_MS, concurrency: 2, background: true });
    };
    const first = window.setTimeout(run, FIRST_READ_MS);
    const timer = window.setInterval(run, BACKGROUND_EVERY_MS);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [ready]);
}
