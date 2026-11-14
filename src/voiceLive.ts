/**
 * Modo en tiempo real (Gemini Live): lo que la app hace cuando el modelo pide una
 * herramienta. La conexión y el audio viven en `src-tauri/src/voice_live.rs`; aquí solo
 * se ejecutan las acciones, por el mismo camino y con la misma validación que el modo
 * local (`voiceBrain.ts`). Sin Tauri ni React, para poder probarlo.
 */
import type { RemoteDetail, RemoteSession } from "./remoteProtocol";
import { describeSessions, matchProject, parseBrainReply, runBrainActions, type BrainDeps, type BrainProject, type BrainSession, type SummaryProject } from "./voiceBrain";

/** Lo que cuenta Rust de una llamada en curso (`voice://live`). */
export type VoiceLiveEvent =
  | { kind: "state"; state: "connecting" | "talking" | "ended"; reason?: string; error?: string }
  | { kind: "heard"; text: string }
  | { kind: "said"; text: string }
  | { kind: "interrupted" }
  | { kind: "turn" };

export type VoiceToolRequest = { id: string; name: string; args: unknown };

/**
 * Alias estables de sesión durante una llamada. En el modo local cada orden describe las
 * sesiones de nuevo; aquí el modelo recuerda «s2» de una respuesta anterior, así que ese
 * alias debe seguir apuntando a la misma sesión aunque cambie el orden.
 */
export class SessionRefs {
  private byId = new Map<string, string>();
  private byRef = new Map<string, string>();

  refOf(id: string): string {
    let ref = this.byId.get(id);
    if (!ref) {
      ref = `s${this.byId.size + 1}`;
      this.byId.set(id, ref);
      this.byRef.set(ref, id);
    }
    return ref;
  }

  /** Alias → id real, en el formato que espera `runBrainActions`. */
  ids(): Map<string, string> { return new Map(this.byRef); }
}

/** Describe las sesiones abiertas con sus alias estables. */
export function liveSessions(
  sessions: RemoteSession[],
  detailOf: (id: string) => RemoteDetail | null,
  refs: SessionRefs,
  now: number,
): BrainSession[] {
  const described = describeSessions(sessions, detailOf, now);
  return described.sessions.map(session => ({ ...session, ref: refs.refOf(described.ids.get(session.ref) ?? session.ref) }));
}

export type LiveToolDeps = Omit<BrainDeps, "sessionIds"> & {
  activeProject: string | null;
  sessions: () => BrainSession[];
  refs: SessionRefs;
  /** Commits de un proyecto en las últimas `hours` horas. */
  commits: (project: BrainProject, hours: number) => Promise<string[]>;
};

type ToolResult = Record<string, unknown>;

const status = (deps: LiveToolDeps): ToolResult => ({
  proyectos: deps.projects.map(project => project.name),
  proyecto_a_la_vista: deps.activeProject,
  sesiones_abiertas: deps.sessions(),
});

/** Ejecuta una herramienta pedida por el modelo. Nunca lanza: un fallo vuelve como `error` para que lo diga. */
export async function runLiveTool(name: string, args: unknown, deps: LiveToolDeps): Promise<ToolResult> {
  try {
    const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    if (name === "get_status") return status(deps);
    if (name === "recent_work") {
      const [action] = parseBrainReply({ actions: [{ tool: "summarize", hours: input.hours, project: input.project }] }).actions;
      if (!action || action.tool !== "summarize") return { error: "No entendí el periodo." };
      const only = action.project ? matchProject(action.project, deps.projects) : null;
      if (action.project && !only) return { error: `No encontré el proyecto ${action.project}.` };
      const sessions = deps.sessions();
      const projects: SummaryProject[] = await Promise.all((only ? [only] : deps.projects).map(async project => ({
        name: project.name,
        commits: (await deps.commits(project, action.hours)).slice(0, 25),
        sessions: sessions.filter(session => session.project === project.name),
      })));
      return { horas: action.hours, proyectos: projects.filter(project => project.commits.length > 0 || project.sessions.length > 0) };
    }
    // El resto son las mismas acciones del modo local: pasan por su validación.
    const [action] = parseBrainReply({ actions: [{ ...input, tool: name }] }).actions;
    if (!action || action.tool === "summarize") return { error: "Esa acción no existe o le faltan datos." };
    // Para que el alias de una sesión nueva exista aunque el modelo no haya pedido el estado.
    deps.sessions();
    const outcome = await runBrainActions([action], { ...deps, sessionIds: deps.refs.ids() });
    return outcome.problems.length ? { error: outcome.problems.join(" ") } : { ok: true };
  } catch (failure) {
    return { error: failure instanceof Error ? failure.message : String(failure) };
  }
}

/** Texto corto para el indicador: lo último que se dijo en la llamada. */
export function liveCaption(current: string, piece: string, max = 160): string {
  const joined = `${current}${piece}`.replace(/\s+/g, " ").trimStart();
  return joined.length > max ? `…${joined.slice(joined.length - max + 1)}` : joined;
}

/** Por qué terminó la llamada, en una frase para la persona; vacío si fue lo normal. */
export function liveEndMessage(event: Extract<VoiceLiveEvent, { kind: "state" }>): string {
  if (event.error) return event.error;
  return event.reason === "idle" ? "La llamada se cerró por silencio." : "";
}
