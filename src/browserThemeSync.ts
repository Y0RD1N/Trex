/**
 * Mantiene el tema de Trex Browser igual al de la app. Cada vez que la interfaz aplica su tema (cambio de tono,
 * acento o modo, también el del sistema) se envía el resultado al navegador, que lo sigue en vivo. Es opcional:
 * sin Trex Browser instalado, o con una versión que aún no conoce el comando, el navegador conserva su tema
 * y aquí no pasa nada.
 */
import { isTauri } from "@tauri-apps/api/core";
import { trexBrowserTheme } from "./api";
import { buildBrowserTheme } from "./browserTheme";
import { getThemeMode, onThemeChange } from "./theme";

/** Espera tras el último cambio: arrastrar el selector de tono aplica el tema muchas veces por segundo. */
const SETTLE_MS = 900;
/** La primera sincronización, ya con la app en marcha, para que el arranque no la espere. */
const STARTUP_MS = 4000;

let started = false;
let timer: number | undefined;
let sent = "";

const push = async (): Promise<void> => {
  const style = getComputedStyle(document.documentElement);
  const theme = buildBrowserTheme(getThemeMode(), token => style.getPropertyValue(token));
  if (!theme) return;
  const json = JSON.stringify(theme);
  if (json === sent) return;
  try {
    await trexBrowserTheme(theme);
    sent = json;
  } catch {
    /* Trex Browser no está instalado o es anterior a este comando: conserva su propio tema. */
  }
};

const schedule = (delay: number): void => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { void push(); }, delay);
};

/** Idempotente: se llama una vez con el tema de la app ya aplicado. */
export const syncBrowserTheme = (): void => {
  if (started || !isTauri()) return;
  started = true;
  onThemeChange(() => schedule(SETTLE_MS));
  schedule(STARTUP_MS);
};
