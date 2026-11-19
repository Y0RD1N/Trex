/**
 * Resumen automático del contexto: un interruptor por asistente y, al
 * activarlo, el umbral en tokens. Todo empieza apagado.
 */
import { useId, useState } from "react";
import { AUTO_COMPACT_PROVIDERS, autoCompactThreshold, type AutoCompactProvider, type AutoCompactSettings as Value } from "../autoCompact";
import { formatNumber } from "../intl";
import SettingInfo from "./SettingInfo";

const grouped = (tokens: number): string => formatNumber(tokens);

export default function AutoCompactSettings({ value, onChange }: { value: Value; onChange: (value: Value) => void }) {
  const id = useId();
  // Lo que se está escribiendo; solo pasa al borrador cuando es un umbral válido.
  const [typing, setTyping] = useState<Partial<Record<AutoCompactProvider, string>>>({});
  const stopTyping = (provider: AutoCompactProvider): void => setTyping(previous => { const { [provider]: _, ...rest } = previous; return rest; });

  return <div className="settings-block">
    <h4 id={`${id}-title`}>Resumen automático<SettingInfo text="Al superar el umbral, el asistente resume la conversación y cada turno relee menos contexto: suele gastar menos del plan en conversaciones largas. A cambio, un resumen puede perder detalles." /></h4>
    <div className="settings-toggles" role="group" aria-labelledby={`${id}-title`}>
      {AUTO_COMPACT_PROVIDERS.map(spec => {
        const rule = value[spec.id], text = typing[spec.id] ?? String(rule.tokens);
        const typed = Number(text), valid = text.trim() !== "" && Number.isInteger(typed) && typed >= spec.min && typed <= spec.max;
        const inputId = `${id}-${spec.id}`;
        return <div key={spec.id} className="settings-autocompact-row">
          <label className="settings-toggle">
            <span className="setting-field-info"><span>{spec.name}</span><SettingInfo text={spec.hint} /></span>
            <input type="checkbox" role="switch" className="settings-switch" checked={rule.enabled}
              aria-label={`Resumen automático en ${spec.name}`}
              onChange={event => { stopTyping(spec.id); onChange({ ...value, [spec.id]: { enabled: event.currentTarget.checked, tokens: autoCompactThreshold(spec.id, rule.tokens) } }); }} />
          </label>
          {rule.enabled && <div className="setting-field settings-autocompact-threshold">
            <div className="setting-field-info">
              <label htmlFor={inputId}>Resumir al llegar a</label>
              <small id={`${inputId}-hint`}>de {grouped(spec.min)} a {grouped(spec.max)} tokens</small>
              {spec.detail && <SettingInfo text={spec.detail} />}
            </div>
            <div className="setting-field-control settings-autocompact-input">
              <input id={inputId} className="input" type="number" inputMode="numeric" min={spec.min} max={spec.max} step={10_000} value={text}
                aria-invalid={!valid} aria-describedby={`${inputId}-hint`}
                onChange={event => {
                  const next = event.currentTarget.value, tokens = Number(next);
                  setTyping(previous => ({ ...previous, [spec.id]: next }));
                  if (next.trim() !== "" && Number.isInteger(tokens) && tokens >= spec.min && tokens <= spec.max) onChange({ ...value, [spec.id]: { ...rule, tokens } });
                }}
                // Un valor a medias o fuera de rango no se guarda: al salir vuelve el último válido.
                onBlur={() => stopTyping(spec.id)} />
              <span aria-hidden="true">tokens</span>
            </div>
          </div>}
        </div>;
      })}
    </div>
  </div>;
}
