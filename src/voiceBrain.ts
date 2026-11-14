/**
 * Cerebro del modo llamada: qué se le cuenta a Claude de una orden hablada, qué puede
 * pedir que haga trex y cómo se ejecuta. Sin Tauri ni React, para poder probarlo; el
 * proceso de Claude lo lanza `src-tauri/src/voice_brain.rs` y lo conecta `useVoiceCall`.
 */
import type { RemoteDetail, RemoteSession } from "./remoteProtocol";

export type BrainProject = { id: string; name: string; path: string };

/** Una sesión tal como se le describe a Claude: con un alias corto en vez de su id. */
export type BrainSession = {
  ref: string;
  project: string;
  title: string;
  agent: string;
  status: string;
  needs: string | null;
  doing: string | null;
  tasks: string | null;
  lastReply: string | null;
  minutesAgo: number;
};

export type BrainAction =
  | { tool: "select_project"; project: string }
  | { tool: "open_session"; project: string; message: string | null }
  | { tool: "send_message"; session: string; text: string }
  | { tool: "interrupt"; session: string }
  | { tool: "summarize"; hours: number; project: string | null };

export type BrainReply = { say: string; actions: BrainAction[] };
export type BrainExchange = { you: string; trex: string };

export const BRAIN_SYSTEM = [
  "Eres trex, el asistente de voz de una app de escritorio donde una persona trabaja con agentes de programación (Claude Code y otros) en varios proyectos.",
  "Recibes lo que la persona dijo en voz alta, transcrito por un reconocedor que comete errores: interpreta nombres de proyectos y palabras técnicas por parecido de sonido. «cloud», «clod», «clot» o «clau» casi siempre son Claude.",
  "Respondes con `say` (lo que dirás en voz alta) y `actions` (lo que trex hará).",
  "",
  "Acciones disponibles:",
  "- select_project {project}: muestra ese proyecto.",
  "- open_session {project, message?}: abre una sesión nueva de Claude Code en ese proyecto; con `message`, se lo envía como primera instrucción.",
  "- send_message {session, text}: envía una instrucción a una sesión abierta (usa su `ref`, por ejemplo \"s2\"). Redacta `text` como una instrucción clara para un agente de programación, sin añadir condiciones ni tareas que la persona no dijo.",
  "- interrupt {session}: detiene lo que esa sesión está haciendo.",
  "- summarize {hours, project?}: úsala cuando pidan un resumen de lo trabajado (anoche, hoy, esta semana). trex reunirá los datos y hará el resumen; en ese caso deja `say` vacío.",
  "",
  "Reglas:",
  "- `say` es para el oído: una o dos frases cortas en español, sin listas, sin símbolos, sin rutas ni código.",
  "- Para preguntas sobre cómo va un proyecto o una sesión, contesta tú con el estado que recibes; no hace falta ninguna acción.",
  "- Usa en `project` el nombre exacto de la lista de proyectos. Si no sabes a cuál se refieren, pregunta en `say` y no hagas nada.",
  "- No puedes aprobar permisos ni responder preguntas de los agentes: si una sesión necesita eso, dilo y pide que lo revisen en pantalla.",
  "- Si lo que oyes no parece dirigido a ti o no se entiende, di que no lo entendiste en pocas palabras y no hagas nada.",
  "- No inventes proyectos, sesiones ni resultados.",
].join("\n");

export const BRAIN_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    say: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string", enum: ["select_project", "open_session", "send_message", "interrupt", "summarize"] },
          project: { type: "string" },
          session: { type: "string" },
          text: { type: "string" },
          message: { type: "string" },
          hours: { type: "number" },
        },
        required: ["tool"],
      },
    },
  },
  required: ["say", "actions"],
});

export const SUMMARY_SYSTEM = [
  "Eres trex, un asistente de voz. Te dan lo que se trabajó en los proyectos de una persona durante un periodo: commits y el estado de las sesiones de sus agentes de programación.",
  "Haz en `say` un resumen para escuchar mientras hace otra cosa: de tres a seis frases en español, sin listas, sin símbolos, sin rutas ni código.",
  "Di primero lo más importante que se avanzó, luego lo que quedó pendiente o necesita su atención. Si no hubo actividad, dilo en una frase. No inventes nada que no esté en los datos.",
].join("\n");

