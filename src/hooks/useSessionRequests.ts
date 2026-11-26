import { useMemo, useSyncExternalStore } from "react";
import { projectKey, projectRequestsStore, requestChats, requestOrphan, type ProjectRequest } from "../projectRequests";

const EMPTY: readonly ProjectRequest[] = [];

/** Las preguntas de una sesión a otros proyectos (vacío si no preguntó nada o la función está apagada). */
export function useSessionRequests(session: string | null): readonly ProjectRequest[] {
  const all = useSyncExternalStore(projectRequestsStore.subscribe, projectRequestsStore.get);
  return useMemo(() => {
    const mine = session ? all.filter(request => request.fromSession === session) : EMPTY;
    return mine.length ? mine : EMPTY;
  }, [all, session]);
}

/** Respuestas para este proyecto cuyo chat ya no está abierto: cualquier chat del proyecto puede recogerlas. */
export function useProjectOrphans(project: string | null): readonly ProjectRequest[] {
  const all = useSyncExternalStore(projectRequestsStore.subscribe, projectRequestsStore.get);
  const chats = useSyncExternalStore(requestChats.subscribe, requestChats.version);
  return useMemo(() => {
    if (!project) return EMPTY;
    const key = projectKey(project);
    const orphans = all.filter(request => requestOrphan(request) && projectKey(request.fromProject) === key);
    return orphans.length ? orphans : EMPTY;
    // `chats` cambia cuando se abre o se cierra un chat: `requestOrphan` lo consulta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, chats, project]);
}

/** Mensajes de otros proyectos asignados a este chat que aún no están en su hilo. */
export function useIncomingMessages(session: string | null): readonly ProjectRequest[] {
  const all = useSyncExternalStore(projectRequestsStore.subscribe, projectRequestsStore.get);
  return useMemo(() => {
    const mine = session ? all.filter(request => request.kind === "message" && request.status === "approved" && request.toSession === session) : EMPTY;
    return mine.length ? mine : EMPTY;
  }, [all, session]);
}

/** Una pregunta por su id (la tarjeta de respuesta la busca para ver su consumo y su conversación). */
export function useProjectRequest(id: string): ProjectRequest | null {
  const all = useSyncExternalStore(projectRequestsStore.subscribe, projectRequestsStore.get);
  return useMemo(() => all.find(request => request.id === id) ?? null, [all, id]);
}
