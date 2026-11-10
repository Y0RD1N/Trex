import { useTimeFormat } from "../../hooks/useTimeFormat";
/**
 * Uso del plan de la cuenta: cada ventana (5 horas, semana…) con su barra y su
 * reinicio, en el menú «Uso y contexto». Normal es neutro; aviso y peligro
 * llevan su color de estado.
 */
import { extraLabel, resetLabel, type PlanUsage } from "../../planUsage";

/** Filas de uso: nombre, barra y cuándo se reinicia. */
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
