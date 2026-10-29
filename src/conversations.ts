import { invoke } from "@tauri-apps/api/core";
import type { AgentProvider, Conversation, SessionLaunch } from "./types";
export const validConversationId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export const listConversations = (
  provider: AgentProvider,
  configDir: string,
  cwd: string,
  profileName?: string,
): Promise<Conversation[]> =>
  provider === "trex" ? invoke("trex_cli_conversations", { name: profileName ?? "TREX1", configDir, cwd }) : invoke("list_conversations", { provider, configDir, cwd });
/**
 * Carpeta de la cuenta que elige el propio lanzador (un script o alias que
 * exporta CLAUDE_CONFIG_DIR o CODEX_HOME); null si usa la de siempre.
 */
export const detectAccountDir = (provider: AgentProvider, command: string, shell: string): Promise<string | null> =>
  invoke("detect_account_dir", { provider, command, shell });
/** Carpeta donde guarda sus conversaciones el perfil: la indicada en él o la que elige su lanzador. */
export const profileAccountDir = async (profile: { provider: AgentProvider; command: string; shell: string; configDir: string }, shell: string): Promise<string> =>
  profile.configDir.trim() || (profile.provider === "trex" || profile.provider === "antigravity" ? "" : await detectAccountDir(profile.provider, profile.command, profile.shell || shell).catch(() => null) || "");
/** Mensajes guardados de una conversación de Claude Code, para pintarla en el chat. */
export const readConversation = (configDir: string, id: string): Promise<unknown[]> =>
  invoke("read_conversation", { configDir, id });
/** No añade argumentos a perfiles que ya eligen su conversación o ejecutan un modo distinto. */
export function canResume(
  launch: SessionLaunch,
  provider: AgentProvider,
): boolean {
  if (!launch.command) return false;
  const args = launch.args ?? "";
  if (provider === "antigravity") return !args.trim();
  return provider === "claude"
    ? !/(^|\s)(--resume(?:=|\s|$)|-r(?:\s|$)|--continue\b|-c\b|--session-id\b|--fork-session\b|--print\b|-p\b|--remote-control\b|--bg\b)/.test(
        args,
      )
    : !/(^|\s)(resume|fork|exec|app-server|--remote|--worktree|--cd|-C)(\s|=|$)/.test(
        args,
      );
}
export function resumedLaunch(
  launch: SessionLaunch,
  provider: AgentProvider,
  id: string,
): SessionLaunch {
  if (!(provider === "antigravity" ? validAcpId(id) : validConversationId(id)))
    throw new Error("La conversación necesita un identificador válido.");
  if (!canResume(launch, provider))
    throw new Error(
      "Este perfil ya contiene opciones de recuperación. Crea un perfil sin --resume / --continue para elegir una conversación.",
    );
  const args = launch.args?.trim() ?? "";
  return {
    ...launch,
    args:
      provider === "antigravity" ? args : provider === "claude"
        ? `${args} --resume ${id}`.trim()
        : `${args} resume ${id}`.trim(),
  };
}

export const validAcpId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id);
