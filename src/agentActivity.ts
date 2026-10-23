import type { AgentActivity, TabKind, TabState } from "./types";

// Se inspecciona el pie actual de la TUI, no el historial ni cada paquete PTY.
export const ACTIVITY_SAMPLE_MS = 100;
export const ACTIVITY_SETTLE_MS = 220;
export const ACTIVITY_FOOTER_ROWS = 18;

const approval = /(?:do you want to proceed\?|would you like to (?:run|apply|allow)\b|waiting for (?:your (?:response|input)|approval)|allow .+\?|¿(?:quieres|deseas) (?:continuar|permitir)|esperando (?:tu respuesta|aprobación))/i;
const interrupt = /(?:\(|\b)(?:esc|escape)\s+(?:to\s+)?(?:interrupt|cancel|stop)\b/i;
const claudeSpinner = /^[✢✳✶✻✽✺⠁-⣿]\s+[^\r\n]{1,100}(?:…|\.{3})/u;
const codexSpinner = /^[•●⠁-⣿]\s+(?:working|thinking|running|searching|generating|planning|reading|editing|compacting)\b/i;

/** Solo los indicadores de estado, no la salida arbitraria, activan el icono. */
export function screenActivity(kind: TabKind, lines: readonly string[]): AgentActivity {
  if (kind === "shell") return "idle";
  const footer = lines.slice(-ACTIVITY_FOOTER_ROWS).map(line => line.trim());
  let latest: AgentActivity = "idle";
  for (const line of footer) {
    // Escribir una pregunta o un comando en el compositor no es una señal.
    if (/^[›❯>]\s/.test(line)) continue;
    if (approval.test(line)) latest = "waiting";
    else if (interrupt.test(line) || (kind === "claude" ? claudeSpinner : codexSpinner).test(line)) latest = "working";
  }
  return latest;
}

/** OSC 9;4 (progreso), notificaciones y marcas de prompt, ya decodificados por xterm. */
export function activitySignal(osc: number, data: string): AgentActivity | undefined {
  if (osc === 9 && data.startsWith("4;")) {
    const state = data.split(";")[1];
    if (state === "1" || state === "3") return "working";
    if (state === "2" || state === "4") return "waiting";
    if (state === "0") return "idle";
    return undefined;
  }
  if (osc === 133 && /^(?:A|B|D)(?:;|$)/.test(data)) return "idle";
  if ((osc === 9 && data.trim()) || (osc === 777 && data.startsWith("notify;"))) {
    return approval.test(data) ? "waiting" : "idle";
  }
  return undefined;
}

export const activityLabel = (activity: AgentActivity): string =>
  activity === "working" ? "Trabajando" : activity === "waiting" ? "Esperando tu respuesta" : "En espera";

/** Incluye sesiones contraídas y de fondo; un proceso abierto no implica trabajo. */
export function projectActivity(sessions: readonly Pick<TabState, "kind" | "activity" | "exited">[]): AgentActivity {
  let activity: AgentActivity = "idle";
  for (const session of sessions) {
    if (session.kind === "shell" || session.exited) continue;
    if (session.activity === "working") return "working";
    if (session.activity === "waiting") activity = "waiting";
  }
  return activity;
}
