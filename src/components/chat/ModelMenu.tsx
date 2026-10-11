/**
 * Selectores de modelo y de nivel de esfuerzo de la bandeja del chat.
 *
 * Usan el catálogo que devuelve el propio CLI (`initialize` en Claude Code,
 * `model/list` en Codex), así que muestran los modelos disponibles para la
 * cuenta con su versión exacta y solo los niveles de esfuerzo que admite cada uno.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import DropdownMenu from "../DropdownMenu";
import AgentIcon from "../AgentIcon";
import { CheckIcon, ChevronIcon } from "../Icons";
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
function TrayMenu({ label, icon, text, menuLabel, className = "", openSignal = 0, children }: {
  label: string; icon: ReactNode; text: string; menuLabel: string; className?: string;
  /** Al cambiar, el menú se abre (por ejemplo, con `/model`). */
  openSignal?: number;
  children: (close: () => void) => ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const close = (): void => setAnchor(null);
  useEffect(() => { if (openSignal && triggerRef.current) setAnchor({ element: triggerRef.current }); }, [openSignal]);
  return <>
    <button ref={triggerRef} type="button" className="chat-tray-chip" aria-haspopup="menu" aria-expanded={!!anchor} aria-label={label}
      onClick={() => setAnchor(anchor ? null : { element: triggerRef.current! })}
      onKeyDown={event => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setAnchor({ element: event.currentTarget }); }
      }}>
      <span className="chat-tray-icon" aria-hidden="true">{icon}</span>
      <span className="chat-tray-text">{text}</span>
      <ChevronIcon size={12} />
    </button>
    <DropdownMenu anchor={anchor} triggerRef={triggerRef} label={menuLabel} className={`chat-tray-menu chat-glass-menu ${className}`} focusSelected
      align="start" onClose={close}>
      {children(close)}
    </DropdownMenu>
  </>;
}

export function ModelMenu({ provider, models, model, choice, onModel, openSignal }: {
  provider: AgentProvider; models: ModelInfo[]; model: string | null; choice: string | null; onModel: (value: string) => void;
  openSignal?: number;
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
  return <TrayMenu label={`Modelo: ${name}`} icon={<AgentIcon kind={provider} size={13} />} text={name} menuLabel="Modelo" className="chat-model-menu" openSignal={openSignal}>
    {close => <>
      <div className="chat-menu-label">Modelo</div>
      {main.length ? main.map(item => option(item, close))
        : <div className="chat-menu-empty">Los modelos aparecen cuando {provider === "codex" ? "Codex" : "Claude Code"} termina de arrancar.</div>}
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

export function EffortMenu({ levels, effort, onEffort, openSignal }: {
  levels: string[]; effort: string | null; onEffort: (level: string) => void; openSignal?: number;
}) {
  const known = levels.filter(level => EFFORT_LEVELS[level]);
  return <TrayMenu label={`Esfuerzo: ${effortLabel(effort) || "predeterminado"}`} icon={<EffortBars effort={effort} />}
    text={effortLabel(effort) || "Esfuerzo"} menuLabel="Nivel de esfuerzo" className="chat-effort-menu" openSignal={openSignal}>
    {close => <>
      <div className="chat-menu-label">Esfuerzo</div>
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
    </>}
  </TrayMenu>;
}
