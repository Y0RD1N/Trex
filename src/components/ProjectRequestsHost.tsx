/**
 * Chats que contestan, en segundo plano, las preguntas que hacen los agentes de otros proyectos.
 *
 * Un chat solo arranca su proceso cuando se muestra su pestaña, así que estos no son pestañas: son
 * componentes sin pantalla, como los miembros de un equipo (`AgentTeamView`). Cada uno corre en la
 * carpeta del proyecto que contesta, con la cuenta que eligió la persona y en solo lectura
 * (`planningOnly`); entra en la coordinación de ese proyecto como una sesión más.
 *
 * Cada vuelta: lee el diario (y lo publica para los chats que esperan respuesta), envía la pregunta a
 * los chats que ya arrancaron, guarda la respuesta final de los que terminaron y empieza las que
 * están en cola. Montado solo con la función encendida; al desmontarse, los procesos se cierran y lo
 * que estaba a medias vuelve a la cola la próxima vez (`project_requests_recover`).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatSession, ChatSessionOptions } from "../hooks/chatSession";
import { useClaudeChat } from "../hooks/useClaudeChat";
import { useCodexChat } from "../hooks/useCodexChat";
import { useTrexChat } from "../hooks/useTrexChat";
import { useCoordination } from "../hooks/useCoordination";
import { sanitizeHandoffText } from "../handoff";
import { formatError } from "../api";
import { launchForProfile, profilesForInstallation } from "../profiles";
import { codexChatSupported } from "../codexChat";
import {
  ANSWER_POLICY, answerDisplay, answerPrompt, finalReply, persist, projectRequestClaim, projectRequestDecide, projectRequestFinish, projectRequestRetry,
  projectRequestsRecover, projectRequestsSnapshot, projectRequestsStore, requestChats, requestOrphan, type ProjectRequest,
} from "../projectRequests";
import { usageTotals, type UsageTotals } from "../tokenUsage";
import type { LauncherProfile, Project, Settings } from "../types";

const TICK_MS = 1_500;
/** Lo que puede tardar en arrancar un agente (Claude con muchas herramientas tarda). */
const START_MS = 3 * 60_000;
/** Lo que puede tardar en contestar: después se corta y quien preguntó lo sabe. */
const ANSWER_MS = 20 * 60_000;
const MAX_ACTIVE = 4;
/**
 * Los encargos en marcha se dan por cortados solo al arrancar trex. Si la función se apaga y se vuelve a
 * encender, el host se monta otra vez pero el chat que hace el encargo sigue abierto y lo termina él.
 */
let recoveredChanges = false;

type Provider = "claude" | "codex" | "trex";
type Runner = {
  request: ProjectRequest;
  provider: Provider;
  label: string;
  options: ChatSessionOptions;
  claimedAt: number;
  phase: "starting" | "sending" | "answering";
  sentAt: number;
  /** Respuesta anterior y mensajes ya existentes: la respuesta buscada es la del mensaje nuevo. */
  previous: string | null;
  users: Set<string>;
};

/** La cuenta que contesta por un proyecto, o por qué no puede hacerlo. */
export function answeringProfile(settings: Settings, projectId: string, trexInstalled: boolean): LauncherProfile | string {
  const answerer = settings.projectRequests.answerers.find(entry => entry.projectId === projectId);
  if (!answerer?.questions) return "ya no contesta preguntas";
  const profiles = profilesForInstallation(settings, trexInstalled);
  // «Predeterminado» (o una cuenta que ya no existe, que Ajustes muestra igual): el perfil predeterminado si
  // puede contestar; si no, la primera cuenta que pueda.
  const usable = profiles.filter(entry => entry.provider !== "antigravity");
  const profile = profiles.find(entry => entry.id === answerer.profileId)
    ?? usable.find(entry => entry.id === settings.defaultProfileId) ?? usable[0];
  if (!profile) return "no hay ninguna cuenta que pueda contestar";
  if (profile.provider === "antigravity") return "Antigravity no puede contestar en solo lectura; elige otra cuenta en Ajustes → Proyectos";
  if (!profile.command.trim()) return `la cuenta «${profile.name}» no tiene comando`;
  if (profile.provider === "codex" && !codexChatSupported(profile.args)) return `la cuenta «${profile.name}» usa opciones de terminal`;
  return profile;
}

