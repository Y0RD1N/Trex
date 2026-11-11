/**
 * Selectores de modelo y de nivel de esfuerzo (y velocidad) de la bandeja del chat.
 *
 * Usan el catálogo que devuelve el propio CLI (`initialize` en Claude Code,
 * `model/list` en Codex), así que muestran los modelos disponibles para la
 * cuenta con su versión exacta, solo los niveles de esfuerzo que admite cada
 * uno y la velocidad rápida cuando el modelo la ofrece.
 */
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import DropdownMenu from "../DropdownMenu";
import AgentIcon from "../AgentIcon";
import { BoltIcon, CheckIcon, ChevronIcon } from "../Icons";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import {
  EFFORT_LEVELS, currentModel, effortLabel, modelDescription, modelLabel, modelName, splitModels, type ModelInfo,
} from "../../chatState";
import type { AgentProvider } from "../../types";

/** Barras de intensidad: cuántas se llenan según el nivel. */
export function EffortBars({ effort }: { effort: string | null }) {
  const filled = effort ? EFFORT_LEVELS[effort]?.bars ?? 0 : 0;
  return <span className={`chat-effort-bars${effort === "ultra" ? " ultra" : ""}`} aria-hidden="true">
    {[0, 1, 2, 3, 4].map(index => <i key={index} className={index < filled ? "on" : ""} />)}
  </span>;
}

/** Píldora de la bandeja que abre un menú propio. */
function TrayMenu({ label, icon, text, badge, menuLabel, className = "", triggerClassName = "", openSignal = 0, children }: {
  label: string; icon: ReactNode; text: string; menuLabel: string; className?: string; triggerClassName?: string;
  /** Marca tras el texto (por ejemplo, el rayo de la velocidad rápida). */
  badge?: ReactNode;
  /** Al cambiar, el menú se abre (por ejemplo, con `/model`). */
  openSignal?: number;
  children: (close: () => void) => ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const close = (): void => setAnchor(null);
  useEffect(() => { if (openSignal && triggerRef.current) setAnchor({ element: triggerRef.current }); }, [openSignal]);
  return <>
    <button ref={triggerRef} type="button" className={`chat-tray-chip ${triggerClassName}`} aria-haspopup="menu" aria-expanded={!!anchor} aria-label={label}
      onClick={() => setAnchor(anchor ? null : { element: triggerRef.current! })}
      onKeyDown={event => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setAnchor({ element: event.currentTarget }); }
      }}>
      <span className="chat-tray-icon" aria-hidden="true">{icon}</span>
      <span className="chat-tray-text">{text}</span>
      {badge}
      <ChevronIcon size={12} />
    </button>
    <DropdownMenu anchor={anchor} triggerRef={triggerRef} label={menuLabel} className={`chat-tray-menu chat-glass-menu ${className}`} focusSelected
      align="start" onClose={close}>
      {children(close)}
    </DropdownMenu>
  </>;
}

function ModelMenuView({ provider, models, model, choice, onModel, openSignal, triggerClassName }: {
  provider: AgentProvider; models: ModelInfo[]; model: string | null; choice: string | null; onModel: (value: string) => void;
  openSignal?: number; triggerClassName?: string;
}) {
  const [showOthers, setShowOthers] = useState(false);
  const current = currentModel(models, model, choice);
  const { main, others } = splitModels(models);
  const name = current ? (current.value === "default" ? modelDescription(current, models).replace("Recomendado · ", "") : current.displayName)
    : modelLabel(model);
  const option = (item: ModelInfo, close: () => void) => {
    const selected = current?.value === item.value;
    return <button key={item.value} type="button" role="menuitemradio" aria-checked={selected} tabIndex={-1}
      className="context-item chat-menu-option" onClick={() => { close(); if (!selected) onModel(item.value); }}>
      <span className="chat-menu-option-text">
        <span>{modelName(item)}</span>
        <small>{modelDescription(item, models)}</small>
      </span>
      <span className="select-check" aria-hidden="true">{selected && <CheckIcon size={15} />}</span>
    </button>;
  };
  return <TrayMenu label={`Modelo: ${name}`} icon={<AgentIcon kind={provider} size={13} />} text={name} menuLabel="Modelo" className="chat-model-menu" openSignal={openSignal} triggerClassName={triggerClassName}>
    {close => <>
      <div className="chat-menu-label">Modelo</div>
      {main.length ? main.map(item => option(item, close))
        : <div className="chat-menu-empty">Los modelos aparecen cuando {provider === "trex" ? "Trex CLI" : provider === "codex" ? "Codex" : provider === "antigravity" ? "Antigravity" : "Claude Code"} termina de arrancar.</div>}
      {others.length > 0 && <>
        <button type="button" role="menuitem" tabIndex={-1} aria-expanded={showOthers} className="context-item chat-model-more"
          onClick={() => setShowOthers(!showOthers)}>
          <span>Otras versiones</span><small>{others.length}</small><ChevronIcon size={13} />
        </button>
        {showOthers && <div className="chat-model-others">{others.map(item => option(item, close))}</div>}
      </>}
    </>}
  </TrayMenu>;
}

