/**
 * Modo llamada: conecta lo que oye el motor de voz con la app.
 *
 * Cada frase dirigida a trex (`voice://utterance`) se le pasa a Claude junto con el
 * estado de proyectos y sesiones; su respuesta se ejecuta sobre la app y se dice en
 * voz alta. Las frases se atienden de una en una. Con la voz apagada no llega ningún
 * evento y este hook no hace nada.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatError } from "../api";
import { remoteBridge } from "../remoteBridge";
import type { Project } from "../types";
import type { VoiceUtterance } from "../voice";
import { VOICE_LIVE_EVENT, VOICE_TOOL_EVENT, VOICE_UTTERANCE_EVENT, voiceLiveToolResult } from "../voiceApi";
import { SessionRefs, liveCaption, liveEndMessage, liveSessions, runLiveTool, type LiveToolDeps, type VoiceLiveEvent, type VoiceToolRequest } from "../voiceLive";
import {
  BRAIN_SCHEMA, BRAIN_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM, brainPrompt, describeSessions, isGoodbye, parseBrainReply, runBrainActions,
  spokenReply, summaryPrompt, type BrainExchange, type BrainProject, type SummaryProject,
} from "../voiceBrain";

/** Lo que el indicador enseña de la conversación en curso. */
export type VoiceCallState = {
  thinking: boolean;
  reply: string | null;
  /** Llamada en tiempo real en curso: lo último que dijo cada uno. */
  live: { state: "connecting" | "talking"; heard: string; said: string } | null;
};

let callState: VoiceCallState = { thinking: false, reply: null, live: null };
const listeners = new Set<() => void>();
function setCallState(next: VoiceCallState): void {
  callState = next;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useVoiceCallState = (): VoiceCallState => useSyncExternalStore(subscribe, () => callState);

type Options = {
  projects: Project[];
  activeProjectId: string | null;
  selectProject: (projectId: string) => void;
  /** Abre una sesión con el asistente predeterminado y devuelve su id. */
  openSession: (projectId: string) => string | null;
};

const think = (system: string, prompt: string, schema: string): Promise<unknown> => invoke("voice_think", { system, prompt, schema });
const speak = (text: string): Promise<void> => invoke<void>("voice_speak", { text }).catch(() => undefined);
const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

/** Una sesión recién abierta tarda un momento en montarse y apuntarse al puente. */
async function sessionReady(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (remoteBridge.has(id)) return true;
    await wait(150);
  }
  return false;
}