type RuntimeProps = { id: string; label: string; options: ChatSessionOptions; publish: (id: string, session: ChatSession | null) => void };
function Publish({ id, label, options, session, publish }: RuntimeProps & { session: ChatSession }) {
  // Una sesión más del proyecto que contesta: sus compañeros la ven en «Sesiones».
  useCoordination(session, { id: options.sessionId, project: options.cwd, label });
  useLayoutEffect(() => publish(id, session));
  useLayoutEffect(() => () => publish(id, null), [id, publish]);
  return null;
}
function ClaudeRuntime(props: RuntimeProps) { return <Publish {...props} session={useClaudeChat(props.options)} />; }
function CodexRuntime(props: RuntimeProps) { return <Publish {...props} session={useCodexChat(props.options)} />; }
function TrexRuntime(props: RuntimeProps) { return <Publish {...props} session={useTrexChat(props.options)} />; }
const RUNTIMES = { claude: ClaudeRuntime, codex: CodexRuntime, trex: TrexRuntime };

const noop = (): void => undefined;

type HostProps = {
  settings: Settings;
  projects: Project[];
  trexInstalled: boolean;
  /** Una respuesta terminó y el chat que preguntó ya no está abierto: hay que avisar. */
  onOrphan?: (request: ProjectRequest) => void;
};

