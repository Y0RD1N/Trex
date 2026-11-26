/**
 * Encargos de otros proyectos para este chat (`trex_request_change`, ya aprobados por la persona):
 * cuando el chat está libre, trex le pasa el encargo como un turno a la vista; al terminar ese turno
 * guarda su mensaje final como informe, con los archivos que editó (medidos aquí, de sus herramientas)
 * y lo que gastó. Lo que el chat ya estaba haciendo no se interrumpe: el encargo espera su turno.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { editPaths } from "../coordination";
import { sanitizeHandoffText } from "../handoff";
import {
  changePrompt, changeDisplay, changeTurn, finalReply, persist, projectRequestBegin, projectRequestFinish, projectRequestsStore, type ProjectRequest,
} from "../projectRequests";
import { subtractApiUsage, usageTotals, type ApiUsage } from "../tokenUsage";
import type { ChatItem } from "../chatState";
import type { ChatSession } from "./chatSession";

const EMPTY: readonly ProjectRequest[] = [];
/** Si el diario no deja empezarlo (p. ej., aún guarda el anterior), se vuelve a probar al rato. */
const RETRY_MS = 2_000;

/** `usage`: lo gastado al empezar; `undefined` si se retomó a medias (entonces no se sabe cuánto gastó). */
type Tracking = { id: string; to: string; usage: ApiUsage | null | undefined; sending: boolean };

/** El mensaje con el que llegó el encargo al hilo: su turno es el que lo termina. */
const changeItem = (items: readonly ChatItem[], id: string): string | null =>
  items.find(item => item.kind === "user" && changeTurn(item.text)?.id === id)?.id ?? null;

export type IncomingChanges = {
  requests: readonly ProjectRequest[];
  /** Un encargo se está enviando ahora mismo: los demás turnos automáticos esperan. */
  sending: () => boolean;
};

/**
 * `free`: el chat puede recibir un turno ahora (sin turno en curso, cola ni traspasos pendientes).
 * `visible` y `onWake`: una pestaña restaurada que no se ha mostrado arranca para recibirlo.
 * `busy`: otro turno automático (mensajes de otras sesiones, respuestas) salió en este mismo momento.
 */
export function useIncomingChanges(chat: ChatSession, session: string | null,
  options: { free: boolean; visible: boolean; onWake?: () => void; busy?: () => boolean }): IncomingChanges {
  const all = useSyncExternalStore(projectRequestsStore.subscribe, projectRequestsStore.get);
  const mine = useMemo(() => {
    const list = session ? all.filter(request => request.kind === "change" && request.toSession === session && (request.status === "approved" || request.status === "running")) : EMPTY;
    return list.length ? list : EMPTY;
  }, [all, session]);
  const tracking = useRef<Tracking | null>(null);
  /** Encargos que este chat ya empezó o terminó: el diario tarda una vuelta en reflejarlo. */
  const handled = useRef(new Set<string>());
  /** Guardando el informe del anterior: el siguiente no empieza hasta que el diario lo tenga. */
  const saving = useRef<Promise<unknown> | null>(null);
  const retryAt = useRef(0);
  const { state } = chat;
  const { free, visible, onWake } = options;
  const busy = useRef(options.busy);
  busy.current = options.busy;

  const waiting = mine.some(request => request.status === "approved" && !handled.current.has(request.id));
  useEffect(() => { if (waiting && !visible && state.process === "starting") onWake?.(); }, [waiting, visible, state.process, onWake]);

  // Empieza el siguiente cuando el chat queda libre.
  useEffect(() => {
    if (!session || tracking.current || saving.current) return;
    // En marcha y sin seguimiento: el chat se volvió a montar a medias (p. ej., al moverlo a otro panel).
    // Se retoma desde su mensaje en el hilo; hasta que aparezca, se espera (si nunca aparece, caduca solo).
    const lost = mine.find(request => request.status === "running" && !handled.current.has(request.id));
    if (lost) {
      if (!changeItem(state.items, lost.id)) return;
      handled.current.add(lost.id);
      tracking.current = { id: lost.id, to: lost.toName, usage: undefined, sending: false };
      return;
    }
    const next = mine.find(request => request.status === "approved" && !handled.current.has(request.id));
    if (!next || !free || state.process !== "ready" || !chat.queue.ready || busy.current?.() || Date.now() < retryAt.current) return;
    handled.current.add(next.id);
    const track: Tracking = { id: next.id, to: next.toName, usage: state.apiUsage, sending: true };
    tracking.current = track;
    void (async () => {
      const begun = await projectRequestBegin(next.id, session).catch(() => null);
      if (!begun) {
        // Ya no le toca (cancelado) o el diario no estaba listo: si sigue aprobado, se vuelve a intentar.
        tracking.current = null;
        handled.current.delete(next.id);
        retryAt.current = Date.now() + RETRY_MS;
        return;
      }
      const accepted = await Promise.resolve(chat.send(changePrompt(begun), [], [], changeDisplay(begun))).catch(() => false);
      if (accepted === false) {
        tracking.current = null;
        await persist(() => projectRequestFinish(begun.id, "failed", "El chat no aceptó el encargo (quizá se estaba cerrando).", null));
        return;
      }
      track.sending = false;
    })();
  }, [mine, session, free, state, chat]);

  // Termina cuando acaba el turno del mensaje que trajo el encargo (no otro que llegara a la vez).
  useEffect(() => {
    const track = tracking.current;
    if (!track || track.sending) return;
    const stored = all.find(request => request.id === track.id);
    // Cancelado desde el chat que lo pidió, o cerrado desde fuera: el turno sigue (lo decide la persona), pero ya no se informa.
    if (stored && stored.status !== "running" && stored.status !== "approved") { tracking.current = null; return; }
    const finish = (status: "answered" | "failed", report: string, usage: ReturnType<typeof usageTotals> = null, files: string[] | null = null): void => {
      tracking.current = null;
      const write = persist(() => projectRequestFinish(track.id, status, report, state.sessionId, usage, files));
      saving.current = write;
      void write.finally(() => { if (saving.current === write) saving.current = null; });
    };
    if (state.process === "failed" || state.process === "exited") {
      finish("failed", `El chat de «${track.to}» se cerró mientras hacía el encargo. Revisa ese chat para ver qué llegó a hacer.`);
      return;
    }
    const itemId = changeItem(state.items, track.id);
    const done = state.lastCompletion;
    if (!itemId || !done || !done.messageIds.includes(itemId)) return;
    const ids = new Set(done.itemIds);
    const text = sanitizeHandoffText(finalReply(state.items, ids)).trim();
    const files = [...new Set(state.items.flatMap(item => item.kind === "tool" && ids.has(item.id) ? editPaths(item.name, item.input) : []))];
    const usage = track.usage === undefined ? null : usageTotals(subtractApiUsage(state.apiUsage, track.usage));
    const completed = done.status === "completed";
    finish(completed ? "answered" : "failed", completed ? text || "Terminó sin escribir un informe."
      : text ? `Se interrumpió antes de terminar. Lo que llegó a escribir:\n\n${text}` : "Se interrumpió antes de terminar.", usage, files);
  }, [all, state]);

  return useMemo(() => ({ requests: mine, sending: () => !!tracking.current?.sending }), [mine]);
}
