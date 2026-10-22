import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { contextPercent, formatTokens, type ContextUsage } from "../../chatState";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import { accountUsageWindows, headlineWindow, type PlanUsage, type UsageSeverity } from "../../planUsage";
import DropdownMenu from "../DropdownMenu";
import { AlertIcon, CloseIcon } from "../Icons";
import { ContextDetails } from "./ContextMeter";
import { PlanWindows } from "./PlanMeter";
import "./UsageMenu.css";

type Props = {
  usage: ContextUsage | null;
  plan: PlanUsage | null;
  product: string;
  busy: boolean;
  onCompact: () => void;
  onOpenAll: () => void;
};

const severityRank: Record<UsageSeverity, number> = { normal: 0, warning: 1, critical: 2 };
const percentLabel = (percent: number): string => percent > 0 && percent < 1 ? "<1 %" : `${Math.round(percent)} %`;

/** Un único acceso al contexto de la conversación y a los límites de la cuenta. */
export default function UsageMenu({ usage, plan, product, busy, onCompact, onOpenAll }: Props) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const percent = contextPercent(usage);
  const contextSeverity = percent === null ? 0 : percent >= 90 ? 2 : percent >= 70 ? 1 : 0;
  // Una ventana secundaria puede alcanzar el límite después de elegirse la principal.
  const headline = headlineWindow(plan);
  // Las ventanas generales quedan siempre a la vista; los límites por modelo
  // siguen en el desglose y conservan sus avisos en el encabezado.
  const generalWindows = accountUsageWindows(plan);
  const visibleWindows = plan?.windows.length ? [
    { key: "session", label: "5 h", window: generalWindows.session },
    { key: "weekly", label: "Semana", window: generalWindows.weekly },
  ] : [];
  const limiting = plan?.windows.reduce((best, window) => !best
    || severityRank[window.severity] > severityRank[best.severity]
    || severityRank[window.severity] === severityRank[best.severity] && window.percent > best.percent
    ? window : best, headline) ?? null;
  const planSeverity = limiting ? severityRank[limiting.severity] : 0;
  const showPlan = limiting !== null && planSeverity > 0 && (planSeverity > contextSeverity
    || planSeverity === contextSeverity && limiting.percent >= (percent ?? 0));
  const contextLevel = contextSeverity >= 2 ? " critical" : contextSeverity >= 1 ? " high" : "";
  const level = percent !== null ? contextLevel : planSeverity >= 2 ? " critical" : planSeverity >= 1 ? " high" : "";
  const label = percent !== null ? `Contexto ${percentLabel(percent)}`
    : showPlan ? `${limiting.label.replace(/^Sesión \(5 h\)/, "Sesión")} ${percentLabel(limiting.percent)}` : "Uso";
  const scopedWarning = limiting && planSeverity > 0 && !visibleWindows.some(entry => entry.window?.id === limiting.id) ? limiting : null;
  const contextSummary = usage
    ? `Contexto: ${percent === null ? "porcentaje no disponible" : percentLabel(percent)} · ${formatTokens(usage.used)}${usage.window ? ` de ${formatTokens(usage.window)}` : ""} tokens`
    : "Contexto: no disponible";
  const planSummary = plan?.windows.length
    ? `Uso del plan: ${plan.windows.map(window => `${window.label}: ${percentLabel(window.percent)}`).join(" · ")}`
    : "Uso del plan: porcentajes no disponibles";
  const summary = `${contextSummary}\n${planSummary}`;
  const ringPercent = percent ?? (showPlan ? limiting.percent : 0);
  const ringLength = 2 * Math.PI * 5.5;
  const ringFilled = ringPercent > 0 ? Math.max(ringPercent, 4) : 0;
  const close = (): void => setAnchor(null);
  const closeAndFocus = (): void => {
    triggerRef.current?.focus({ preventScroll: true });
    close();
  };
  const runAction = (action: () => void): void => {
    triggerRef.current?.focus({ preventScroll: true });
    // El diálogo siguiente debe recordar el botón persistente para devolverle el foco.
    flushSync(close);
    action();
  };

  if (!usage && !plan) return null;

  return <>
    <button ref={triggerRef} type="button" className={`chat-tray-chip chat-usage-trigger${level}`}
      aria-haspopup="dialog" aria-expanded={!!anchor} aria-controls={anchor ? id : undefined}
      aria-label={`Uso y contexto: ${summary}`} data-tip={anchor ? undefined : summary}
      onClick={() => anchor ? closeAndFocus() : setAnchor({ element: triggerRef.current! })}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setAnchor({ element: triggerRef.current! });
        }
      }}>
      <span className="chat-usage-overview">
        <span className="chat-tray-icon"><svg className="chat-context-ring" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <circle className="track" cx="8" cy="8" r="5.5" />
          <circle className="value" cx="8" cy="8" r="5.5" strokeDasharray={ringLength}
            strokeDashoffset={ringLength * (1 - ringFilled / 100)} />
        </svg></span>
        <span className="chat-tray-text">{label}</span>
      </span>
      {visibleWindows.length > 0 && <span className="chat-usage-windows" aria-hidden="true">
        {visibleWindows.map(({ key, label, window }) => <span key={key} className={`chat-usage-window ${window?.severity ?? "unavailable"}`}>
          <span className="chat-usage-window-value">
            <span>{label}</span><b>{window ? percentLabel(window.percent) : "—"}</b>
          </span>
          <span className="chat-usage-window-bar"><i style={{ width: `${window ? Math.max(window.percent, window.percent > 0 ? 2 : 0) : 0}%` }} /></span>
        </span>)}
      </span>}
      {scopedWarning && percent !== null && <span className={`chat-usage-warning ${scopedWarning.severity}`} aria-hidden="true">
        <AlertIcon size={12} />{scopedWarning.label} {percentLabel(scopedWarning.percent)}
      </span>}
    </button>
    <DropdownMenu id={id} anchor={anchor} triggerRef={triggerRef} role="dialog" label="Uso y contexto"
      className="chat-tray-menu chat-glass-menu chat-usage-menu" onClose={close}>
      <div className="chat-usage-header">
        <strong>Uso y contexto</strong>
        <button type="button" className="chat-usage-close" data-menu-autofocus aria-label="Cerrar uso y contexto"
          title="Cerrar" onClick={closeAndFocus}><CloseIcon size={14} /></button>
      </div>
      {usage && <section className={`chat-usage-section chat-context-menu${contextLevel}`} aria-labelledby={`${id}-context`}>
        <h3 id={`${id}-context`} className="chat-menu-label">Contexto</h3>
        <ContextDetails usage={usage} product={product} busy={busy} inline onCompact={() => runAction(onCompact)} />
      </section>}
      {plan && <section className="chat-usage-section" aria-labelledby={`${id}-plan`}>
        <h3 id={`${id}-plan`} className="chat-menu-label">Uso del plan</h3>
        <p className="chat-usage-plan-name">{product}{plan.plan ? ` · ${plan.plan}` : ""}</p>
        {!plan.windows.length && <p className="chat-menu-empty">No hay ventanas de uso disponibles.</p>}
        <PlanWindows usage={plan} now={Date.now()} />
      </section>}
      <div className="chat-usage-footer">
        <button type="button" className="context-item chat-plan-all" onClick={() => runAction(onOpenAll)}>
          Ver todas las cuentas
        </button>
      </div>
    </DropdownMenu>
  </>;
}
