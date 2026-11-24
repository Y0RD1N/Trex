/**
 * Bandeja del sistema (solo Windows): con «Al cerrar la ventana, seguir en la
 * bandeja», cerrar la ventana la oculta y trex sigue trabajando de fondo. El
 * icono y su menú viven en el backend (`src-tauri/src/tray.rs`); aquí solo se
 * le cuenta cuántos agentes trabajan y se ofrece salir de verdad.
 */
import { invoke } from "@tauri-apps/api/core";
import type { TabState } from "./types";

export type TrayActivity = { working: number; waiting: number };

/** Agentes trabajando y esperando respuesta; las terminales y los procesos terminados no cuentan. */
export function trayActivity(tabs: readonly Pick<TabState, "kind" | "activity" | "exited">[]): TrayActivity {
  let working = 0;
  let waiting = 0;
  for (const tab of tabs) {
    if (tab.kind === "shell" || tab.exited) continue;
    if (tab.activity === "working") working++;
    else if (tab.activity === "waiting") waiting++;
  }
  return { working, waiting };
}

/** Llama al backend sin romper nada fuera de Tauri (pruebas visuales en el navegador). */
function call(command: string, args?: Record<string, unknown>): void {
  try {
    void invoke(command, args).catch(() => undefined);
  } catch {
    /* sin runtime nativo */
  }
}

/** Pone al día el menú y el texto del icono. Sin runtime nativo no hace nada. */
export function reportTrayActivity(activity: TrayActivity): void {
  call("tray_activity", { working: activity.working, waiting: activity.waiting });
}

/** Termina trex del todo: cierra terminales y agentes como al cerrar sin bandeja. */
export function quitApp(): void {
  call("app_quit");
}
