import type { BrowserOptions } from "../browser";
/**
 * Piezas comunes de las sesiones de chat (Claude Code y Codex).
 *
 * `useAgentProcess` lanza el CLI sin terminal, reenvía sus líneas y lo cierra
 * al desmontar. Cada proveedor lo envuelve en su propio hook, que habla su
 * protocolo y devuelve una `ChatSession`: lo único que necesita la interfaz.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { createBatchScheduler, createOrderedQueue } from "../lineBatch";
import {
  agentKill, agentSpawn, agentWrite, agentTerminalOutput, listenAgentExit, listenAgentLine, listenAgentStderr, type AgentSpawnRequest,
} from "../api";
import type { ChatState, OutgoingImage, PermissionItem, QuestionChoice } from "../chatState";
import type { AgentProvider, ApplicationIntegrations } from "../types";
import type { ChatMessageQueue } from "./useMessageQueue";
import { AgentTerminals, type TerminalSession } from "../agentTerminals";

/** Datos de la pestaña que necesita una sesión de chat. */
export type ChatSessionOptions = {
  /** Identidad estable de la cola cuando el proceso de un equipo cambia de generación. */
  queueId?: string;
  /** Solo el principal recibe las herramientas de este equipo y generación. */
  team?: { id: string; epoch: string };
  browser?: BrowserOptions;
  desktopEnabled?: boolean;
  /** Control por accesibilidad (experimental): motor propio de Trex, servidor `trex_a11y`. */
  a11yEnabled?: boolean;
  integrations?: ApplicationIntegrations;
  sessionId: string;
  cwd: string;
  command: string | null;
  args: string | null;
  shell: string;
  env: Record<string, string> | null;
  conversationId: string | null;
  /** Modo de permisos con el que empieza la sesión (el que la pestaña tenía elegido). */
  mode: string | null;
  /** Modelo elegido antes de abrir la pestaña; null conserva el del perfil. */
  model?: string | null;
  /** Esfuerzo elegido antes del primer turno; null conserva el del proveedor/perfil. */
  effort?: string | null;
  /** Velocidad elegida antes del primer turno (true: rápida); null conserva la del proveedor/perfil. */
  fast?: boolean | null;
  /** Pestaña de planificación de un workflow; no puede abandonar plan durante su vida. */
  planningOnly?: boolean;
  /** Función de lectura del equipo; no sustituye las restricciones nativas. */
  planningInstruction?: string;
  /**
   * La pestaña se ve. El proceso arranca la primera vez que se muestra: las
   * sesiones restauradas que no se abren no gastan memoria ni CPU.
   */
  visible: boolean;
  onExit: (tabId: string, code: number | null) => void;
  onRunning: (tabId: string) => void;
};

export type ChatSession = {
  provider: AgentProvider;
  state: ChatState;
  queue: ChatMessageQueue;
  terminals?: TerminalSession;
  /** Native provider choices are discovered rather than guessed. */
  modes?: { value: string; label: string; description?: string }[];
  setup?: { busy: boolean; description: string; actions: { label: string; run: () => Promise<void> }[] };
  usageControls?: { loading: boolean; error: string | null; refresh: () => Promise<void> };
  supportsCompact?: boolean;
  /** Arranca el proceso o lo reanuda tras cerrarse. */
  start: () => Promise<void>;
  /** Envía un mensaje; `display` es lo que se ve en el hilo si no es el texto enviado. */
  send: (text: string, images: OutgoingImage[], previews: string[], display?: string) => void | Promise<boolean>;
  /** Envío inmediato explícito; false puede dejar una entrega incierta para revisión manual. */
  sendNow?: (text: string, images: OutgoingImage[], previews: string[], display?: string, onInterrupt?: (messageId: string) => void) => Promise<boolean>;
  /** Reemplaza el mensaje y regenera desde ese punto en una rama del historial original. */
  edit: (id: string, text: string, images: OutgoingImage[], previews: string[]) => Promise<void>;
  /** Empieza una conversación nueva en la misma pestaña. */
  reset: () => void;
  /** Ejecuta un comando local del proveedor; false si no lo conoce. */
  runCommand: (name: string, args: string) => boolean;
  /** Vuelve a leer las skills disponibles en esta cuenta y proyecto. */
  refreshSkills: () => Promise<void>;
  notice: (tone: "info" | "warn" | "error", text: string) => void;
  interrupt: () => void;
  /** Confirmación explícita de revisión tras una operación nativa incierta. */
  recover?: () => Promise<void>;
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

/** Tanda compartida por todas las sesiones: ver `lineBatch.ts`. */
const agentEvents = createBatchScheduler({
  now: () => performance.now(),
  hidden: () => typeof document !== "undefined" && document.hidden,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // Se relanza fuera de la tanda para que llegue al registro de errores sin cortar al resto.
  onError: error => { setTimeout(() => { throw error; }); },
});
// Al ocultarse la ventana los temporizadores se frenan: lo pendiente se entrega ya.
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.hidden) agentEvents.flush(); });

