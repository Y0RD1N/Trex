import { memo, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { contextPercent, contextTokensLabel, formatTokens, type ContextUsage } from "../../chatState";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import { accountUsageWindows, headlineWindow, type PlanUsage, type UsageSeverity } from "../../planUsage";
import DropdownMenu from "../DropdownMenu";
import { AlertIcon, CloseIcon, RefreshIcon } from "../Icons";
import { cacheHitRate, cacheHitRateLabel, cacheReadTokens, costKind, newTokenParts, newTokens, type ApiUsage } from "../../tokenUsage";
import { ContextDetails } from "./ContextMeter";
import { PlanWindows } from "./PlanMeter";
import "./UsageMenu.css";
import "./TokenUsage.css";
import { formatNumber } from "../../intl";

type Props = {
  usage: ContextUsage | null;
  plan: PlanUsage | null;
  costUsd?: number | null;
  apiUsage?: ApiUsage | null;
  showUnavailable?: boolean;
  controls?: { loading: boolean; error: string | null; refresh: () => Promise<void> };
  product: string;
  busy: boolean;
  onCompact: () => void;
  canCompact?: boolean;
  /** Umbral de resumen automático elegido en Ajustes con el que arrancó la sesión. */
  autoCompactAt?: number | null;
  onOpenAll: () => void;
};

const severityRank: Record<UsageSeverity, number> = { normal: 0, warning: 1, critical: 2 };
const percentLabel = (percent: number): string => percent > 0 && percent < 1 ? "<1 %" : `${Math.round(percent)} %`;

/** Un único acceso al contexto de la conversación y a los límites de la cuenta. */
function UsageMenu({ usage, plan, apiUsage, costUsd, product, busy, controls, showUnavailable, onCompact, canCompact, autoCompactAt, onOpenAll }: Props) {
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
  const general = [
    { key: "session", label: "5 h", window: generalWindows.session },
    { key: "weekly", label: "Semana", window: generalWindows.weekly },
  ];
  const visibleWindows = general.some(entry => entry.window) ? general
    : headline ? [{ key: headline.id, label: headline.label, window: headline }] : [];
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
    : showPlan ? `${limiting.label.replace(/^Sesión \(5 h\)/, "Sesión")} ${percentLabel(limiting.percent)}` : usage ? "Contexto" : "Uso";
  const scopedWarning = limiting && planSeverity > 0 && !visibleWindows.some(entry => entry.window?.id === limiting.id) ? limiting : null;
  const contextSummary = usage
    ? `Contexto: ${percent === null ? "porcentaje no disponible" : percentLabel(percent)} · ${contextTokensLabel(usage)}`
    : "Contexto: no disponible";
  const planSummary = plan?.windows.length
    ? `Uso del plan: ${plan.windows.map(window => `${window.label}: ${percentLabel(window.percent)}`).join(" · ")}`
    : "Uso del plan: porcentajes no disponibles";
  const reportedCost = apiUsage?.costUsd ?? costUsd;
  const money = (value: number): string => formatNumber(value, { style: "currency", currency: "USD", maximumFractionDigits: 6 });
  const cost = typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost > 0 && reportedCost < .000001 ? `< ${money(.000001)}` : money(reportedCost) : null;
  const costPartial = apiUsage?.costUsd !== null && apiUsage?.costUsd !== undefined && apiUsage.costPartial;
  // Lo nuevo de este chat; las lecturas de caché son reutilización barata del mismo contexto.
  const chatTokens = newTokens(apiUsage);
  const cachedTokens = cacheReadTokens(apiUsage);
  const hitRate = cacheHitRateLabel(cacheHitRate(apiUsage));
  const cacheNote = cachedTokens > 0 ? ` (+ ${formatNumber(cachedTokens)} leídos de caché${hitRate ? ` · ${hitRate} de aciertos` : ""})` : "";
  // Casi todo lo «nuevo» del primer turno es escribir en caché el prompt fijo del agente.
  const parts = newTokenParts(apiUsage);
  const partsNote = parts && parts.cacheWrite > 0
    ? `\n  entrada ${formatNumber(parts.input)} · escritura de caché ${formatNumber(parts.cacheWrite)} · salida ${formatNumber(parts.output)}` : "";
  const summary = `${contextSummary}${plan ? `\n${planSummary}` : ""}${chatTokens ? `\nTokens nuevos de este chat: ${formatNumber(chatTokens)}${cacheNote}${partsNote}` : ""}${cost ? `\n${costKind(apiUsage)}: ${cost}` : ""}`;
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

  if (!usage && !plan && !apiUsage && cost === null && !showUnavailable) return null;

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
        {!!chatTokens && <span className="chat-usage-tokens" aria-hidden="true">{formatTokens(chatTokens)} tokens nuevos</span>}
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
        {controls && <button type="button" className="chat-usage-close chat-usage-refresh" aria-label="Actualizar uso" title="Actualizar uso"
          disabled={busy || controls.loading} aria-busy={controls.loading} onClick={() => void controls.refresh().catch(() => undefined)}>
          {controls.loading ? <span className="chat-spinner" aria-hidden="true" /> : <RefreshIcon size={14} />}
        </button>}
        <button type="button" className="chat-usage-close" data-menu-autofocus aria-label="Cerrar uso y contexto"
          title="Cerrar" onClick={closeAndFocus}><CloseIcon size={14} /></button>
      </div>
      {controls?.error && <p className="chat-context-note error" role="status">No se pudo actualizar el uso: {controls.error} Se conserva la última lectura.</p>}
      {!usage && showUnavailable && <p className="chat-context-note">El contexto se mostrará cuando el proveedor informe una medición.</p>}
      {usage && <section className={`chat-usage-section chat-context-menu${contextLevel}`} aria-labelledby={`${id}-context`}>
        <h3 id={`${id}-context`} className="chat-menu-label">Contexto</h3>
        <ContextDetails usage={usage} product={product} busy={busy} canCompact={canCompact} autoCompactAt={autoCompactAt} inline onCompact={() => runAction(onCompact)} />
      </section>}
      {plan && <section className="chat-usage-section" aria-labelledby={`${id}-plan`}>
        <h3 id={`${id}-plan`} className="chat-menu-label">Uso del plan</h3>
        <p className="chat-usage-plan-name">{product}{plan.plan ? ` · ${plan.plan}` : ""}</p>
        {!plan.windows.length && <p className="chat-menu-empty">No hay ventanas de uso disponibles.</p>}
        <PlanWindows usage={plan} now={Date.now()} />
      </section>}
      {(apiUsage || showUnavailable) && <section className="chat-usage-section" aria-labelledby={`${id}-tokens`}>
        <h3 id={`${id}-tokens`} className="chat-menu-label">Consumo de la conversación</h3>
        {apiUsage ? <>
          {chatTokens !== null && <p className="chat-usage-plan-name usage-new-tokens">
            <strong className="usage-number">{formatNumber(chatTokens)}</strong> tokens nuevos
            {cachedTokens > 0 && <span className="usage-cache-note"> · + {formatNumber(cachedTokens)} leídos de caché</span>}
            {cost && <span className="usage-cache-note"> · {cost}{costPartial ? " (parcial)" : ""}</span>}
          </p>}
          <dl className="chat-api-usage">
            {([["Entrada", apiUsage.inputTokens], ["Salida", apiUsage.outputTokens], ["Razonamiento", apiUsage.reasoningTokens],
              ["Lectura de caché", apiUsage.cachedReadTokens], ["Escritura de caché", apiUsage.cachedWriteTokens],
              ["Total procesado", apiUsage.totalTokens], ["Intentos de API", apiUsage.requests]] as const).filter(([, value]) => value !== null).map(([label, value]) =>
              <div key={label}><dt>{label}</dt><dd>{formatNumber(value!)}</dd></div>)}
            {hitRate && <div><dt>Aciertos de caché</dt><dd>{hitRate}</dd></div>}
          </dl>
          <p className="chat-context-note">{apiUsage.partial ? "El proveedor no informó todos los contadores; el consumo mostrado es parcial. " : ""}Tokens nuevos = entrada sin caché + salida + escritura de caché. Las lecturas de caché reutilizan contexto ya enviado y se muestran aparte. {hitRate ? "Aciertos de caché = parte de la entrada servida desde la caché del proveedor, contando solo las peticiones que informaron ese contador. " : ""}El consumo corresponde a este chat.</p>
        </> : <p className="chat-context-note">Aún sin datos de consumo. Se mostrarán los tokens informados por el proveedor después de responder.</p>}
      </section>}
      <div className="chat-usage-footer">
        {cost ? <p className="chat-usage-plan-name">{costKind(apiUsage)}{costPartial ? " (parcial)" : ""}: <strong>{cost}</strong></p>
          : showUnavailable && <p className="chat-context-note">{product === "Trex CLI" ? "El proveedor no ha informado un coste. Consulta el saldo y la facturación en tu cuenta de API." : "Antigravity no ha informado un coste monetario para esta conversación."}</p>}
        <button type="button" className="context-item chat-plan-all" onClick={() => runAction(onOpenAll)}>
          Ver todas las cuentas
        </button>
      </div>
    </DropdownMenu>
  </>;
}

/** Memorizado: el chat se repinta con cada tanda de texto y este componente no depende de ella. */
export default memo(UsageMenu);
