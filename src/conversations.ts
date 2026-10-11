import { invoke } from "@tauri-apps/api/core";
import type { AgentProvider, Conversation, SessionLaunch } from "./types";
export const validConversationId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export const listConversations = (
  provider: AgentProvider,
  configDir: string,
  cwd: string,
): Promise<Conversation[]> =>
  invoke("list_conversations", { provider, configDir, cwd });
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
  if (!validConversationId(id))
    throw new Error("La conversación necesita un identificador válido.");
  if (!canResume(launch, provider))
    throw new Error(
      "Este perfil ya contiene opciones de recuperación. Crea un perfil sin --resume / --continue para elegir una conversación.",
    );
  const args = launch.args?.trim() ?? "";
  return {
    ...launch,
    args:
      provider === "claude"
        ? `${args} --resume ${id}`.trim()
        : `${args} resume ${id}`.trim(),
  };
}
