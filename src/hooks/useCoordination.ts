/**
 * Una sesión de chat dentro del registro de coordinación de su proyecto: late
 * mientras su proceso está listo, anota las ediciones que hace y muestra en su
 * hilo los avisos que le dejan (choques detectados por trex o mensajes de otras
 * sesiones). Los avisos siguen pendientes hasta que llegan al modelo: con el
 * siguiente mensaje (`pending` + `delivered`) o con trex_peers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { chatTasks } from "../chatTasks";
import {
  coordinationAckNotes, coordinationHub, coordinationRecordEdits, newEdits, notesFor, type PeerBoard, type PeerNote, type Presence,
} from "../coordination";
import type { ChatSession } from "./chatSession";

export type Coordination = {
  session: string;
  project: string;
  /** Registro del proyecto; null mientras la sesión no está registrada. */
  board: PeerBoard | null;
  /** Avisos pendientes de esta sesión, leídos al momento (para el mensaje que se va a enviar). */
  pending: () => Promise<PeerNote[]>;
  /** Avisos que ya llegaron al modelo: se borran del registro. */
  delivered: (ids: string[]) => void;
  /** Muestra un aviso en el hilo una sola vez (mensajes que no pueden despertar al chat). */
  announce: (note: PeerNote, text: string) => void;
};

/** Avisos ya mostrados en algún hilo: una pestaña que se vuelve a montar no los repite. */
const shown = new Set<string>();
const remember = (id: string): boolean => {
  if (shown.has(id)) return false;
  shown.add(id);
  if (shown.size > 500) shown.delete(shown.values().next().value!);
  return true;
};

/**
 * `autoReply`: el chat contesta solo a los mensajes de otras sesiones (ChatView los
 * entrega en un turno automático y los pinta como tarjeta), así que no se anuncian al llegar.
 */
export function useCoordination(session: ChatSession, identity: { id: string; project: string; label: string; enabled?: boolean; autoReply?: boolean }): Coordination {
  const { id, project, label } = identity;
  const autoReply = identity.autoReply === true;
  const live = identity.enabled !== false && session.state.process === "ready" && !!project;
  const [board, setBoard] = useState<PeerBoard | null>(null);
  const boardRef = useRef(board);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const labelRef = useRef(label);
  labelRef.current = label;
  /** Herramientas ya revisadas: lo que ya estaba al entrar (historial incluido) no cuenta como edición nueva. */
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!live) { setBoard(null); boardRef.current = null; return; }
    const ids = new Set<string>();
    newEdits(sessionRef.current.state.items, ids);
    seen.current = ids;
    const presence = (): Presence => {
      const state = sessionRef.current.state;
      const task = chatTasks(state.items.slice(state.historyCount), labelRef.current).find(entry => entry.status === "in_progress")?.title ?? null;
      return { id, label: labelRef.current, agent: sessionRef.current.provider, task, working: state.pendingTurns > 0 };
    };
    const listener = (next: PeerBoard): void => {
      boardRef.current = next;
      setBoard(next);
      for (const note of notesFor(next, id)) {
        if (autoReply && note.kind === "message") continue;
        if (remember(note.id)) sessionRef.current.notice(note.kind === "message" ? "info" : "warn", note.text);
      }
    };
    const leave = coordinationHub.join(project, id, { presence, listener });
    return () => { seen.current = null; leave(); };
  }, [live, project, id, autoReply]);

  // Ediciones nuevas de esta sesión (solo las del hilo en vivo, no las del historial cargado).
  const { items, historyCount } = session.state;
  useEffect(() => {
    const ids = seen.current;
    if (!live || !ids) return;
    const paths = newEdits(items.slice(historyCount), ids);
    if (!paths.length) return;
    void coordinationRecordEdits(project, id, paths)
      .then(() => coordinationHub.refresh(project))
      .catch(() => undefined);
  }, [live, items, historyCount, project, id]);

  const pending = useCallback(async (): Promise<PeerNote[]> => {
    if (!boardRef.current) return [];
    await coordinationHub.refresh(project);
    return notesFor(boardRef.current, id);
  }, [project, id]);

  const delivered = useCallback((ids: string[]): void => {
    if (!ids.length) return;
    void coordinationAckNotes(project, id, ids).then(() => coordinationHub.refresh(project)).catch(() => undefined);
  }, [project, id]);

  const announce = useCallback((note: PeerNote, text: string): void => {
    if (remember(note.id)) sessionRef.current.notice("info", text);
  }, []);

  return { session: id, project, board, pending, delivered, announce };
}
