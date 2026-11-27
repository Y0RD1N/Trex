/**
 * Encargos y mensajes entre proyectos en el chat que los recibe (`trex_request_change`,
 * `trex_message_project`): la tarjeta con la que el hilo pinta cada uno y la pestaña con los encargos
 * que esperan a que ese chat quede libre. No hay tarjeta de aprobación: el encargo va directo y lo
 * frenan, si acaso, los permisos de ese chat.
 * Solo cambia cómo se ve: el texto que recibe cada agente es el de `changePrompt` y `messagesTurn`.
 */
import { memo } from "react";
import type { ChangeView, MessageView, ProjectRequest } from "../../projectRequests";
import { useProjectRequest } from "../../hooks/useSessionRequests";
import { formatClock, formatDateTime } from "../../timeFormat";
import { useTimeFormat } from "../../hooks/useTimeFormat";
import ComposerPanel from "./ComposerPanel";
import Markdown from "./Markdown";
import { CheckIcon, FolderIcon } from "../Icons";
import "./ProjectQuestions.css";

const RUNNING_LABEL: Partial<Record<ProjectRequest["status"], string>> = {
  approved: "En cola: empieza cuando este chat quede libre",
  running: "En curso",
  answered: "Hecho: el informe volvió a quien lo pidió",
  failed: "Sin terminar",
  cancelled: "Cancelado por la persona",
};

/** El encargo en el hilo del chat que lo hace (en lugar del texto enmarcado que recibió el agente). */
export const ProjectChangeMessage = memo(function ProjectChangeMessage({ change, at, animate = false }: { change: ChangeView; at?: number; animate?: boolean }) {
  const timeFormat = useTimeFormat();
  const request = useProjectRequest(change.id);
  const status = request ? RUNNING_LABEL[request.status] : null;
  return <div className={`chat-peer-turn chat-project-answer${animate ? " chat-enter" : ""}`} role="group" aria-label={`Encargo de ${change.from}`}>
    <section className="project-answer">
      <div className="chat-user-head">
        <span className="chat-peer-who"><FolderIcon size={13} />Encargo de {change.from}</span>
        {at !== undefined && Number.isFinite(at) && <time className="chat-user-time tip" data-tip={formatDateTime(at, timeFormat)}
          dateTime={new Date(at).toISOString()}>{formatClock(at, timeFormat)}</time>}
      </div>
      <div className="project-answer-body"><Markdown text={change.task} /></div>
      {change.acceptance && <p className="change-approval-line"><CheckIcon size={12} /><span>Hecho cuando: {change.acceptance}</span></p>}
      {change.context && <details className="project-change-context"><summary>Lo que cuenta {change.from}</summary><Markdown text={change.context} /></details>}
      {status && <div className="project-answer-meta"><span>{status}</span></div>}
    </section>
  </div>;
});

/** Mensajes de agentes de otros proyectos en el hilo del chat que los recibe. */
export const ProjectMessageCard = memo(function ProjectMessageCard({ messages, at, animate = false }: { messages: MessageView[]; at?: number; animate?: boolean }) {
  const timeFormat = useTimeFormat();
  const from = [...new Set(messages.map(message => message.from))].join(", ");
  return <div className={`chat-peer-turn chat-project-answer${animate ? " chat-enter" : ""}`} role="group" aria-label={`Mensaje de ${from}`}>
    {messages.map(message => <section key={message.id} className="project-answer">
      <div className="chat-user-head">
        <span className="chat-peer-who"><FolderIcon size={13} />Mensaje de {message.from}</span>
        {at !== undefined && Number.isFinite(at) && <time className="chat-user-time tip" data-tip={formatDateTime(at, timeFormat)}
          dateTime={new Date(at).toISOString()}>{formatClock(at, timeFormat)}</time>}
      </div>
      {message.reply && <p className="project-answer-question"><span>En respuesta a tu mensaje</span></p>}
      <div className="project-answer-body"><Markdown text={message.text} /></div>
    </section>)}
  </div>;
});

/** Encargos para este chat que esperan a que termine lo que está haciendo. */
export const IncomingChanges = memo(function IncomingChanges({ requests }: { requests: readonly ProjectRequest[] }) {
  const waiting = requests.filter(request => request.status === "approved");
  if (!waiting.length) return null;
  return <ComposerPanel label="Encargos" title="Encargos de otros proyectos" icon={<FolderIcon size={13} />} count={waiting.length}>
    <ul className="project-questions">
      {waiting.map(request => <li key={request.id}>
        <div className="project-question-head"><strong>{request.fromName}</strong><span>en cola</span></div>
        <p>{request.question}</p>
      </li>)}
    </ul>
    <p className="project-questions-note">Trex se lo pasará a este agente en cuanto termine lo que está haciendo; lo verás aquí, como un mensaje más.</p>
  </ComposerPanel>;
});