export function useVoiceCall(options: Options): void {
  const latest = useRef(options);
  latest.current = options;
  const history = useRef<BrainExchange[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!isTauri()) return;

    const say = async (command: string, reply: string): Promise<void> => {
      history.current = [...history.current, { you: command, trex: reply }].slice(-4);
      const shown: VoiceCallState = { thinking: false, reply, live: null };
      setCallState(shown);
      await speak(reply);
      // La respuesta se queda un momento a la vista y luego el indicador vuelve a su estado normal.
      window.setTimeout(() => { if (callState === shown) setCallState({ thinking: false, reply: null, live: null }); }, 6000);
    };

    const summarize = async (hours: number, only: BrainProject | null, projects: BrainProject[]): Promise<string> => {
      const { sessions } = describeSessions(remoteBridge.sessions(), id => remoteBridge.detailOf(id), Date.now());
      const data: SummaryProject[] = await Promise.all((only ? [only] : projects).map(async project => ({
        name: project.name,
        commits: await invoke<string[]>("voice_recent_commits", { cwd: project.path, hours }).catch(() => []),
        sessions: sessions.filter(session => session.project === project.name),
      })));
      const reply = await think(SUMMARY_SYSTEM, summaryPrompt(hours, data), SUMMARY_SCHEMA);
      const text = reply && typeof reply === "object" ? (reply as { say?: unknown }).say : null;
      return typeof text === "string" && text.trim() ? text.trim() : "No pude preparar el resumen.";
    };

    const attend = async (utterance: VoiceUtterance): Promise<void> => {
      const command = utterance.command.trim();
      if (!command) { await say("", "Dime."); return; }
      if (isGoodbye(command)) { await say(command, "Vale."); return; }
      setCallState({ thinking: true, reply: null, live: null });
      try {
        const { projects, activeProjectId, selectProject, openSession } = latest.current;
        const brainProjects: BrainProject[] = projects.map(({ id, name, path }) => ({ id, name, path }));
        const { sessions, ids } = describeSessions(remoteBridge.sessions(), id => remoteBridge.detailOf(id), Date.now());
        const reply = parseBrainReply(await think(BRAIN_SYSTEM, brainPrompt({
          now: new Date(), projects: brainProjects, sessions, history: history.current, command,
          activeProject: projects.find(project => project.id === activeProjectId)?.name ?? null,
        }), BRAIN_SCHEMA));
        const outcome = await runBrainActions(reply.actions, {
          projects: brainProjects, sessionIds: ids, selectProject, openSession, sessionReady,
          send: (session, text) => remoteBridge.run(session, { kind: "send", text, files: [] }),
          interrupt: session => remoteBridge.run(session, { kind: "interrupt" }),
        });
        const summary = outcome.summarize ? await summarize(outcome.summarize.hours, outcome.summarize.project, brainProjects) : "";
        await say(command, spokenReply(summary || reply.say, outcome.problems) || "Hecho.");
      } catch (failure) {
        await say(command, `No pude hacerlo. ${formatError(failure)}`);
      }
    };

    // --- Modo en tiempo real: Gemini pide herramientas y la app las ejecuta ---
    let refs = new SessionRefs();
    const liveDeps = (): LiveToolDeps => {
      const { projects, activeProjectId, selectProject, openSession } = latest.current;
      return {
        projects: projects.map(({ id, name, path }) => ({ id, name, path })),
        activeProject: projects.find(project => project.id === activeProjectId)?.name ?? null,
        refs,
        sessions: () => liveSessions(remoteBridge.sessions(), id => remoteBridge.detailOf(id), refs, Date.now()),
        selectProject, openSession, sessionReady,
        send: (session, text) => remoteBridge.run(session, { kind: "send", text, files: [] }),
        interrupt: session => remoteBridge.run(session, { kind: "interrupt" }),
        commits: (project, hours) => invoke<string[]>("voice_recent_commits", { cwd: project.path, hours }).catch(() => []),
      };
    };

    const onLive = (event: VoiceLiveEvent): void => {
      const live = callState.live;
      if (event.kind === "state") {
        if (event.state === "ended") {
          const message = liveEndMessage(event);
          const shown: VoiceCallState = { thinking: false, reply: message || null, live: null };
          setCallState(shown);
          if (message) window.setTimeout(() => { if (callState === shown) setCallState({ thinking: false, reply: null, live: null }); }, 8000);
          return;
        }
        // Cada llamada empieza con alias de sesión nuevos.
        if (event.state === "connecting") refs = new SessionRefs();
        setCallState({ thinking: false, reply: null, live: { state: event.state, heard: live?.heard ?? "", said: live?.said ?? "" } });
      } else if (!live) {
        return;
      } else if (event.kind === "heard") {
        // Al empezar a hablar la persona, lo que decía trex deja de estar a la vista.
        setCallState({ ...callState, live: { ...live, heard: liveCaption(live.said ? "" : live.heard, event.text), said: "" } });
      } else if (event.kind === "said") {
        setCallState({ ...callState, live: { ...live, said: liveCaption(live.said, event.text) } });
      } else if (event.kind === "turn") {
        setCallState({ ...callState, live: { ...live, heard: "" } });
      }
    };

    const unlisten = Promise.all([
      listen<VoiceUtterance>(VOICE_UTTERANCE_EVENT, event => {
        // De una en una: la siguiente frase espera a que termine la respuesta anterior.
        queue.current = queue.current.then(() => attend(event.payload)).catch(() => undefined);
      }),
      listen<VoiceLiveEvent>(VOICE_LIVE_EVENT, event => onLive(event.payload)),
      listen<VoiceToolRequest>(VOICE_TOOL_EVENT, event => {
        const { id, name, args } = event.payload;
        void runLiveTool(name, args, liveDeps()).then(result => voiceLiveToolResult(id, result)).catch(() => undefined);
      }),
    ]);
    return () => { void unlisten.then(list => list.forEach(stop => stop())); };
  }, []);
}
