/**
 * Peticiones de este chat a otros proyectos (preguntas y encargos): la pestaña junto a la caja de
 * mensaje mientras alguna sigue abierta (con la opción de cancelarla) o mientras hay respuestas de
 * este proyecto que se quedaron sin chat, y la tarjeta con la que el hilo pinta una respuesta o un
 * informe que entregó trex. Solo cambia cómo se ve: el texto que recibe el agente es el de `answersMessage`.
 */
import { memo, useEffect, useState } from "react";
import { projectRequestCancel, requestAwaiting, requestDuration, requestOpen, type AnswerView, type ProjectRequest } from "../../projectRequests";


import { formatError } from "../../api";
import { formatDuration, formatTokens } from "../../chatState";
import { costLabel, type UsageTotals } from "../../tokenUsage";
import { useProjectRequest } from "../../hooks/useSessionRequests";
import ComposerPanel from "./ComposerPanel";
import Markdown from "./Markdown";
import { CloseIcon, ExternalIcon, FolderIcon, QuestionIcon } from "../Icons";
import { formatClock, formatDateTime } from "../../timeFormat";
import { useTimeFormat } from "../../hooks/useTimeFormat";
import "./ProjectQuestions.css";

/** Por encima de esto la respuesta se pliega: el hilo sigue legible y se despliega con un clic. */
const LONG_ANSWER = 1_400;

/** «38 k tokens · US$0,12»: lo nuevo que leyó y escribió (lo leído de la caché no cuenta). */
export function usageText(usage: UsageTotals | null | undefined): string | null {
  if (!usage) return null;
  const tokens = usage.newTokens + usage.outputTokens;
  const cost = costLabel(usage.costUsd);
  return [tokens > 0 ? `${formatTokens(tokens)} tokens` : null, cost].filter(Boolean).join(" · ") || null;
}

/** Lo que lleva contestando: solo este texto se repinta cada segundo. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return <>{formatDuration(now - since)}</>;
}

type Props = {
  requests: readonly ProjectRequest[];
  /** Respuestas para este proyecto cuyo chat se cerró. */
  orphans?: readonly ProjectRequest[];
  onAdopt?: (request: ProjectRequest) => Promise<unknown>;
  onDismiss?: (request: ProjectRequest) => Promise<unknown>;
  /** Muestra el chat del otro proyecto que hace un encargo. */
  onOpenSession?: (session: string) => void;
};

/** Estado de una petición abierta, en pocas palabras (la que está en marcha cuenta su tiempo). */
function OpenStatus({ request }: { request: ProjectRequest }) {
  const since = request.startedAt ?? request.updatedAt;
  if (request.kind === "message") return <>{request.toSession ? "en cola en su chat" : `espera a que abras un chat de ${request.toName}`}</>;
  if (request.kind === "change") {
    if (request.status === "awaiting_approval") return <>espera tu aprobación</>;
    if (request.status === "approved") return <>aprobado, en cola</>;
    return <>trabajando · <Elapsed since={since} /></>;
  }
  return request.status === "running" ? <>contestando · <Elapsed since={since} /></> : <>en cola</>;
}

export const ProjectQuestions = memo(function ProjectQuestions({ requests, orphans = [], onAdopt, onDismiss, onOpenSession }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const open = requests.filter(requestOpen);
  if (!open.length && !orphans.length) return null;
  const act = (request: ProjectRequest, run: (request: ProjectRequest) => Promise<unknown>, failure: string): void => {
    setBusy(request.id);
    setError("");
    void run(request)
      .catch(reason => setError(`${failure}: ${formatError(reason)}`))
      .finally(() => setBusy(null));
  };
  const count = open.length + orphans.length;
  const asks = open.some(request => request.kind === "ask"), changes = open.some(request => request.kind === "change");
  return <ComposerPanel label="Peticiones" title="Peticiones a otros proyectos" icon={<FolderIcon size={13} />} count={count}
    attention={orphans.length > 0 || open.some(requestAwaiting)} live={open.some(request => request.status === "running")}>
    {open.length > 0 && <ul className="project-questions">
      {open.map(request => {
        const what = request.kind === "change" ? "el encargo" : request.kind === "message" ? "el mensaje" : "la pregunta";
        return <li key={request.id}>
          <div className="project-question-head">
            <strong>{request.kind === "change" ? `Encargo a ${request.toName}` : request.kind === "message" ? `Mensaje a ${request.toName}` : request.toName}</strong>
            <span className={request.status === "running" ? "is-live" : undefined}><OpenStatus request={request} /></span>
            {request.kind === "change" && request.toSession && request.status === "running" && onOpenSession
              && <button type="button" className="btn btn-small btn-ghost" onClick={() => onOpenSession(request.toSession!)}>Ver</button>}
            <button type="button" className="icon-btn" title={`Cancelar ${what}`} aria-label={`Cancelar ${what} a ${request.toName}`}
              disabled={busy === request.id} onClick={() => act(request, entry => projectRequestCancel(entry.id), "No se pudo cancelar")}><CloseIcon size={12} /></button>
          </div>
          <p>{request.question}</p>
        </li>;
      })}
    </ul>}
    {asks && <p className="project-questions-note">Las preguntas las contesta un chat de solo lectura en ese proyecto. Trex le pasará la respuesta al agente en cuanto llegue.</p>}
    {changes && <p className="project-questions-note">Los encargos los hace, a la vista, el chat del otro proyecto que elegiste. Cancelar uno en marcha no detiene ese chat: solo deja de esperar su informe.</p>}
    {orphans.length > 0 && <section className="project-orphans" aria-label="Respuestas sin chat">
      <p className="project-questions-note">Estas respuestas llegaron cuando el chat que preguntó ya estaba cerrado. Puedes pasárselas a este agente o descartarlas.</p>
      <ul className="project-questions">
        {orphans.map(request => <li key={request.id}>
          <div className="project-question-head">
            <strong>{request.toName}</strong>
            <span>{request.status === "answered" ? "respondió" : "sin respuesta"}</span>
          </div>
          <p>{request.question}</p>
          <div className="project-orphan-actions">
            <button type="button" className="btn btn-small" disabled={busy === request.id || !onAdopt}
              onClick={() => onAdopt && act(request, onAdopt, "No se pudo pasar")}>Pasar a este chat</button>
            <button type="button" className="btn btn-small btn-ghost" disabled={busy === request.id || !onDismiss}
              onClick={() => onDismiss && act(request, onDismiss, "No se pudo descartar")}>Descartar</button>
          </div>
        </li>)}
      </ul>
    </section>}
    {error && <p className="project-questions-error" role="alert">{error}</p>}
  </ComposerPanel>;
});

