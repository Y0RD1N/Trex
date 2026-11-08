import { useEffect, useState, type ReactNode } from "react";
import { effortLabel, type ChatItem } from "../../chatState";
import type { ChatAttribution } from "../../chatTasks";
import AgentIcon from "../AgentIcon";
import { CheckIcon, ChevronIcon } from "../Icons";

/**
 * Actividad pública de un subagente. Con `onOpen` es una tarjeta de una línea que abre su
 * conversación completa (el hilo del principal no se llena con sus pasos); sin él, se
 * despliega con los pasos dentro. Los permisos pendientes siguen en el hilo principal.
 */
export default function AgentActivity({ author, items, children, live, attention = false, onOpen }: {
  author: ChatAttribution; items: ChatItem[]; children?: ReactNode; live: boolean;
  /** El subagente espera una respuesta tuya. */
  attention?: boolean;
  onOpen?: (memberId: string) => void;
}) {
  const [open, setOpen] = useState(live);
  useEffect(() => { if (live) setOpen(true); }, [live]);
  const lastUser = [...items].reverse().find(item => item.kind === "user");
  const lastTool = [...items].reverse().find(item => item.kind === "tool");
  const lastTurn = [...items].reverse().find(item => item.kind === "turn");
  const last = items[items.length - 1];
  const error = !live && (lastTool?.kind === "tool" && lastTool.status === "error" || last?.kind === "notice" && last.tone === "error");
  const done = !live && !!lastTurn;
  const summary = <>
    <AgentIcon kind={author.provider} size={23} /><span className="chat-agent-description"><span><strong>{author.label}</strong><small>{author.role}</small></span>
      <span className="chat-agent-model" title={[author.profile,author.model,author.effort && effortLabel(author.effort)].filter(Boolean).join(" · ")}>{author.profile ? `${author.profile} · ` : ""}{author.model ?? "Modelo del perfil"}{author.effort ? ` · ${effortLabel(author.effort)}` : ""}</span>
      {lastUser?.kind === "user" && <span className="chat-agent-task">{lastUser.text.replace(/^Delegación de [^\n]+\n+/, "").slice(0, 300)}</span>}</span>
    <span className="chat-agent-status">{attention ? "Necesita tu respuesta" : live ? <><span className="chat-spinner" />Trabajando</> : error ? "Revisar resultado" : done ? <><CheckIcon size={12} />Finalizó</> : "Actividad"}</span>
  </>;
  if (onOpen && author.memberId) {
    const memberId = author.memberId;
    return <button type="button" className="chat-agent-activity chat-agent-card" data-member-id={memberId} data-live={live || undefined} data-attention={attention || undefined}
      aria-label={`Abrir la conversación de ${author.label}${live ? ", trabajando" : ""}${attention ? ", necesita tu respuesta" : ""}`} onClick={() => onOpen(memberId)}>
      {summary}<span className="chat-agent-open">Abrir<ChevronIcon size={13} /></span>
    </button>;
  }
  return <details className="chat-agent-activity" data-member-id={author.memberId} data-live={live || undefined} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}<ChevronIcon size={13} /></summary>
    <div className="chat-agent-body">{lastUser?.kind === "user" && <details className="chat-agent-instruction"><summary>Instrucción recibida</summary><p>{lastUser.text}</p></details>}{children}</div>
  </details>;
}
