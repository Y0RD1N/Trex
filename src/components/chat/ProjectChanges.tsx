/**
 * Encargos entre proyectos en el chat (`trex_request_change`):
 *  - en el chat que lo pidió, la aprobación sobre la caja de mensaje: qué pide, qué chat del otro
 *    proyecto lo hará y si la persona confía en esa pareja para no volver a preguntar;
 *  - en el chat que lo hace, la tarjeta con la que el hilo pinta el encargo recibido y la pestaña con
 *    los que esperan a que ese chat quede libre.
 * Solo cambia cómo se ve: el texto que recibe cada agente es el de `changePrompt` y `answersMessage`.
 */
import { memo, useState, useSyncExternalStore } from "react";
import { defaultChangeChat, projectChatsStore, type ChangeView, type MessageView, type ProjectRequest } from "../../projectRequests";
import { formatError } from "../../api";
import { useProjectRequest } from "../../hooks/useSessionRequests";
import { formatClock, formatDateTime } from "../../timeFormat";
import { useTimeFormat } from "../../hooks/useTimeFormat";
import AgentIcon from "../AgentIcon";
import Select from "../Select";
import ComposerPanel from "./ComposerPanel";
import Markdown from "./Markdown";
import { CheckIcon, FolderIcon } from "../Icons";
import "./ProjectQuestions.css";

const NEW_CHAT = "";

type ApprovalProps = {
  request: ProjectRequest;
  /** Cuenta con la que trex abriría un chat nuevo en ese proyecto; null si no puede abrir ninguno. */
  newChat: string | null;
  onApprove: (request: ProjectRequest, session: string | null, trust: boolean) => Promise<unknown>;
  onReject: (request: ProjectRequest) => Promise<unknown>;
};

/** La persona decide el encargo: el modelo no puede aprobarlo. */
export function ChangeApproval({ request, newChat, onApprove, onReject }: ApprovalProps) {
  const all = useSyncExternalStore(projectChatsStore.subscribe, projectChatsStore.get);
  const chats = all.filter(chat => chat.projectId === request.toProjectId);
  const fallback = defaultChangeChat(chats, request.toProjectId)?.session ?? NEW_CHAT;
  const [picked, setPicked] = useState<string | null>(null);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Si el chat elegido se cerró, vuelve al de siempre.
  const target = picked !== null && (picked === NEW_CHAT ? !!newChat : chats.some(chat => chat.session === picked)) ? picked : fallback;
  const possible = target !== NEW_CHAT || !!newChat;
  const act = (run: () => Promise<unknown>, failure: string): void => {
    setBusy(true);
    setError("");
    // Al decidir, la tarjeta se va con la siguiente lectura del diario; si falla, se puede repetir.
    void run().catch(reason => { setBusy(false); setError(`${failure}: ${formatError(reason)}`); });
  };
  return <div className="chat-ask change-approval" role="group" aria-label={`Encargo para ${request.toName}`}>
    <div className="chat-ask-head">
      <span className="chat-ask-icon" aria-hidden="true"><FolderIcon size={15} /></span>
      <span className="chat-ask-title">Encargo para {request.toName}</span>
      <span className="chat-ask-count">espera tu aprobación</span>
    </div>
    <div className="chat-ask-question">
      <div className="chat-ask-text change-approval-task"><Markdown text={request.question} /></div>
      {request.acceptance && <p className="change-approval-line"><CheckIcon size={12} /><span>Hecho cuando: {request.acceptance}</span></p>}
    </div>
    <div className="change-approval-target">
      <span>Lo hará</span>
      <Select aria-label={`Chat de ${request.toName} que hará el encargo`} value={target} onChange={setPicked} disabled={busy}
        placeholder={`Ningún chat de ${request.toName}`}
        options={[
          ...chats.map(chat => ({ value: chat.session, label: chat.label, description: chat.busy ? "Ocupado: lo recibe al terminar lo que está haciendo" : "Libre",
            icon: <AgentIcon kind={chat.provider} size={15} /> })),
          ...(newChat ? [{ value: NEW_CHAT, label: `Un chat nuevo de ${request.toName}`, description: `Con ${newChat}; se abre sin cambiar de pestaña` }] : []),
        ]} />
    </div>
    <label className="change-approval-trust">
      <input type="checkbox" checked={trust} disabled={busy} onChange={event => setTrust(event.currentTarget.checked)} />
      No volver a preguntar para encargos de {request.fromName} a {request.toName}
    </label>
    <div className="chat-ask-foot">
      <span className="chat-ask-hint">Lo hace a la vista, con los permisos de ese chat. Puedes intervenir allí.</span>
      <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => act(() => onReject(request), "No se pudo rechazar")}>Rechazar</button>
      <button type="button" className="btn btn-primary btn-small" disabled={busy || !possible}
        onClick={() => act(() => onApprove(request, target === NEW_CHAT ? null : target, trust), "No se pudo enviar")}>Enviar a {request.toName}</button>
    </div>
    {error && <p className="project-questions-error" role="alert">{error}</p>}
  </div>;
}

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
