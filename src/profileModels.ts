/** Consulta el catálogo del perfil de destino sin abrir una conversación ni enviar turnos. */
import { agentKill, agentSpawn, agentWrite, listenAgentExit, listenAgentLine, type AgentSpawnRequest } from "./api";
import type { ModelInfo } from "./chatState";
import { claudeChatFlags, controlLine, parseModels } from "./claudeChat";
import { codexLaunch, notificationLine, parseCodexModels, requestLine } from "./codexChat";
import { canResume } from "./conversations";
import { parseTrexModels } from "./trexChat";
import { launchForProfile } from "./profiles";
import type { LauncherProfile, Settings } from "./types";

type Unlisten = () => void;
export type ProfileModelTransport = {
  spawn: (request: AgentSpawnRequest) => Promise<unknown>;
  write: (id: string, line: string) => Promise<void>;
  kill: (id: string) => Promise<void>;
  listenLine: (id: string, callback: (line: string) => void) => Promise<Unlisten>;
  listenExit: (id: string, callback: (code: number | null) => void) => Promise<Unlisten>;
};

const nativeTransport: ProfileModelTransport = {
  spawn: agentSpawn,
  write: agentWrite,
  kill: agentKill,
  listenLine: listenAgentLine,
  listenExit: listenAgentExit,
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const failure = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** El adaptador permite comprobar el protocolo y sus cancelaciones sin ejecutar asistentes reales. */
export function createProfileModelLoader(transport: ProfileModelTransport, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}) {
  return (profile: LauncherProfile, settings: Settings, cwd: string, signal?: AbortSignal): Promise<ModelInfo[]> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("La consulta de modelos se canceló.")); return; }
    const launch = launchForProfile(settings, profile);
    if (!canResume(launch, profile.provider)) { reject(new Error("Este perfil no admite consultar modelos para una conversación nueva.")); return; }
    const codex = profile.provider === "codex" ? codexLaunch(launch.args) : null;
    if (profile.provider === "codex" && !codex) { reject(new Error("Este perfil de Codex solo funciona en la terminal.")); return; }

    const id = `trex-models-${crypto.randomUUID()}`;
    const initializeId = `${id}-initialize`;
    const unlisteners: Unlisten[] = [];
    const models: ModelInfo[] = [];
    const cursors = new Set<string>();
    let done = false;
    let spawnStarted = false;
    let nextId = 1;
    let expectedId = 1;
    let phase: "initialize" | "models" = "initialize";

    const kill = (): void => { void Promise.resolve().then(() => transport.kill(id)).catch(() => undefined); };
    const unlisten = (fn: Unlisten): void => { try { fn(); } catch { /* El proceso se cierra igualmente. */ } };
    const finish = (error?: unknown, result: ModelInfo[] = []): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      unlisteners.splice(0).forEach(unlisten);
      if (spawnStarted) kill();
      if (error !== undefined) reject(failure(error)); else resolve(result);
    };
    const abort = (): void => finish(new Error("La consulta de modelos se canceló."));
    const timer = setTimeout(() => finish(new Error("El asistente tardó demasiado en responder al cargar los modelos. Puedes volver a intentarlo.")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });

    const write = async (line: string): Promise<void> => {
      if (done) return;
      await transport.write(id, line);
    };
    const requestModels = (cursor?: string): void => {
      phase = "models";
      expectedId = ++nextId;
      void write(requestLine(expectedId, profile.provider === "trex" ? "models/list" : "model/list", cursor ? { cursor } : {})).catch(finish);
    };
    const onLine = (line: string): void => {
      if (done) return;
      let message: Record<string, unknown> | null;
      try { message = asRecord(JSON.parse(line)); } catch { return; }
      if (!message) return;
      if (profile.provider === "claude") {
        const response = message.type === "control_response" ? asRecord(message.response) : null;
        if (response?.request_id !== initializeId) return;
        if (response.subtype !== "success") { finish(new Error(typeof response.error === "string" ? response.error : "Claude no pudo cargar sus modelos.")); return; }
        finish(undefined, parseModels(asRecord(response.response)?.models));
        return;
      }
      if (message.id !== expectedId) return;
      if (message.error) {
        const detail = asRecord(message.error)?.message;
        finish(new Error(typeof detail === "string" ? detail : "Codex no pudo cargar sus modelos."));
        return;
      }
      if (!("result" in message)) return;
      if (phase === "initialize") {
        if (profile.provider === "trex") {
          if (asRecord(message.result)?.protocolVersion !== 1) { finish(new Error("Trex CLI necesita actualizarse para consultar sus modelos.")); return; }
          requestModels(); return;
        }
        expectedId = -1;
        void write(notificationLine("initialized")).then(() => { if (!done) requestModels(); }).catch(finish);
        return;
      }
      const result = asRecord(message.result);
      if (profile.provider === "trex") { finish(undefined, parseTrexModels(result?.models)); return; }
      for (const model of parseCodexModels(result?.data)) if (!models.some(item => item.value === model.value)) models.push(model);
      const cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
      if (cursor) {
        if (cursors.has(cursor)) { finish(new Error("Codex devolvió una página de modelos repetida. Vuelve a intentarlo.")); return; }
        cursors.add(cursor);
        requestModels(cursor);
      } else finish(undefined, models);
    };

    const register = async (pending: Promise<Unlisten>): Promise<void> => {
      const fn = await pending;
      if (done) unlisten(fn); else unlisteners.push(fn);
    };
    void (async () => {
      try {
        await Promise.all([
          register(transport.listenLine(id, onLine)),
          register(transport.listenExit(id, () => finish(new Error("El asistente se cerró antes de cargar los modelos.")))),
        ]);
        if (done) return;
        spawnStarted = true;
        await transport.spawn({ id, cwd, command: launch.command!, profileArgs: profile.provider === "claude" || profile.provider === "trex" ? launch.args : null,
          flags: profile.provider === "trex" ? ["app-server"] : profile.provider === "claude" ? claudeChatFlags(launch.args, null) : codex!.flags, shell: launch.shell, env: launch.env });
        // Una cancelación puede haber ocurrido mientras el backend creaba el proceso.
        if (done) { kill(); return; }
        await write(profile.provider === "claude" ? controlLine(initializeId, { subtype: "initialize" })
          : profile.provider === "trex" ? requestLine(expectedId, "initialize", { protocolVersion: 1, client: "trex-models", inbox: false })
          : requestLine(expectedId, "initialize", { clientInfo: { name: "trex", title: "trex", version: "0.1.0" },
            capabilities: { experimentalApi: true, requestAttestation: false } }));
      } catch (error) { finish(error); }
    })();
  });
}

export const loadProfileModels = createProfileModelLoader(nativeTransport);
