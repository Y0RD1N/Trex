/**
 * Uso del contexto en la bandeja del chat: un anillo con la parte de la
 * ventana que ocupa la conversación y, al pulsarlo, el desglose y la opción
 * de resumirla para liberar espacio.
 */
import { useRef, useState } from "react";
import DropdownMenu from "../DropdownMenu";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import { contextPercent, contextTokensLabel, formatTokens, type ContextUsage } from "../../chatState";

/** Neutral shades identify fixed parts; conversation usage gets the accent. */
const PART_COLORS = ["var(--text-muted)", "var(--text-dim)", "var(--border-strong)", "color-mix(in srgb, var(--text) 65%, var(--bg-app))", "color-mix(in srgb, var(--text) 40%, var(--bg-app))", "color-mix(in srgb, var(--text) 25%, var(--bg-app))"];
const MESSAGES_COLOR = "var(--context-color, var(--accent))";

const percentLabel = (percent: number): string => percent > 0 && percent < 1 ? "<1 %" : `${Math.round(percent)} %`;

function Ring({ percent }: { percent: number }) {
  const radius = 5.5;
  const length = 2 * Math.PI * radius;
  // Siempre asoma un poco de arco: un anillo vacío parece que no mide nada.
  const filled = percent > 0 ? Math.max(percent, 4) : 0;
  return <svg className="chat-context-ring" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle className="track" cx="8" cy="8" r={radius} />
    <circle className="value" cx="8" cy="8" r={radius} strokeDasharray={length} strokeDashoffset={length * (1 - filled / 100)} />
  </svg>;
}

type ContextProps = {
  usage: ContextUsage;
  /** Nombre del asistente, para explicar cuándo resume él solo. */
  product: string;
  /** El asistente está trabajando: ahora no se puede resumir. */
  busy: boolean;
  onCompact: () => void;
  canCompact?: boolean;
};

/** Desglose compartido por el menú de contexto y el diálogo de uso. */
export function ContextDetails({ usage, product, busy, onCompact, canCompact, inline = false, onClose }: ContextProps & {
  /** El contenedor ya aporta el título y usa botones normales, como un diálogo. */
  inline?: boolean;
  onClose?: () => void;
}) {
  const percent = contextPercent(usage);
  const measured = usage.measured !== false;
  const shown = !measured ? "Sin medición" : percent === null ? formatTokens(usage.used) : percentLabel(percent);
  const summary = contextTokensLabel(usage);
  // Las partes fijas son las que mide el asistente; los mensajes, todo lo demás.
  const fixed = usage.parts.reduce((sum, part) => sum + part.tokens, 0);
  const rows = !measured ? [] : usage.parts.length
    ? [...usage.parts.map((part, index) => ({ ...part, color: PART_COLORS[index % PART_COLORS.length] })),
      { name: "Mensajes", tokens: Math.max(0, usage.used - fixed), color: MESSAGES_COLOR }]
    : [{ name: "Conversación", tokens: usage.used, color: MESSAGES_COLOR }];
  const reserve = measured && usage.window && usage.reserve ? usage.reserve : null;
  const free = measured && usage.window ? Math.max(0, usage.window - usage.used - (reserve ?? 0)) : null;
  const share = (tokens: number): string => usage.window ? `${Math.min(100, (tokens / usage.window) * 100)}%` : "0%";
  const supportsCompact = canCompact ?? (product === "Claude Code" || product === "Codex");
  const notes = [
    !measured ? "El uso se mostrará cuando el proveedor informe los tokens." : null,
    !usage.window ? "El proveedor no informó el límite de contexto de este modelo." : null,
    measured && product === "Trex CLI" ? "Contexto medido en la última solicitud." : null,
    supportsCompact && reserve && usage.window ? `Al llegar a ${formatTokens(usage.window - reserve)}, ${product} resume la conversación por sí solo.`
      : supportsCompact && usage.window ? `${product} resume la conversación por sí solo cuando se acerca al límite.` : null,
    usage.total ? `${formatTokens(usage.total)} tokens procesados en toda la conversación.` : null,
  ].filter(Boolean);

  return <>
    {!inline && <div className="chat-menu-label">Contexto</div>}
    <div className="chat-context-head">
      <strong>{shown}</strong>
      <span>{summary}</span>
    </div>
    {measured && usage.window && <div className="chat-context-bar" aria-hidden="true">
      {rows.map(row => <i key={row.name} style={{ width: share(row.tokens), background: row.color }} />)}
      {reserve && <i className="reserve" style={{ width: share(reserve) }} />}
    </div>}
    {measured && <ul className="chat-context-parts">
      {rows.map(row => <li key={row.name}>
        <i style={{ background: row.color }} /><span>{row.name}</span><b>{formatTokens(row.tokens)}</b>
      </li>)}
      {reserve && <li className="muted"><i className="reserve" /><span>Reserva para resumir</span><b>{formatTokens(reserve)}</b></li>}
      {free !== null && <li className="muted"><i className="free" /><span>Libre</span><b>{formatTokens(free)}</b></li>}
    </ul>}
    {notes.length > 0 && <p className="chat-context-note">{notes.join(" ")}</p>}
    {supportsCompact && <button type="button" role={inline ? undefined : "menuitem"} tabIndex={inline ? undefined : -1}
      className="context-item chat-context-compact" disabled={busy}
      onClick={() => { onClose?.(); onCompact(); }}>
      <span>Resumir conversación</span><small>/compact</small>
    </button>}
  </>;
}

export default function ContextMeter({ usage, product, busy, onCompact }: ContextProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const close = (): void => setAnchor(null);
  const percent = contextPercent(usage);
  const level = percent === null ? "" : percent >= 90 ? " critical" : percent >= 70 ? " high" : "";
  const shown = usage.measured === false ? "Sin medición" : percent === null ? formatTokens(usage.used) : percentLabel(percent);
  const summary = contextTokensLabel(usage);

  return <>
    <button ref={triggerRef} type="button" className={`chat-tray-chip chat-context${level}`} aria-haspopup="menu" aria-expanded={!!anchor}
      aria-label={`Contexto: ${percent === null ? summary : `${shown} usado, ${summary}`}`}
      data-tip={anchor ? undefined : `Contexto usado: ${summary}`}
      onClick={() => setAnchor(anchor ? null : { element: triggerRef.current! })}>
      {percent !== null && <span className="chat-tray-icon"><Ring percent={percent} /></span>}
      <span className="chat-tray-text">{shown}</span>
    </button>
    <DropdownMenu anchor={anchor} triggerRef={triggerRef} label="Uso del contexto"
      className={`chat-tray-menu chat-glass-menu chat-context-menu${level}`} onClose={close}>
      <ContextDetails usage={usage} product={product} busy={busy} onCompact={onCompact} onClose={close} />
    </DropdownMenu>
  </>;
}
