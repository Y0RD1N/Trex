/**
 * Coordinación entre las sesiones de un mismo proyecto.
 *
 * Capa 1, automática: trex ve las ediciones de cada sesión (Edit, Write,
 * Delete, Move…) y las anota en un registro por proyecto; si dos sesiones vivas
 * tocan el mismo archivo, las dos reciben un aviso en la interfaz y una nota
 * que llega al modelo con su siguiente mensaje (o al llamar a trex_peers).
 * Capa 2, con los agentes: las herramientas trex_peers, trex_claim,
 * trex_release y trex_message (las sirve `coordination.rs`).
 * Conversación: un mensaje de otra sesión despierta al chat que está libre
 * para que lo lea y conteste (`PEER_WAKE`); seis turnos automáticos seguidos
 * en el proyecto pausan la charla hasta que la persona intervenga.
 *
 * Nada se bloquea ni espera: avisar y dejar editar.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ChatItem, Json } from "./chatState";

export type PeerSession = { id: string; label: string; agent: string; task: string | null; working: boolean; seen: number };
export type PeerClaim = { id: string; session: string; holder: string; kind: "path" | "resource"; name: string; reason: string; at: number; expires: number };
export type PeerNote = { id: string; to: string; from: string; fromLabel: string; kind: "conflict" | "message"; path: string | null; text: string; at: number };
export type PeerBoard = { sessions: PeerSession[]; claims: PeerClaim[]; notes: PeerNote[] };
export type Presence = { id: string; label: string; agent: string; task: string | null; working: boolean };

export const COORDINATION_TOOLS = ["trex_peers", "trex_claim", "trex_release", "trex_message"] as const;
export const isCoordinationTool = (name: unknown): boolean => (COORDINATION_TOOLS as readonly unknown[]).includes(name);

/**
 * Lo que se añade a las instrucciones del asistente. Una sola línea, sin
 * comillas dobles ni `\`: viaja como argumento del CLI. Breve: las
 * instrucciones de Codex tienen un presupuesto y cada herramienta explica su uso.
 */
export const PEER_INSTRUCTIONS = "Other Trex sessions may share this project: check trex_peers, reserve what you change with trex_claim, "
  + "free it with trex_release, agree via trex_message; never wait for a peer.";

/** El turno con el que trex despierta a una sesión libre que recibió un mensaje (va detrás de los avisos). */
export const PEER_WAKE = "Trex: another session in this project wrote to you (notes above). Reply with trex_message only if it needs an answer "
  + "or a decision from you, then continue your work or end your turn. Do not wait or poll for replies: Trex wakes you when one arrives.";

// --- Ediciones -------------------------------------------------------------------

// Claude, Codex y Antigravity usan estos nombres; Trex CLI agrupa sus cambios en TrexPatch y
// conserva los nombres nativos de editar, renombrar y borrar (con `path` y `destination`).
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "Delete", "Move", "NotebookEdit", "TrexPatch", "edit_file", "rename_file", "remove_file"]);
const str = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/** Rutas que cambia una herramienta de edición (Move cambia el origen y el destino; TrexPatch, varios archivos). */
export function editPaths(name: string, input: Json): string[] {
  if (!EDIT_TOOLS.has(name)) return [];
  const files = Array.isArray(input.files) ? input.files.map(file => file && typeof file === "object" ? str((file as Json).file_path) : "") : [];
  return [str(input.file_path) || str(input.notebook_path) || str(input.path), str(input.destination), ...files].filter(Boolean);
}

/**
 * Ediciones terminadas que aún no se anotaron. `seen` guarda las herramientas
 * ya revisadas: una que sigue en marcha se vuelve a mirar en la siguiente pasada.
 */
export function newEdits(items: readonly ChatItem[], seen: Set<string>): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || seen.has(item.id) || item.status === "running") continue;
    seen.add(item.id);
    if (item.status === "done") paths.push(...editPaths(item.name, item.input));
  }
  return [...new Set(paths)];
}