function ProjectRequestsHost({ settings, projects, trexInstalled, onOrphan }: HostProps) {
  const [runners, setRunners] = useState<Runner[]>([]);
  const runnersRef = useRef(new Map<string, Runner>());
  const sessions = useRef(new Map<string, ChatSession>());
  const latest = useRef({ settings, projects, trexInstalled, onOrphan });
  latest.current = { settings, projects, trexInstalled, onOrphan };
  const publish = useCallback((id: string, session: ChatSession | null) => {
    if (session) sessions.current.set(id, session); else sessions.current.delete(id);
  }, []);

  useEffect(() => {
    let cancelled = false, ticking = false;
    const runnersMap = runnersRef.current;
    const changed = (): void => { if (!cancelled) setRunners([...runnersMap.values()]); };
    const drop = (id: string): void => { runnersMap.delete(id); changed(); };
    const finish = async (runner: Runner, status: "answered" | "failed", report: string, conversation: string | null = null): Promise<void> => {
      // Conversación nueva solo para esta pregunta: todo lo que gastó es de ella.
      const usage: UsageTotals | null = usageTotals(sessions.current.get(runner.request.id)?.state.apiUsage);
      drop(runner.request.id);
      await persist(() => projectRequestFinish(runner.request.id, status, report, conversation, usage));
    };
    /** Se cortó a medias (proceso cerrado, turno interrumpido): solo lee, así que se repite una vez. */
    const retry = async (runner: Runner, report: string): Promise<void> => {
      drop(runner.request.id);
      await persist(() => projectRequestRetry(runner.request.id, report));
    };
    /** Respuestas sin chat que ya se avisaron, y las vistas en la vuelta anterior (un chat que se monta tarda un momento en apuntarse). */
    const announced = new Set<string>();
    let suspects = new Set<string>();
    const watchOrphans = (snapshot: ProjectRequest[]): void => {
      const now = new Set<string>();
      for (const request of snapshot.filter(requestOrphan)) {
        now.add(request.id);
        if (suspects.has(request.id) && !announced.has(request.id)) {
          announced.add(request.id);
          latest.current.onOrphan?.(request);
        }
      }
      suspects = now;
    };
    /**
     * Encargos cuyo chat ya no está abierto (dos vueltas seguidas, como las respuestas sin chat): el que
     * hacía uno o iba a hacerlo se cerró, o se cerró el que lo pidió antes de que lo aprobaras.
     */
    let closing = new Set<string>();
    const closed = new Set<string>();
    const watchChanges = (snapshot: ProjectRequest[]): void => {
      const now = new Set<string>();
      for (const request of snapshot) {
        if (request.kind !== "change" || closed.has(request.id)) continue;
        const gone = request.status === "awaiting_approval" ? !requestChats.has(request.fromSession)
          : (request.status === "approved" || request.status === "running") && !!request.toSession && !requestChats.has(request.toSession);
        if (!gone) continue;
        now.add(request.id);
        if (!closing.has(request.id)) continue;
        closed.add(request.id);
        const write = request.status === "awaiting_approval"
          ? () => projectRequestDecide(request.id, false, null, "El chat que lo pidió se cerró antes de que lo aprobaras.")
          : () => projectRequestFinish(request.id, "failed", request.status === "running"
            ? `El chat de «${request.toName}» se cerró mientras hacía el encargo. Revisa ese proyecto para ver qué llegó a cambiar.`
            : `El chat de «${request.toName}» que iba a hacerlo se cerró antes de empezar. Pídelo de nuevo si sigue haciendo falta.`, null);
        void persist(write);
      }
      closing = now;
    };

    const advance = async (runner: Runner, snapshot: ProjectRequest[]): Promise<void> => {
      const stored = snapshot.find(request => request.id === runner.request.id);
      // Cancelada por la persona, o cerrada desde otro sitio: el proceso se cierra al desmontarse.
      if (!stored || stored.status !== "running" || stored.answerSession !== runner.options.sessionId) { drop(runner.request.id); return; }
      const session = sessions.current.get(runner.request.id);
      const elapsed = Date.now() - runner.claimedAt;
      if (!session) { if (elapsed > START_MS) await finish(runner, "failed", "El chat que iba a contestar no llegó a arrancar."); return; }
      const state = session.state;
      if (["failed", "exited"].includes(state.process)) {
        await retry(runner, `El agente de «${runner.request.toName}» se cerró antes de contestar${state.stderr.length ? `: ${state.stderr.slice(-2).join(" ").slice(0, 300)}` : "."}`);
        return;
      }
      // Solo lee: lo que pida permiso se rechaza solo, en vez de esperar a alguien que no lo ve.
      for (const item of state.items) if (item.kind === "permission" && item.state === "pending") session.answer(item, false, false);
      if (runner.phase === "starting") {
        if (session.queue.error) { await finish(runner, "failed", `No se pudo preparar el chat que contesta: ${session.queue.error}`); return; }
        if (state.process !== "ready" || !session.queue.ready || state.pendingTurns > 0) {
          if (elapsed > START_MS) await finish(runner, "failed", `El agente de «${runner.request.toName}» no arrancó a tiempo.`);
          return;
        }
        runner.phase = "sending";
        runner.previous = state.lastCompletion?.id ?? null;
        runner.users = new Set([...state.pendingMessageIds, ...state.items.filter(item => item.kind === "user").map(item => item.id)]);
        const accepted = await Promise.resolve(session.send(answerPrompt(runner.request), [], [], answerDisplay(runner.request))).catch(() => false);
        if (cancelled || runnersMap.get(runner.request.id) !== runner) return;
        if (accepted === false) { await finish(runner, "failed", "El agente no aceptó la pregunta."); return; }
        runner.phase = "answering";
        runner.sentAt = Date.now();
        return;
      }
      if (runner.phase !== "answering") return;
      const done = state.lastCompletion;
      if (done && done.id !== runner.previous && done.messageIds.some(id => !runner.users.has(id))) {
        const text = sanitizeHandoffText(finalReply(state.items, new Set(done.itemIds))).trim();
        if (done.status === "completed" && text) await finish(runner, "answered", text, state.sessionId);
        else if (done.status === "completed") await finish(runner, "failed", "El agente terminó sin escribir una respuesta.", state.sessionId);
        // Un turno cortado (p. ej., Codex detiene el turno al rechazarle un comando fuera de solo lectura) se repite una vez.
        else await retry(runner, text ? `Se cortó antes de terminar. Lo que llegó a escribir:\n\n${text}` : "Se cortó antes de terminar de contestar.");
        return;
      }
      if (Date.now() - runner.sentAt > ANSWER_MS) {
        session.interrupt();
        await finish(runner, "failed", `No terminó de contestar en ${ANSWER_MS / 60_000} minutos.`, state.sessionId);
      }
    };

    const start = async (request: ProjectRequest): Promise<void> => {
      const { settings: current, projects: list, trexInstalled: installed } = latest.current;
      const project = list.find(entry => entry.id === request.toProjectId);
      const profile = project ? answeringProfile(current, project.id, installed) : "ya no está en trex";
      if (typeof profile === "string" || !project) {
        await projectRequestFinish(request.id, "failed", `«${request.toName}» no puede contestar: ${typeof profile === "string" ? profile : "ya no está en trex"}.`, null).catch(() => undefined);
        return;
      }
      // Como las pestañas: la cola de mensajes exige el prefijo «t-». Cada intento con su sesión: un proceso del
      // intento anterior que aún se esté cerrando no se confunde con el nuevo.
      const answerSession = `t-pr-${request.id}-${request.attempts + 1}`;
      const claimed = await projectRequestClaim(request.id, answerSession, profile.id).catch(() => null);
      if (!claimed || cancelled) return;
      const label = `Pregunta de ${request.fromName}`;
      const options: ChatSessionOptions = {
        ...launchForProfile(current, profile),
        sessionId: answerSession, cwd: project.path, conversationId: null, chatLabel: `${profile.name} · ${label}`,
        mode: "plan", model: null, effort: null, fast: null, planningOnly: true, planningInstruction: ANSWER_POLICY,
        integrations: current.integrations, autoCompact: current.autoCompact, desktopEnabled: false, a11yEnabled: false,
        visible: true, onRunning: noop, onExit: noop,
      };
      runnersMap.set(request.id, { request: claimed, provider: profile.provider as Provider, label, options, claimedAt: Date.now(),
        phase: "starting", sentAt: 0, previous: null, users: new Set() });
      changed();
    };

    const tick = async (): Promise<void> => {
      if (ticking || cancelled) return;
      ticking = true;
      try {
        const snapshot = await projectRequestsSnapshot();
        if (cancelled) return;
        projectRequestsStore.set(snapshot);
        watchOrphans(snapshot);
        watchChanges(snapshot);
        for (const runner of [...runnersMap.values()]) await advance(runner, snapshot);
        for (const request of snapshot.filter(entry => entry.status === "queued").sort((a, b) => a.createdAt - b.createdAt)) {
          if (cancelled || runnersMap.size >= MAX_ACTIVE) break;
          await start(request);
        }
      } catch (error) {
        console.warn(`Preguntas entre proyectos: ${formatError(error)}`);
      } finally { ticking = false; }
    };

    let timer: number | undefined;
    const changes = !recoveredChanges;
    recoveredChanges = true;
    void projectRequestsRecover(changes).catch(() => undefined).finally(() => {
      if (cancelled) return;
      void tick();
      timer = window.setInterval(() => void tick(), TICK_MS);
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      runnersMap.clear();
      projectRequestsStore.set([]);
    };
  }, []);

  return <>{runners.map(runner => {
    const Runtime = RUNTIMES[runner.provider];
    return <Runtime key={runner.request.id} id={runner.request.id} label={runner.label} options={runner.options} publish={publish} />;
  })}</>;
}

export default memo(ProjectRequestsHost);
