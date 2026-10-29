/** Native ACP process shared by chat and metadata queries; never starts a model turn implicitly. */
import { agentKill, agentSpawn, agentWrite, antigravityRuntime, listenAgentExit, listenAgentLine, listenAgentStderr } from "./api";
import { AcpConnection, validAcpSessionId, sameAcpCwd } from "./acpProtocol";
import { record, text, type Json } from "./chatState";
import type { Conversation } from "./types";
import { AntigravityUsageReader, antigravityTier } from "./antigravityUsage";
import type { PlanUsage } from "./planUsage";

export type AntigravityConnection = { rpc: AcpConnection; init: Json; close: () => Promise<void> };
/** Account quota from the same ACP home. Only invokes an advertised native /usage command. */
export async function readAntigravityAccountUsage(command: string, configDir: string, cwd: string): Promise<PlanUsage | null> {
  const reader = new AntigravityUsageReader(), early: { sessionId: string; update: Json }[] = [];
  let sessionId: string | null = null;
  let commandsReady!: () => void;
  const commands = new Promise<void>(resolve => { commandsReady = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connection = await openAntigravity(command, configDir, cwd, { notification(method, params) {
    const update = record(params.update); if (method !== "session/update" || !validAcpSessionId(params.sessionId) || !update) return;
    if (!sessionId) { if (early.length < 64) early.push({ sessionId: params.sessionId, update }); }
    else if (params.sessionId === sessionId) { reader.observe(sessionId, update); if (update.sessionUpdate === "available_commands_update") commandsReady(); }
  } });
  try {
    const result = await connection.rpc.call("session/new", { cwd, mcpServers: [] });
    if (!validAcpSessionId(result.sessionId)) throw new Error("Antigravity no identificó la sesión de consulta.");
    sessionId = result.sessionId;
    for (const event of early) if (event.sessionId === sessionId) reader.observe(sessionId, event.update);
    if (!reader.supported) await Promise.race([commands, new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
    if (!reader.supported) return null;
    return (await reader.read(connection.rpc, sessionId, antigravityTier(result))).plan;
  } finally { clearTimeout(timer); await connection.close(); }
}
export async function openAntigravity(command: string, configDir: string, cwd: string,
  callbacks: { notification?: (method: string, params: Json) => void; request?: (id: string | number, method: string, params: Json) => void;
    stderr?: (line: string) => void; exit?: (code: number | null) => void } = {}, signal?: AbortSignal): Promise<AntigravityConnection> {
  signal?.throwIfAborted();
  const runtime = await antigravityRuntime(command, configDir);
  signal?.throwIfAborted();
  if (!runtime.installed || !runtime.command) throw new Error("Antigravity necesita su componente ACP oficial. Instálalo desde Ajustes > Asistentes > Antigravity.");
  const id = `trex-acp-${crypto.randomUUID()}`, unlisten: (() => void)[] = [];
  let active = true, spawned = false;
  const rpc = new AcpConnection({ write: line => agentWrite(id, line) },
    (method, params) => { if (active) callbacks.notification?.(method, params); },
    (requestId, method, params) => { if (!active) return; if (callbacks.request) callbacks.request(requestId, method, params); else void rpc.reject(requestId).catch(() => undefined); });
  const close = async (): Promise<void> => {
    if (!active) return;
    active = false; signal?.removeEventListener("abort", abort); rpc.close();
    unlisten.splice(0).forEach(fn => fn());
    if (spawned) await agentKill(id).catch(() => undefined);
  };
  const abort = (): void => { void close(); };
  const register = async (work: Promise<() => void>): Promise<void> => { const fn = await work; if (active) unlisten.push(fn); else fn(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await Promise.all([
      register(listenAgentLine(id, line => { if (active) rpc.accept(line); })),
      register(listenAgentStderr(id, line => { if (active) callbacks.stderr?.(line); })),
      register(listenAgentExit(id, code => { if (active) { void close(); callbacks.exit?.(code); } })),
    ]);
    if (!active) throw new Error("Se canceló la conexión con Antigravity.");
    spawned = true;
    await agentSpawn({ id, cwd, command: runtime.command, profileArgs: null, flags: runtime.flags, shell: "", env: runtime.env });
    if (!active) { await agentKill(id).catch(() => undefined); throw new Error("Se canceló el arranque de Antigravity."); }
    const init = await rpc.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "trex", title: "Trex", version: "0.1.0" } }, 60_000);
    if (init.protocolVersion !== 1 || record(init.agentInfo)?.name !== "antigravity-acp") throw new Error("El componente no se identificó como el servidor ACP oficial de Antigravity.");
    return { rpc, init, close };
  } catch (error) { await close(); throw error; }
}

export async function listAntigravityConversations(command: string, configDir: string, cwd: string, signal?: AbortSignal): Promise<Conversation[]> {
  const connection = await openAntigravity(command, configDir, cwd, {}, signal);
  try {
    if (!record(record(connection.init.agentCapabilities)?.sessionCapabilities)?.list) throw new Error("Este componente no permite consultar conversaciones.");
    const sessions: Conversation[] = [], seen = new Set<string>(); let cursor: string | null = null;
    do {
      signal?.throwIfAborted();
      const result = await connection.rpc.call("session/list", { cwd, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.sessions)) throw new Error("Antigravity devolvió una lista de conversaciones no válida.");
      for (const raw of result.sessions) {
        const row = record(raw); if (!row || !validAcpSessionId(row.sessionId) || typeof row.cwd !== "string" || !sameAcpCwd(row.cwd, cwd) || sessions.some(s => s.id === row.sessionId)) continue;
        sessions.push({ id: row.sessionId, provider: "antigravity", title: text(row.title) || "Conversación de Antigravity", cwd, updatedAt: Date.parse(text(row.updatedAt)) || 0 });
      }
      cursor = text(result.nextCursor) || null;
      if (cursor && (seen.has(cursor) || seen.size >= 10)) throw new Error("Antigravity devolvió una paginación no válida.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } finally { await connection.close(); }
}
