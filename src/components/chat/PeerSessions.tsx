/**
 * Las otras sesiones que trabajan en este proyecto: qué hace cada una y qué
 * tiene reservado. Las reservas solo avisan (no bloquean nada) y caducan
 * solas; aquí la persona puede soltar cualquiera y reanudar la conversación
 * entre agentes cuando se pausa.
 */
import { memo, useEffect, useId, useState } from "react";
import { coordinationHub, coordinationRelease, peerNoteParts, peersOf, WAKE_LIMIT, type PeerBoard, type PeerClaim } from "../../coordination";
import AgentIcon from "../AgentIcon";
import { AlertIcon, CloseIcon, ProfilesIcon, SessionsIcon } from "../Icons";
import { formatClock, formatDateTime } from "../../timeFormat";
import { useTimeFormat } from "../../hooks/useTimeFormat";
import type { TabKind } from "../../types";
import "./TaskPanel.css";
import "./PeerSessions.css";

const PROVIDERS: readonly string[] = ["claude", "codex", "antigravity", "trex"];
const minutesLeft = (claim: PeerClaim, now: number): string => `${Math.max(1, Math.ceil((claim.expires - now) / 60_000))} min`;

export default function PeerSessions({ board, session, project, onClose, panelId }: {
  board: PeerBoard | null; session: string; project: string; onClose: () => void; panelId?: string;
}) {
  const id = useId();
  const [now, setNow] = useState(() => Date.now());
  const [releasing, setReleasing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const peers = peersOf(board, session);
  const claims = board?.claims ?? [];
  const paused = coordinationHub.paused(project);
  const release = (claim: PeerClaim): void => {
    setReleasing(claim.id);
    setError(null);
    void coordinationRelease(project, claim.id)
      .then(() => coordinationHub.refresh(project))
      .catch(reason => setError(`No se pudo liberar la reserva: ${String(reason)}`))
      .finally(() => setReleasing(null));
  };
  const claimList = (list: PeerClaim[]) => list.length > 0 && <ul className="peer-claims">{list.map(claim =>
    <li key={claim.id}>
      <span className="peer-claim-name" title={claim.name}>{claim.kind === "resource" ? <em>{claim.name}</em> : claim.name}</span>
      <small>{[claim.reason, `quedan ${minutesLeft(claim, now)}`].filter(Boolean).join(" · ")}</small>
      <button type="button" className="btn btn-small" disabled={releasing === claim.id} onClick={() => release(claim)}
        aria-label={`Liberar la reserva de ${claim.name} (${claim.holder})`}>Liberar</button>
    </li>)}</ul>;
  const mine = claims.filter(claim => claim.session === session);
  return <aside id={panelId} className="chat-task-panel peer-sessions" aria-labelledby={id}>
    <header><div><h2 id={id}><SessionsIcon size={16} />Sesiones del proyecto</h2>
      <p>{peers.length === 1 ? "Otra sesión trabaja en esta carpeta" : `${peers.length} sesiones más trabajan en esta carpeta`}</p></div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Contraer sesiones del proyecto"><CloseIcon size={14} /></button></header>
    {paused && <div className="peer-paused" role="status">
      <p>Los agentes se han escrito {WAKE_LIMIT} veces seguidas sin que intervengas: la conversación está en pausa.</p>
      <button type="button" className="btn btn-small" onClick={() => coordinationHub.resetWakes(project)}>Dejar que sigan</button>
    </div>}
    <ul className="peer-list">{peers.map(peer => <li key={peer.id}>
      <div className="peer-head">
        {PROVIDERS.includes(peer.agent) && <AgentIcon kind={peer.agent as TabKind} size={16} activity={peer.working ? "working" : "idle"} />}
        <strong>{peer.label}</strong>
        <span className={`peer-state${peer.working ? " is-working" : ""}`}>{peer.working ? "Trabajando" : "En espera"}</span>
      </div>
      {peer.task && <p className="peer-task">{peer.task}</p>}
      {claimList(claims.filter(claim => claim.session === peer.id))}
    </li>)}</ul>
    {mine.length > 0 && <section className="peer-mine"><h3>Reservas de esta sesión</h3>{claimList(mine)}</section>}
    {error && <p className="peer-error" role="alert">{error}</p>}
    <p className="peer-hint">Los agentes pueden escribirse para ponerse de acuerdo: el que está libre se despierta para contestar,
      hasta {WAKE_LIMIT} mensajes seguidos. Si dos sesiones tocan el mismo archivo, trex avisa a las dos. Las reservas no bloquean nada y caducan solas.</p>
  </aside>;
}

/**
 * Un turno que trajo mensajes de otras sesiones (el que las despierta o el que
 * se recupera del historial): se pinta como su mensaje, no como uno tuyo.
 */
export const PeerMessage = memo(function PeerMessage({ notes, at, animate = false }: { notes: string[]; at?: number; animate?: boolean }) {
  const timeFormat = useTimeFormat();
  const parts = notes.map(peerNoteParts);
  const senders = [...new Set(parts.flatMap(part => part.from ? [part.from] : []))];
  const who = senders.length === 1 ? senders[0] : "Otras sesiones";
  return <div className={`chat-peer-turn${animate ? " chat-enter" : ""}`} role="group" aria-label={`Mensaje de ${who}`}>
    <div className="chat-user-head">
      <span className="chat-peer-who"><ProfilesIcon size={13} />{who}</span>
      {at !== undefined && Number.isFinite(at) && <time className="chat-user-time tip" data-tip={formatDateTime(at, timeFormat)}
        dateTime={new Date(at).toISOString()}>{formatClock(at, timeFormat)}</time>}
    </div>
    <ul className="chat-peer-notes">{parts.map((part, index) => <li key={index} className={part.from ? undefined : "is-conflict"}>
      {!part.from && <AlertIcon size={13} />}
      <span>{part.from && senders.length > 1 && <strong>{part.from}: </strong>}{part.text}</span>
    </li>)}</ul>
  </div>;
});
