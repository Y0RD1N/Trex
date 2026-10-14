/**
 * Piezas comunes de las sesiones de chat (Claude Code y Codex).
 *
 * `useAgentProcess` lanza el CLI sin terminal, reenvía sus líneas y lo cierra
 * al desmontar. Cada proveedor lo envuelve en su propio hook, que habla su
 * protocolo y devuelve una `ChatSession`: lo único que necesita la interfaz.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  agentKill, agentSpawn, agentWrite, listenAgentExit, listenAgentLine, listenAgentStderr, type AgentSpawnRequest,
} from "../api";
import type { ChatState, OutgoingImage, PermissionItem, QuestionChoice } from "../chatState";
import type { AgentProvider } from "../types";

/** Datos de la pestaña que necesita una sesión de chat. */
export type ChatSessionOptions = {
  sessionId: string;
  cwd: string;
  command: string | null;
  args: string | null;
  shell: string;
  env: Record<string, string> | null;
  conversationId: string | null;
  /** Modo de permisos con el que empieza la sesión (el que la pestaña tenía elegido). */
  mode: string | null;
  onExit: (tabId: string, code: number | null) => void;
  onRunning: (tabId: string) => void;
};

export type ChatSession = {
  provider: AgentProvider;
  state: ChatState;
  /** Arranca el proceso o lo reanuda tras cerrarse. */
  start: () => Promise<void>;
  /** Envía un mensaje; `display` es lo que se ve en el hilo si no es el texto enviado. */
  send: (text: string, images: OutgoingImage[], previews: string[], display?: string) => void;
  /** Empieza una conversación nueva en la misma pestaña. */
  reset: () => void;
  /** Ejecuta un comando local del proveedor; false si no lo conoce. */
  runCommand: (name: string, args: string) => boolean;
  notice: (tone: "info" | "warn" | "error", text: string) => void;
  interrupt: () => void;
  answer: (item: PermissionItem, allowed: boolean, remember: boolean, choices?: QuestionChoice[]) => void;
  setMode: (mode: string) => void;
  setModel: (model: string) => void;
  setEffort: (effort: string) => void;
  /** Velocidad rápida o estándar, si el modelo en uso la admite. */
  setFast: (fast: boolean) => void;
};

let counter = 0;
/** Identificador único para mensajes y peticiones propias. */
export const localId = (): string => `trex-${Date.now().toString(36)}-${(++counter).toString(36)}`;

export type AgentProcessHandlers = {
  onLine: (line: string, procId: string) => void;
  onStderr: (line: string) => void;
  onExit: (code: number | null) => void;
};

/**
 * Proceso del asistente. Cada arranque es una generación nueva: lo que llegue
 * de un proceso anterior se descarta.
 */
export function useAgentProcess(sessionId: string, handlers: AgentProcessHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const procIdRef = useRef<string | null>(null);
  const spawnRef = useRef<Promise<string> | null>(null);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const generationRef = useRef(0);
  const disposedRef = useRef(false);

  const isCurrent = useCallback((procId: string): boolean => procIdRef.current === procId && !disposedRef.current, []);

  /** Lanza el proceso; devuelve su id o null si otro arranque lo sustituyó. */
  const spawn = useCallback(async (request: Omit<AgentSpawnRequest, "id">): Promise<string | null> => {
    const procId = `${sessionId}-c${++generationRef.current}`;
    const previous = procIdRef.current;
    procIdRef.current = procId;
    for (const unlisten of unlistenRef.current) unlisten();
    unlistenRef.current = [];
    if (previous) void agentKill(previous).catch(() => undefined);

    const listeners = await Promise.all([
      listenAgentLine(procId, line => { if (isCurrent(procId)) handlersRef.current.onLine(line, procId); }),
      listenAgentStderr(procId, line => { if (isCurrent(procId)) handlersRef.current.onStderr(line); }),
      listenAgentExit(procId, code => { if (isCurrent(procId)) handlersRef.current.onExit(code); }),
    ]);
    if (!isCurrent(procId)) { listeners.forEach(unlisten => unlisten()); return null; }
    unlistenRef.current = listeners;

    const spawned = agentSpawn({ id: procId, ...request }).then(() => procId);
    spawnRef.current = spawned;
    await spawned;
    return isCurrent(procId) ? procId : null;
  }, [sessionId, isCurrent]);

  const write = useCallback(async (line: string): Promise<void> => {
    const id = await (spawnRef.current ?? Promise.reject(new Error("La sesión no está activa.")));
    await agentWrite(id, line);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      for (const unlisten of unlistenRef.current) unlisten();
      if (procIdRef.current) void agentKill(procIdRef.current).catch(() => undefined);
    };
  }, []);

  return useMemo(() => ({ spawn, write, isCurrent }), [spawn, write, isCurrent]);
}