type AgentEvent = { kind: "line"; line: string } | { kind: "stderr"; line: string } | { kind: "exit"; code: number | null };

export type AgentProcessHandlers = {
  onLine: (line: string, procId: string) => void;
  onStderr: (line: string) => void;
  onExit: (code: number | null) => void;
};

/**
 * Proceso del asistente. Cada arranque es una generación nueva: lo que llegue
 * de un proceso anterior se descarta.
 */
export function useAgentProcess(sessionId: string, handlers: AgentProcessHandlers, provider?: AgentProvider) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const procIdRef = useRef<string | null>(null);
  const spawnRef = useRef<Promise<string> | null>(null);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const generationRef = useRef(0);
  const disposedRef = useRef(false);
  const trackerRef = useRef<AgentTerminals | null>(null);
  if (!trackerRef.current) trackerRef.current = new AgentTerminals(provider, agentWrite, agentTerminalOutput);
  const tracker = trackerRef.current;
  const [, redraw] = useReducer((version: number) => version + 1, 0);
  useEffect(() => tracker.subscribe(redraw), [tracker]);

  const isCurrent = useCallback((procId: string): boolean => procIdRef.current === procId && !disposedRef.current, []);

  /** Lanza el proceso; devuelve su id o null si otro arranque lo sustituyó. */
  const spawn = useCallback(async (request: Omit<AgentSpawnRequest, "id">): Promise<string | null> => {
    const procId = `${sessionId}-c${++generationRef.current}`;
    const previous = procIdRef.current;
    procIdRef.current = procId;
    tracker.attach(procId, request.cwd);
    for (const unlisten of unlistenRef.current) unlisten();
    unlistenRef.current = [];
    if (previous) void agentKill(previous).catch(() => undefined);

    // Líneas, avisos y salida van por la misma cola para conservar su orden; lo de un proceso
    // sustituido se descarta al entregarse, no solo al llegar.
    const queue = createOrderedQueue<AgentEvent>(agentEvents, event => {
      if (event.kind === "line") { if (!tracker.observe(event.line, procId)) handlersRef.current.onLine(event.line, procId); }
      else if (event.kind === "stderr") handlersRef.current.onStderr(event.line);
      else { tracker.detach(); handlersRef.current.onExit(event.code); }
    }, () => isCurrent(procId), error => { setTimeout(() => { throw error; }); });
    const listeners = await Promise.all([
      listenAgentLine(procId, line => queue.push({ kind: "line", line })),
      listenAgentStderr(procId, line => queue.push({ kind: "stderr", line })),
      // La salida no espera a la próxima tanda: se entrega con todo lo anterior, en orden.
      listenAgentExit(procId, code => { queue.push({ kind: "exit", code }); queue.drainNow(); }),
    ]);
    if (!isCurrent(procId)) { listeners.forEach(unlisten => unlisten()); return null; }
    unlistenRef.current = listeners;

    const spawned = agentSpawn({ id: procId, ...request }).then(() => procId);
    spawnRef.current = spawned;
    await spawned;
    return isCurrent(procId) ? procId : null;
  }, [sessionId, isCurrent, tracker]);

  const write = useCallback(async (line: string): Promise<void> => {
    const id = await (spawnRef.current ?? Promise.reject(new Error("La sesión no está activa.")));
    await agentWrite(id, line);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      tracker.detach();
      for (const unlisten of unlistenRef.current) unlisten();
      if (procIdRef.current) void agentKill(procIdRef.current).catch(() => undefined);
    };
  }, []);

  const terminals = useMemo<TerminalSession>(() => ({ snapshot: tracker.snapshot, refresh: tracker.refresh, stop: tracker.stop, read: tracker.read, write: tracker.sendInput }), [tracker, tracker.snapshot]);
  return useMemo(() => ({ spawn, write, isCurrent, terminals, bindTerminals: tracker.bind }), [spawn, write, isCurrent, terminals, tracker]);
}