export const SUMMARY_SCHEMA = JSON.stringify({ type: "object", properties: { say: { type: "string" } }, required: ["say"] });

const clip = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const STATUS_LABEL: Record<RemoteSession["status"], string> = {
  needs: "esperando tu respuesta",
  working: "trabajando",
  idle: "en reposo",
  exited: "cerrada",
};

/** Describe las sesiones abiertas para Claude y devuelve a qué id real apunta cada alias. */
export function describeSessions(
  sessions: RemoteSession[],
  detailOf: (id: string) => RemoteDetail | null,
  now: number,
): { sessions: BrainSession[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const described = [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 24)
    .map((session, index) => {
      const ref = `s${index + 1}`;
      ids.set(ref, session.id);
      const detail = detailOf(session.id);
      const tasks = detail && detail.tasks.total > 0
        ? `${detail.tasks.done} de ${detail.tasks.total} tareas${detail.tasks.current ? `; ahora: ${clip(detail.tasks.current, 120)}` : ""}`
        : null;
      let lastReply: string | null = null;
      for (const item of detail?.items ?? []) if (item.kind === "text" && item.text.trim()) lastReply = clip(item.text, 400);
      return {
        ref,
        project: session.project.name,
        title: clip(session.title, 80),
        agent: session.model ? `${session.agent} · ${session.model}` : session.agent,
        status: STATUS_LABEL[session.status],
        needs: session.need ? clip(session.need.label, 160) : null,
        doing: session.activity ? clip(session.activity, 160) : null,
        tasks,
        lastReply,
        minutesAgo: session.updatedAt ? Math.max(0, Math.round((now - session.updatedAt) / 60000)) : 0,
      };
    });
  return { sessions: described, ids };
}

export function brainPrompt(input: {
  now: Date;
  projects: BrainProject[];
  activeProject: string | null;
  sessions: BrainSession[];
  history: BrainExchange[];
  command: string;
}): string {
  const state = {
    ahora: input.now.toLocaleString("es", { weekday: "long", hour: "2-digit", minute: "2-digit" }),
    proyectos: input.projects.map(project => project.name),
    proyecto_a_la_vista: input.activeProject,
    sesiones_abiertas: input.sessions,
  };
  const history = input.history.length
    ? `Conversación reciente:\n${input.history.map(turn => `- Persona: ${turn.you}\n  trex: ${turn.trex}`).join("\n")}\n\n`
    : "";
  return `Estado de trex:\n${JSON.stringify(state, null, 1)}\n\n${history}La persona acaba de decir: «${input.command}»`;
}

/** Valida lo que devolvió Claude: nunca se confía en la forma. Lo que no encaja se descarta. */
export function parseBrainReply(value: unknown): BrainReply {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (field: unknown): string => (typeof field === "string" ? field.trim() : "");
  const actions: BrainAction[] = [];
  for (const entry of Array.isArray(raw.actions) ? raw.actions.slice(0, 6) : []) {
    if (!entry || typeof entry !== "object") continue;
    const action = entry as Record<string, unknown>;
    const project = text(action.project);
    const session = text(action.session);
    if (action.tool === "select_project" && project) actions.push({ tool: "select_project", project });
    else if (action.tool === "open_session" && project) actions.push({ tool: "open_session", project, message: text(action.message) || null });
    else if (action.tool === "send_message" && session && text(action.text)) actions.push({ tool: "send_message", session, text: text(action.text) });
    else if (action.tool === "interrupt" && session) actions.push({ tool: "interrupt", session });
    else if (action.tool === "summarize") {
      const hours = typeof action.hours === "number" && Number.isFinite(action.hours) ? action.hours : 12;
      actions.push({ tool: "summarize", hours: Math.max(1, Math.min(24 * 14, Math.round(hours))), project: project || null });
    }
  }
  return { say: text(raw.say), actions };
}

const plain = (value: string): string =>
  value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Encuentra el proyecto que Claude nombró: exacto primero, luego por inclusión si solo hay uno. */
export function matchProject<T extends { name: string }>(name: string, projects: T[]): T | null {
  const wanted = plain(name);
  if (!wanted) return null;
  const exact = projects.filter(project => plain(project.name) === wanted);
  if (exact.length) return exact[0];
  const partial = projects.filter(project => {
    const candidate = plain(project.name);
    return candidate.length > 0 && (candidate.includes(wanted) || wanted.includes(candidate));
  });
  return partial.length === 1 ? partial[0] : null;
}

/** Lo que el cerebro puede tocar de trex. `useVoiceCall` lo conecta a la app real. */
export type BrainDeps = {
  projects: BrainProject[];
  /** Alias de sesión (\"s2\") → id real, de `describeSessions`. */
  sessionIds: Map<string, string>;
  selectProject: (projectId: string) => void;
  /** Abre una sesión de Claude Code y devuelve su id, o null si no se pudo. */
  openSession: (projectId: string) => string | null;
  /** Espera a que la sesión recién abierta pueda recibir mensajes. */
  sessionReady: (sessionId: string) => Promise<boolean>;
  send: (sessionId: string, text: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
};

export type BrainOutcome = {
  /** Lo que no se pudo hacer, en frases para decir en voz alta. */
  problems: string[];
  /** Se pidió un resumen: lo prepara quien llama. */
  summarize: { hours: number; project: BrainProject | null } | null;
};

export async function runBrainActions(actions: BrainAction[], deps: BrainDeps): Promise<BrainOutcome> {
  const outcome: BrainOutcome = { problems: [], summarize: null };
  const fail = (problem: string) => { outcome.problems.push(problem); };
  for (const action of actions) {
    try {
      if (action.tool === "select_project" || action.tool === "open_session") {
        const project = matchProject(action.project, deps.projects);
        if (!project) { fail(`No encontré el proyecto ${action.project}.`); continue; }
        if (action.tool === "select_project") { deps.selectProject(project.id); continue; }
        const session = deps.openSession(project.id);
        if (!session) { fail(`No pude abrir una sesión en ${project.name}.`); continue; }
        if (action.message) {
          if (await deps.sessionReady(session)) await deps.send(session, action.message);
          else fail("La sesión se abrió, pero no llegó a estar lista para recibir el mensaje.");
        }
      } else if (action.tool === "send_message" || action.tool === "interrupt") {
        const session = deps.sessionIds.get(action.session.toLowerCase());
        if (!session) { fail("No encontré esa sesión."); continue; }
        if (action.tool === "send_message") await deps.send(session, action.text);
        else await deps.interrupt(session);
      } else {
        const project = action.project ? matchProject(action.project, deps.projects) : null;
        outcome.summarize = { hours: action.hours, project };
      }
    } catch (failure) {
      fail(failure instanceof Error ? failure.message : String(failure));
    }
  }
  return outcome;
}

export type SummaryProject = { name: string; commits: string[]; sessions: BrainSession[] };

export function summaryPrompt(hours: number, projects: SummaryProject[]): string {
  const period = hours >= 48 ? `los últimos ${Math.round(hours / 24)} días` : `las últimas ${hours} horas`;
  const active = projects.filter(project => project.commits.length > 0 || project.sessions.length > 0);
  if (!active.length) return `Periodo: ${period}. No hay commits ni sesiones abiertas en ningún proyecto.`;
  return `Periodo: ${period}.\n${JSON.stringify(active.map(project => ({
    proyecto: project.name,
    commits: project.commits.slice(0, 25),
    sesiones: project.sessions.map(({ ref: _ref, project: _project, ...rest }) => rest),
  })), null, 1)}`;
}

/** Frases con las que la persona da por terminada la conversación. */
export function isGoodbye(command: string): boolean {
  return /^(gracias|muchas gracias|eso es todo|nada mas|adios|hasta luego|ya esta)( trex)?$/.test(plain(command));
}

/** Une la respuesta de Claude con lo que falló, para decirlo de una vez. */
export function spokenReply(say: string, problems: string[]): string {
  return [say, ...problems].map(part => part.trim()).filter(Boolean).join(" ");
}
