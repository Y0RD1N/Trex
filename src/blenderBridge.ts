/**
 * Puente de Trex con Blender (Ajustes → Integraciones): qué hay detectado, si el add-on está
 * instalado y qué Blender abiertos responden. `trex-agent blender-bridge` hace el trabajo; aquí
 * solo se traduce su estado a lo que muestra la pantalla.
 */
export type BridgeAction = "status" | "install" | "uninstall" | "open";
export type BridgeSession = { pid: number; version: string | null; file: string | null; dirty: boolean; paused: boolean };
export type BlenderBridgeStatus = {
  blender: { found: boolean; version?: string | null; kind?: "binary" | "flatpak"; path?: string };
  addon: { installed: boolean; enabled: boolean; upToDate: boolean; path?: string | null; blender?: string } | null;
  sessions: BridgeSession[];
};
export type BridgeSummary = {
  tone: "loading" | "ready" | "idle" | "missing";
  label: string;
  lines: string[];
  /** Texto del botón de instalar, o null cuando no se puede (Blender no detectado). */
  installLabel: string | null;
  canUninstall: boolean;
  canOpen: boolean;
};

const baseName = (path: string): string => { const parts = path.split(/[\\/]/).filter(Boolean); return parts[parts.length - 1] ?? path; };

export function describeSession(session: BridgeSession): string {
  const parts = [`Blender ${session.version ?? ""}`.trim(), session.file ? baseName(session.file) : "sin guardar"];
  if (session.dirty) parts.push("con cambios sin guardar");
  if (session.paused) parts.push("en pausa");
  return parts.join(" · ");
}

export function describeBridge(status: BlenderBridgeStatus | null): BridgeSummary {
  if (!status) return { tone: "loading", label: "Comprobando…", lines: [], installLabel: null, canUninstall: false, canOpen: false };
  if (!status.blender.found) {
    return { tone: "missing", label: "Blender no detectado", lines: ["Instala Blender y vuelve a comprobar."], installLabel: null, canUninstall: false, canOpen: false };
  }
  const addon = status.addon;
  const active = !!addon?.installed && addon.enabled;
  const installLabel = !addon?.installed ? "Instalar el puente en mi Blender" : active && addon.upToDate ? "Reinstalar el puente" : "Actualizar el puente";
  const common = { installLabel, canUninstall: !!addon?.installed, canOpen: true };
  if (status.sessions.length) return { tone: "ready", label: "Conectado", lines: status.sessions.map(describeSession), ...common };
  const state = !addon?.installed ? "El puente no está instalado: Trex abre Blender con él cuando un agente lo necesita."
    : !active ? "El puente está instalado pero desactivado en Blender (Preferencias → Add-ons → Trex Bridge)."
      : !addon.upToDate ? "El puente instalado es de una versión anterior de Trex."
        : "El puente está instalado: se activa solo en cada Blender que abras.";
  const version = status.blender.version ? `Blender ${status.blender.version} detectado.` : "Blender detectado.";
  return { tone: "idle", label: "Listo para abrir", lines: [version, state], ...common };
}