// --- Avisos ------------------------------------------------------------------------

const NOTES_START = "[Trex · otras sesiones de este proyecto]";
const NOTES_END = "[/Trex]";

/** Bloque que precede al mensaje del usuario con los avisos pendientes de la sesión. */
export function notesBlock(notes: readonly PeerNote[]): string {
  if (!notes.length) return "";
  return [NOTES_START, ...notes.map(note => `- ${note.text}`), NOTES_END].join("\n");
}

/** El mensaje que ve el modelo: avisos pendientes y, detrás, lo que escribió la persona. */
export const withNotes = (notes: readonly PeerNote[], text: string): string => notes.length ? `${notesBlock(notes)}\n\n${text}` : text;

/**
 * Quita el bloque de avisos de un mensaje (al pintar un historial que lo incluye).
 * Un turno automático (`PEER_WAKE`) conserva solo los avisos: se pinta como
 * mensaje de otra sesión, igual que cuando llegó.
 */
export function withoutNotes(text: string): string {
  if (!text.startsWith(NOTES_START)) return text;
  const end = text.indexOf(NOTES_END);
  if (end < 0) return text;
  const rest = text.slice(end + NOTES_END.length).replace(/^\s+/, "");
  return rest === PEER_WAKE ? text.slice(0, end + NOTES_END.length) : rest;
}

/** Los avisos de un turno que trajo mensajes de otras sesiones; null si es un mensaje de la persona. */
export function peerTurnNotes(text: string): string[] | null {
  const body = text.trim();
  if (!body.startsWith(NOTES_START) || !body.endsWith(NOTES_END)) return null;
  const notes: string[] = [];
  for (const line of body.slice(NOTES_START.length, -NOTES_END.length).trim().split("\n")) {
    if (line.startsWith("- ") || !notes.length) notes.push(line.replace(/^- /, ""));
    else notes[notes.length - 1] += `\n${line}`;
  }
  return notes.filter(note => note.trim());
}

/** Un aviso del bloque, separado en quién escribe y qué dice (los choques no tienen remitente). */
export function peerNoteParts(note: string): { age: string; from: string | null; text: string } {
  const message = /^(.+?) · mensaje de «(.+?)»: ([\s\S]*)$/.exec(note);
  if (message) return { age: message[1], from: message[2], text: message[3] };
  const conflict = /^(Hace [^·]+?) · ([\s\S]*)$/.exec(note);
  return conflict ? { age: conflict[1], from: null, text: conflict[2] } : { age: "", from: null, text: note };
}

/** Avisos para una sesión, del más antiguo al más reciente. */
export const notesFor = (board: PeerBoard | null, session: string): PeerNote[] =>
  (board?.notes ?? []).filter(note => note.to === session).sort((a, b) => a.at - b.at);

/** Las otras sesiones vivas del proyecto. */
export const peersOf = (board: PeerBoard | null, session: string): PeerSession[] =>
  (board?.sessions ?? []).filter(peer => peer.id !== session);

// --- Backend -------------------------------------------------------------------------

export const coordinationSync = (project: string, sessions: Presence[]): Promise<PeerBoard> => invoke("coordination_sync", { project, sessions });
export const coordinationLeave = (project: string, session: string): Promise<void> => invoke("coordination_leave", { project, session });
export const coordinationRecordEdits = (project: string, session: string, paths: string[]): Promise<unknown[]> =>
  invoke("coordination_record_edits", { project, session, paths });
export const coordinationAckNotes = (project: string, session: string, ids: string[]): Promise<void> =>
  invoke("coordination_ack_notes", { project, session, ids });
export const coordinationRelease = (project: string, claim: string): Promise<void> => invoke("coordination_release", { project, claim });
export const coordinationCall = (project: string, session: string, name: string, args: unknown): Promise<Json> =>
  invoke("coordination_call", { project, session, name, arguments: args ?? {} });

