import type { AgentProvider } from "./types";

export type AgentPermissionOption = { value: string; label: string; description: string };
/** These are native provider modes. A read-only team member also receives planningOnly. */
export function agentPermissionOptions(provider: AgentProvider): AgentPermissionOption[] {
  const read = { value: "plan", label: "Solo lectura", description: "Investiga sin modificar archivos ni conceder permisos de escritura." };
  if (provider === "claude") return [read,
    { value: "default", label: "Preguntar", description: "Solicita permiso para editar archivos y ejecutar comandos." },
    { value: "acceptEdits", label: "Aceptar ediciones", description: "Permite editar archivos; los comandos conservan sus aprobaciones." },
    { value: "bypassPermissions", label: "Acceso total", description: "Edita y ejecuta sin pedir permiso." }];
  if (provider === "codex") return [read,
    { value: "read-only", label: "Preguntar para modificar", description: "Empieza en un sandbox de lectura y solicita permisos adicionales." },
    { value: "auto", label: "Editar el proyecto", description: "Edita y ejecuta dentro del proyecto; pregunta para ampliar el acceso." },
    { value: "full", label: "Acceso total", description: "Sin sandbox ni aprobaciones para editar y ejecutar." }];
  if (provider === "trex") return [read,
    { value: "ask", label: "Preguntar", description: "Solicita permiso para modificar archivos y ejecutar acciones." },
    { value: "full", label: "Acceso total", description: "Edita y ejecuta sin pedir permiso." }];
  return [{ value: "", label: "Predeterminado de Antigravity", description: "Los modos disponibles se consultan al conectar. Puedes elegirlos desde el chat." }];
}
export function defaultAgentPermission(provider: AgentProvider, canWrite = true): string | null {
  if (!canWrite) return "plan";
  return provider === "claude" ? "default" : provider === "codex" ? "auto" : provider === "trex" ? "ask" : null;
}
export function validAgentPermission(provider: AgentProvider, mode: unknown): mode is string {
  if (typeof mode !== "string") return false;
  if (provider === "antigravity") return /^[a-zA-Z0-9_-]{1,128}$/.test(mode) && !/plan|architect|read.?only/i.test(mode);
  return agentPermissionOptions(provider).some(option => option.value === mode) || provider === "trex" && mode === "auto";
}
export function agentPermissionLabel(provider: AgentProvider, mode: string | null | undefined, canWrite = true): string {
  const selected = mode ?? defaultAgentPermission(provider, canWrite);
  return agentPermissionOptions(provider).find(option => option.value === selected)?.label
    ?? (provider === "trex" && selected === "auto" ? "Preguntar" : selected ?? "Permisos del asistente");
}
