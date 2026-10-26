import { useEffect, useState, type ReactNode } from "react";
import { effortLabel, type ChatItem } from "../../chatState";
import type { ChatAttribution } from "../../chatTasks";
import AgentIcon from "../AgentIcon";
import { CheckIcon, ChevronIcon } from "../Icons";

/** Public tool/message activity, with live permissions kept in the main thread. */
export default function AgentActivity({ author, items, children, live }: { author: ChatAttribution; items: ChatItem[]; children: ReactNode; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => { if (live) setOpen(true); }, [live]);
  const lastUser = [...items].reverse().find(item => item.kind === "user");
  const lastTool = [...items].reverse().find(item => item.kind === "tool");
  const lastTurn = [...items].reverse().find(item => item.kind === "turn");
  const last = items[items.length - 1];
  const error = !live && (lastTool?.kind === "tool" && lastTool.status === "error" || last?.kind === "notice" && last.tone === "error");
  const done = !live && !!lastTurn;
  return <details className="chat-agent-activity" data-member-id={author.memberId} data-live={live || undefined} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><AgentIcon kind={author.provider} size={23} /><span className="chat-agent-description"><span><strong>{author.label}</strong><small>{author.role}</small></span>
      <span className="chat-agent-model" title={[author.profile,author.model,author.effort && effortLabel(author.effort)].filter(Boolean).join(" · ")}>{author.profile ? `${author.profile} · ` : ""}{author.model ?? "Modelo del perfil"}{author.effort ? ` · ${effortLabel(author.effort)}` : ""}</span>
      {lastUser?.kind === "user" && <span className="chat-agent-task">{lastUser.text.replace(/^Delegación de [^\n]+\n+/, "").slice(0, 300)}</span>}</span>
      <span className="chat-agent-status">{live ? <><span className="chat-spinner" />Trabajando</> : error ? "Revisar resultado" : done ? <><CheckIcon size={12} />Finalizó</> : "Actividad"}</span><ChevronIcon size={13} /></summary>
    <div className="chat-agent-body">{lastUser?.kind === "user" && <details className="chat-agent-instruction"><summary>Instrucción recibida</summary><p>{lastUser.text}</p></details>}{children}</div>
  </details>;
}