/**
 * Esfuerzo y, si el modelo la admite, velocidad. Sin niveles de esfuerzo, el
 * menú queda solo con la velocidad.
 */
export function EffortMenu({ levels, effort, onEffort, speed, fast, onFast, openSignal }: {
  levels: string[]; effort: string | null; onEffort: (level: string) => void;
  /** Velocidad rápida del modelo en uso; null si no la tiene. */
  speed: ModelInfo["fast"] | null; fast: boolean; onFast: (fast: boolean) => void;
  openSignal?: number;
}) {
  const known = levels.filter(level => EFFORT_LEVELS[level]);
  const isFast = !!speed && fast;
  const speedName = isFast ? "Rápida" : "Estándar";
  const label = [known.length ? `Esfuerzo: ${effortLabel(effort) || "predeterminado"}` : "", speed ? `velocidad ${speedName.toLowerCase()}` : ""]
    .filter(Boolean).join(", ");
  return <TrayMenu label={label.charAt(0).toUpperCase() + label.slice(1)}
    icon={known.length ? <EffortBars effort={effort} /> : <BoltIcon size={13} />}
    text={known.length ? effortLabel(effort) || "Esfuerzo" : speedName}
    badge={known.length && isFast ? <span className="chat-fast-badge" aria-hidden="true"><BoltIcon size={12} /></span> : undefined}
    menuLabel={known.length ? (speed ? "Esfuerzo y velocidad" : "Nivel de esfuerzo") : "Velocidad"} className="chat-effort-menu" openSignal={openSignal}>
    {close => <>
      {known.length > 0 && <div className="chat-menu-label">Esfuerzo</div>}
      {known.map(level => {
        const selected = effort === level;
        return <button key={level} type="button" role="menuitemradio" aria-checked={selected} tabIndex={-1}
          className="context-item chat-menu-option" onClick={() => { close(); if (!selected) onEffort(level); }}>
          <EffortBars effort={level} />
          <span className="chat-menu-option-text">
            <span>{EFFORT_LEVELS[level].label}</span>
            <small>{EFFORT_LEVELS[level].hint}</small>
          </span>
          <span className="select-check" aria-hidden="true">{selected && <CheckIcon size={15} />}</span>
        </button>;
      })}
      {speed && <>
        {known.length > 0 && <div className="context-sep" role="separator" />}
        <div className="chat-menu-label">Velocidad</div>
        {[false, true].map(option => {
          const selected = isFast === option;
          return <button key={String(option)} type="button" role="menuitemradio" aria-checked={selected} tabIndex={-1}
            className="context-item chat-menu-option" onClick={() => { close(); if (!selected) onFast(option); }}>
            <span className={`chat-speed-icon${option ? " fast" : ""}`} aria-hidden="true"><BoltIcon size={14} /></span>
            <span className="chat-menu-option-text">
              <span>{option ? "Rápida" : "Estándar"}</span>
              <small>{option ? speed.hint : "Velocidad normal del modelo."}</small>
            </span>
            <span className="select-check" aria-hidden="true">{selected && <CheckIcon size={15} />}</span>
          </button>;
        })}
      </>}
    </>}
  </TrayMenu>;
}

/** Memorizado: el chat se repinta con cada tanda de texto y el menú no depende de ella. */
export const ModelMenu = memo(ModelMenuView);
