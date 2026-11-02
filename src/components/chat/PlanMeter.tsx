import { useTimeFormat } from "../../hooks/useTimeFormat";
/**
 * Uso del plan de la cuenta en la bandeja del chat: cuánto se ha gastado de la
 * ventana que más importa ahora y, al pulsarlo, todas las ventanas con su
 * reinicio. Desde ahí se abre el uso de todas las cuentas.
 */
import { useRef, useState } from "react";
import DropdownMenu from "../DropdownMenu";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import { extraLabel, headlineWindow, resetLabel, type PlanUsage, type PlanWindow } from "../../planUsage";
import { GaugeIcon } from "../Icons";

/** Nombre corto de la ventana para la bandeja. */
const shortLabel = (window: PlanWindow): string =>
  window.label.startsWith("Sesión") ? "5 h" : window.label === "Semana" ? "semana" : window.label.split(" · ").pop() ?? window.label;

/** Filas de uso: nombre, barra y cuándo se reinicia. Las comparte la ventana de todas las cuentas. */
export function PlanWindows({ usage, now }: { usage: PlanUsage; now: number }) {
  const timeFormat = useTimeFormat();
  const extra = extraLabel(usage.extra);
  return <>
    <ul className="plan-windows">
      {usage.windows.map(window => <li key={window.id} className={`plan-window ${window.severity}`}>
        <div className="plan-window-head">
          <span>{window.label}</span>
          <b>{window.percent} %</b>
        </div>
        <div className="plan-window-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.percent}
          aria-label={`${window.label}: ${window.percent} % usado`}>
          <i style={{ width: `${Math.max(window.percent, window.percent > 0 ? 2 : 0)}%` }} />
        </div>
        {window.resetsAt !== null && <small>{resetLabel(window.resetsAt, now, timeFormat)}</small>}
      </li>)}
    </ul>
    {(extra || usage.resetCredits > 0) && <p className="plan-note">
      {[extra, usage.resetCredits > 0 ? `${usage.resetCredits} ${usage.resetCredits === 1 ? "reinicio gratuito disponible" : "reinicios gratuitos disponibles"}` : null]
        .filter(Boolean).join(" · ")}
    </p>}
  </>;
}

export default function PlanMeter({ usage, product, onOpenAll }: {
  usage: PlanUsage;
  /** Nombre del asistente, para el título del desglose. */
  product: string;
  onOpenAll: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const close = (): void => setAnchor(null);
  const headline = headlineWindow(usage);
  if (!headline) return null;
  const level = headline.severity === "critical" ? " critical" : headline.severity === "warning" ? " high" : "";
  const summary = usage.windows.map(window => `${window.label}: ${window.percent} %`).join(" · ");

  return <>
    <button ref={triggerRef} type="button" className={`chat-tray-chip chat-plan${level}`} aria-haspopup="menu" aria-expanded={!!anchor}
      aria-label={`Uso del plan de ${product}: ${summary}`}
      data-tip={anchor ? undefined : `Uso del plan · ${summary}`}
      onClick={() => setAnchor(anchor ? null : { element: triggerRef.current! })}>
      <span className="chat-tray-icon"><GaugeIcon size={14} /></span>
      <span className="chat-tray-text">{headline.percent} %</span>
      <span className="chat-plan-window">{shortLabel(headline)}</span>
    </button>
    <DropdownMenu anchor={anchor} triggerRef={triggerRef} label="Uso del plan"
      className={`chat-tray-menu chat-glass-menu chat-plan-menu${level}`} onClose={close}>
      <div className="chat-menu-label">Uso del plan{usage.plan ? ` · ${product} ${usage.plan}` : ` · ${product}`}</div>
      <PlanWindows usage={usage} now={Date.now()} />
      <button type="button" role="menuitem" tabIndex={-1} className="context-item chat-plan-all" onClick={() => { close(); onOpenAll(); }}>
        <span>Ver todas las cuentas</span>
      </button>
    </DropdownMenu>
  </>;
}