type AnswerActions = { onOpen?: (request: ProjectRequest) => void; onOpenSession?: (session: string) => void };

function Answer({ answer, at, onOpen, onOpenSession }: AnswerActions & { answer: AnswerView; at?: number }) {
  const timeFormat = useTimeFormat();
  const request = useProjectRequest(answer.id);
  const change = answer.kind === "change";
  const long = answer.ok && answer.answer.length > LONG_ANSWER;
  const [expanded, setExpanded] = useState(false);
  const took = request ? requestDuration(request) : null;
  const spent = usageText(request?.usage);
  // Una pregunta se abre como chat nuevo con su conversación; un encargo se hizo en un chat que ya existe.
  const openable = !change && !!(onOpen && request?.conversation && request.answerProfile);
  const showable = change && !!(onOpenSession && request?.toSession);
  const who = change ? answer.ok ? "Informe de" : "Encargo sin terminar en" : answer.ok ? "Respuesta de" : "Sin respuesta de";
  return <section className="project-answer">
    <div className="chat-user-head">
      <span className="chat-peer-who"><FolderIcon size={13} />{who} {answer.project}</span>
      {at !== undefined && Number.isFinite(at) && <time className="chat-user-time tip" data-tip={formatDateTime(at, timeFormat)}
        dateTime={new Date(at).toISOString()}>{formatClock(at, timeFormat)}</time>}
    </div>
    <p className="project-answer-question"><QuestionIcon size={12} /><span>{answer.question}</span></p>
    {answer.ok
      ? <div className={`project-answer-body${long && !expanded ? " is-folded" : ""}`}><Markdown text={answer.answer} /></div>
      : <p className="project-answer-failed">{answer.answer}</p>}
    {long && <button type="button" className="btn btn-small btn-ghost project-answer-more" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? "Plegar la respuesta" : "Ver toda la respuesta"}</button>}
    {change && answer.files.length > 0 && <details className="project-change-context">
      <summary>{answer.files.length === 1 ? "1 archivo editado" : `${answer.files.length} archivos editados`} (medido por trex)</summary>
      <ul className="project-answer-files">{answer.files.map(file => <li key={file} title={file}>{file}</li>)}</ul>
      {answer.diffStat && <pre className="project-answer-diff">{answer.diffStat}</pre>}
    </details>}
    {(took !== null || spent || openable || showable) && <div className="project-answer-meta">
      {took !== null && <span>Tardó {formatDuration(took)}</span>}
      {spent && <span>{spent}</span>}
      {openable && <button type="button" className="project-answer-open" onClick={() => onOpen!(request!)}
        title={`Abre en ${answer.project} la conversación que contestó, como un chat normal`}>
        <ExternalIcon size={12} />Abrir la conversación</button>}
      {showable && <button type="button" className="project-answer-open" onClick={() => onOpenSession!(request!.toSession!)}
        title={`Muestra el chat de ${answer.project} que hizo el encargo`}>
        <ExternalIcon size={12} />Ir al chat de {answer.project}</button>}
    </div>}
  </section>;
}

export const ProjectAnswerMessage = memo(function ProjectAnswerMessage({ answers, at, animate = false, onOpen, onOpenSession }: AnswerActions & {
  answers: AnswerView[]; at?: number; animate?: boolean;
}) {
  const projects = [...new Set(answers.map(answer => answer.project))].join(", ");
  const label = answers.every(answer => answer.kind === "change") ? "Informe de" : "Respuesta de";
  return <div className={`chat-peer-turn chat-project-answer${animate ? " chat-enter" : ""}`} role="group" aria-label={`${label} ${projects}`}>
    {answers.map(answer => <Answer key={answer.id} answer={answer} at={at} onOpen={onOpen} onOpenSession={onOpenSession} />)}
  </div>;
});