let toolsList: Promise<Json[]> | null = null;
/** Definiciones MCP de las herramientas (las mismas que lista el servidor de Codex). */
export const coordinationTools = (): Promise<Json[]> => {
  const pending = toolsList ??= invoke<Json[]>("coordination_tools");
  pending.catch(() => { toolsList = null; });
  return pending;
};

// --- Latido compartido ---------------------------------------------------------------

/** Cada cuánto se late y se lee el registro de un proyecto con sesiones vivas. */
export const SYNC_MS = 5_000;
/** Turnos automáticos seguidos (mensajes entre agentes) antes de pausar y esperar a la persona. */
export const WAKE_LIMIT = 6;

type Member = { presence: () => Presence | null; listener: (board: PeerBoard) => void };
type Project = { members: Map<string, Member>; timer: ReturnType<typeof setTimeout> | null; running: Promise<void> | null; again: boolean };

/**
 * Un solo latido por proyecto para todas sus sesiones: una llamada cada
 * `SYNC_MS` registra a las vivas y devuelve el registro a cada una.
 */
export class CoordinationHub {
  private projects = new Map<string, Project>();
  private wakes = new Map<string, number>();

  constructor(
    private readonly sync: typeof coordinationSync = coordinationSync,
    private readonly leave: typeof coordinationLeave = coordinationLeave,
    private readonly schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout> = (run, ms) => setTimeout(run, ms),
    private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void = timer => clearTimeout(timer),
  ) {}

  /** Da de alta una sesión; devuelve cómo darla de baja (la saca del registro y suelta sus reservas). */
  join(project: string, session: string, member: Member): () => void {
    let entry = this.projects.get(project);
    if (!entry) this.projects.set(project, entry = { members: new Map(), timer: null, running: null, again: false });
    entry.members.set(session, member);
    void this.refresh(project);
    return () => {
      const current = this.projects.get(project);
      if (current?.members.get(session) !== member) return;
      current.members.delete(session);
      void this.leave(project, session).catch(() => undefined);
      if (!current.members.size) {
        if (current.timer) this.cancel(current.timer);
        this.projects.delete(project);
      }
    };
  }

  /** Late y lee ya (tras una edición o al entrar), sin esperar al siguiente turno del temporizador. */
  refresh(project: string): Promise<void> {
    const entry = this.projects.get(project);
    if (!entry) return Promise.resolve();
    if (entry.running) { entry.again = true; return entry.running; }
    if (entry.timer) { this.cancel(entry.timer); entry.timer = null; }
    const presences = [...entry.members.values()].map(member => member.presence()).filter((p): p is Presence => !!p);
    entry.running = (presences.length ? this.sync(project, presences) : Promise.resolve(null))
      .then(board => { if (board) for (const member of entry.members.values()) member.listener(board); })
      .catch(() => undefined)
      .finally(() => {
        entry.running = null;
        if (this.projects.get(project) !== entry) return;
        if (entry.again) { entry.again = false; void this.refresh(project); return; }
        entry.timer = this.schedule(() => { entry.timer = null; void this.refresh(project); }, SYNC_MS);
      });
    return entry.running;
  }

  /** Gasta un turno automático del proyecto; false si la conversación entre agentes está en pausa. */
  spendWake(project: string): boolean {
    const used = this.wakes.get(project) ?? 0;
    if (used >= WAKE_LIMIT) return false;
    this.wakes.set(project, used + 1);
    return true;
  }

  /** Los agentes ya se escribieron `WAKE_LIMIT` veces seguidas sin que la persona interviniera. */
  paused(project: string): boolean {
    return (this.wakes.get(project) ?? 0) >= WAKE_LIMIT;
  }

  /** La persona intervino (escribió o pulsó «Dejar que sigan»): la cuenta vuelve a empezar. */
  resetWakes(project: string): void {
    const paused = this.paused(project);
    if (!this.wakes.delete(project)) return;
    // Al salir de la pausa, cada chat vuelve a mirar sus mensajes pendientes con el registro nuevo.
    if (paused) void this.refresh(project);
  }
}

export const coordinationHub = new CoordinationHub();
