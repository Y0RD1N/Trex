/**
 * Aviso de otra sesión del proyecto en el hilo: un choque de edición (dos sesiones tocan el mismo archivo)
 * o un mensaje suyo. Misma tarjeta que los demás avisos (.chat-notice) y el mismo lenguaje que las
 * herramientas: un glifo, un título con su regla fina y los datos como ramas de un árbol (├─ └─).
 */
import { Fragment, memo } from "react";
import type { PeerNoticeView } from "../../coordination";
import { FileIcon } from "../Icons";
import "./PeerNotice.css";

/** «Agente · título de la sesión» (el título puede faltar). */
export function sessionLabel(label: string): { agent: string; session: string | null } {
  const cut = label.indexOf(" · ");
  return cut < 0 ? { agent: label, session: null } : { agent: label.slice(0, cut), session: label.slice(cut + 3) };
}

/** La ruta con la carpeta atenuada y el nombre del archivo en primer plano. */
function PathChip({ path }: { path: string }) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return <span className="peer-notice-file" title={path}>
    <FileIcon size={12} />
    <span>{cut > 0 && <span className="dir">{path.slice(0, cut)}</span>}<span className="base">{path.slice(cut)}</span></span>
  </span>;
}

/** El consejo sale tal cual lo escribe `coordination.rs`; solo el nombre de la herramienta se marca como código. */
function Advice({ text }: { text: string }) {
  return <>{text.split(/(trex_message)/).map((part, index) =>
    part === "trex_message" ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>)}</>;
}

function Head({ children, age }: { children: React.ReactNode; age: string }) {
  return <div className="peer-notice-head">
    <span className="chat-notice-glyph" aria-hidden="true" />
    <span className="peer-notice-title">{children}</span>
    <span className="peer-notice-rule" aria-hidden="true" />
    <span className="peer-notice-age">{age}</span>
  </div>;
}

export const PeerNotice = memo(function PeerNotice({ tone, view }: { tone: "info" | "warn" | "error"; view: PeerNoticeView }) {
  if (view.kind === "message") {
    const { agent, session } = sessionLabel(view.from);
    return <div className={`chat-notice ${tone} is-peer`} role="status">
      <Head age={view.age}>Mensaje de <strong>{agent}</strong>{session && <span className="peer-notice-session"> · {session}</span>}</Head>
      <p className="peer-notice-text">{view.text}</p>
    </div>;
  }
  const { agent, session } = sessionLabel(view.label);
  const who = <strong>{agent}</strong>;
  const what = view.youEdited
    ? (view.claimed ? <>Editaste este archivo, que {who} tiene reservado.</> : <>Editaste este archivo, que {who} cambió {view.since}.</>)
    : (view.claimed ? <>{who} editó este archivo, que tienes reservado.</> : <>{who} editó este archivo, que tú también cambiaste hace poco.</>);
  // Cada dato es una rama; la última cierra el árbol, como en las herramientas.
  const rows: Array<[string, React.ReactNode]> = [];
  if (session) rows.push(["sesión", session]);
  if (view.reason) rows.push(["reserva", view.reason]);
  rows.push(["qué hacer", <Advice text={view.advice} />]);
  return <div className={`chat-notice ${tone} is-peer`} role="status">
    <Head age={view.age}><strong>Posible choque de edición</strong></Head>
    <PathChip path={view.path} />
    <p className="peer-notice-text">{what}</p>
    <dl className="peer-notice-tree">
      {rows.map(([label, value], index) => <div key={label}>
        <span className="branch" aria-hidden="true">{index === rows.length - 1 ? "└─" : "├─"}</span>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>)}
    </dl>
  </div>;
});
