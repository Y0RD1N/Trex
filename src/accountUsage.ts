/**
 * Uso del plan de una cuenta sin abrir un chat: lanza el CLI del perfil un
 * momento, le pide el uso (lo mismo que `/usage`) y lo cierra. No se envía
 * ningún mensaje al modelo, así que no gasta tokens ni deja conversaciones.
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  agentKill, agentSpawn, agentWrite, formatError, listenAgentExit, listenAgentLine, listenAgentStderr,
} from "./api";
import { codexLaunch, notificationLine, requestLine } from "./codexChat";
import { controlLine } from "./claudeChat";
import { parseClaudeUsage, parseCodexUsage, type PlanUsage } from "./planUsage";
import { launchForProfile } from "./profiles";
import type { LauncherProfile, Settings } from "./types";

const TIMEOUT_MS = 30_000;
/** Claude Code sin servidores MCP: no hacen falta para leer el uso y tardan en arrancar. */
const CLAUDE_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config"];
const USAGE_REQUEST = "trex-usage";

let counter = 0;

export function readAccountUsage(profile: LauncherProfile, settings: Settings, cwd: string): Promise<PlanUsage | null> {
  const launch = launchForProfile(settings, profile);
  const claude = profile.provider === "claude";
  const product = claude ? "Claude Code" : "Codex";
  const id = `usage-${Date.now().toString(36)}-${++counter}`;
  const codex = claude ? null : codexLaunch(launch.args) ?? codexLaunch(null)!;

  return new Promise<PlanUsage | null>((resolve, reject) => {
    let done = false;
    const unlisten: UnlistenFn[] = [];
    const stderr: string[] = [];
    const finish = (error: Error | null, usage: PlanUsage | null = null): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      for (const stop of unlisten) stop();
      void agentKill(id).catch(() => undefined);
      if (error) reject(error);
      else resolve(usage);
    };
    const timer = window.setTimeout(() => finish(new Error(`${product} tardó demasiado en responder.`)), TIMEOUT_MS);
    const write = (line: string): void => { void agentWrite(id, line).catch(error => finish(new Error(formatError(error)))); };

    const onLine = (line: string): void => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; /* ruido del shell */ }
      if (claude) {
        const response = message.type === "control_response" ? message.response as Record<string, unknown> | undefined : undefined;
        if (response?.request_id !== USAGE_REQUEST) return;
        if (response.subtype === "success") finish(null, parseClaudeUsage(response.response));
        else finish(new Error(typeof response.error === "string" && response.error ? response.error : "Claude Code no dio el uso."));
        return;
      }
      if (message.method !== undefined) return;
      const error = message.error as { message?: string } | undefined;
      if (message.id === 1) {
        if (error) { finish(new Error(error.message || "Codex no respondió.")); return; }
        write(notificationLine("initialized"));
        write(requestLine(2, "account/rateLimits/read", {}));
      } else if (message.id === 2) {
        if (error) finish(new Error(error.message || "Codex no dio el uso."));
        else finish(null, parseCodexUsage(message.result));
      }
    };

    void Promise.all([
      listenAgentLine(id, onLine),
      listenAgentStderr(id, line => { stderr.push(line); }),
      listenAgentExit(id, code => {
        const detail = stderr.slice(-3).join("\n").trim();
        finish(new Error(detail || `${product} se cerró${code !== null ? ` (código ${code})` : ""} sin dar el uso.`));
      }),
    ]).then(async stops => {
      unlisten.push(...stops);
      if (done) { for (const stop of stops) stop(); return; }
      await agentSpawn({
        id, cwd, command: launch.command || profile.provider, shell: launch.shell, env: launch.env,
        profileArgs: claude ? launch.args : null,
        flags: claude ? CLAUDE_FLAGS : codex!.flags,
      });
      if (claude) write(controlLine(USAGE_REQUEST, { subtype: "get_usage" }));
      else write(requestLine(1, "initialize", {
        clientInfo: { name: "trex", title: "trex", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }));
    }).catch(error => finish(new Error(formatError(error))));
  });
}
