import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import DropdownMenu from "../DropdownMenu";
import { AlertIcon, BoltIcon, CheckIcon, ChevronIcon, CloseIcon, SettingsIcon } from "../Icons";
import type { SelectOption } from "../Select";
import { EFFORT_LEVELS, type ModelInfo } from "../../chatState";
import type { FloatingAnchor } from "../../hooks/useFloatingPosition";
import "./ComposerSettings.css";

type Props = {
  mode: string;
  modes: SelectOption[];
  onMode: (value: string) => void;
  levels: string[];
  effort: string | null;
  onEffort: (value: string) => void;
  speed: ModelInfo["fast"] | null;
  fast: boolean;
  onFast: (value: boolean) => void;
  openSignal?: { mode: number; effort: number };
};

type Section = "mode" | "effort";
const fullAccess = (mode: string): boolean => mode === "full" || mode === "bypassPermissions";

export default function ComposerSettings({ mode, modes, onMode, levels, effort, onEffort, speed, fast, onFast, openSignal }: Props) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null);
  const [section, setSection] = useState<Section>("mode");
  const [focusRequest, setFocusRequest] = useState(0);
  const signalsRef = useRef({ mode: 0, effort: 0 });
  const modeSignal = openSignal?.mode ?? 0;
  const effortSignal = openSignal?.effort ?? 0;
  const selectedMode = modes.find(option => option.value === mode);
  const modeLabel = selectedMode?.label ?? mode;
  const unrestricted = fullAccess(mode);
  const triggerText = unrestricted ? "Acceso total" : mode === "plan" ? "Planificar" : mode === "read-only" ? "Solo lectura" : "Ajustes";
  const knownLevels = levels.filter(level => EFFORT_LEVELS[level]);
  const modeTarget = modes.find(option => option.value === mode && !option.disabled) ?? modes.find(option => !option.disabled);
  const effortTarget = knownLevels.find(level => level === effort) ?? knownLevels[0];
  const focusEffort = section === "effort" && !!effortTarget;
  const focusSpeed = section === "effort" && !focusEffort && !!speed;
  const focusMode = !focusEffort && !focusSpeed;

  const close = (): void => {
    setAnchor(null);
    setFocusRequest(0);
  };
  const restoreAndClose = (): void => {
    triggerRef.current?.focus({ preventScroll: true });
    close();
  };
  const open = (target: Section): void => {
    if (!triggerRef.current) return;
    setSection(target);
    if (anchor) setFocusRequest(request => request + 1);
    else setAnchor({ element: triggerRef.current });
  };

  useEffect(() => {
    const previous = signalsRef.current;
    signalsRef.current = { mode: modeSignal, effort: effortSignal };
    if (effortSignal !== previous.effort && effortSignal) open("effort");
    else if (modeSignal !== previous.mode && modeSignal) open("mode");
  }, [modeSignal, effortSignal]);

  // DropdownMenu handles initial focus; an already open dialog needs a fresh
  // focus request for each slash command, even when it targets the same section.
  useLayoutEffect(() => {
    if (!anchor || !focusRequest) return;
    const target = document.getElementById(menuId)?.querySelector<HTMLElement>("[data-menu-autofocus]");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }, [anchor, focusRequest, menuId]);

  return <>
    <button ref={triggerRef} type="button"
      className={`chat-tray-chip chat-composer-settings-trigger${unrestricted ? " is-full" : ""}`}
      aria-label={`Ajustes del agente: ${modeLabel}`} aria-haspopup="dialog" aria-expanded={!!anchor}
      aria-controls={anchor ? menuId : undefined}
      onClick={() => anchor ? close() : open("mode")}
      onKeyDown={event => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          open("mode");
        }
      }}>
      <span className="chat-tray-icon" aria-hidden="true">{unrestricted ? <AlertIcon size={14} /> : <SettingsIcon size={14} />}</span>
      <span className="chat-tray-text">{triggerText}</span>
      <ChevronIcon size={12} />
    </button>
    <DropdownMenu id={menuId} anchor={anchor} triggerRef={triggerRef} label="Ajustes del agente" role="dialog" align="start"
      className="chat-glass-menu chat-composer-settings" onClose={close}>
      <div className="chat-composer-settings-header">
        <h2>Ajustes del agente</h2>
        <button type="button" className="chat-composer-settings-close" aria-label="Cerrar ajustes del agente"
          data-menu-autofocus={focusMode && !modeTarget ? "" : undefined} onClick={restoreAndClose}><CloseIcon size={16} /></button>
      </div>
      <section className="chat-composer-settings-section" aria-labelledby={`${menuId}-permissions`}>
        <h3 id={`${menuId}-permissions`}>Permisos</h3>
        <div className="chat-composer-settings-modes">
          {modes.map(option => {
            const selected = option.value === mode;
            return <button key={option.value} type="button" disabled={option.disabled} aria-pressed={selected}
              className={`chat-composer-settings-mode${fullAccess(option.value) ? " is-full" : ""}`}
              data-menu-autofocus={focusMode && option === modeTarget ? "" : undefined}
              onClick={() => { if (!selected) onMode(option.value); }}>
              <span className="chat-composer-settings-mode-heading">
                <span>{option.label}</span>
                <span className="chat-composer-settings-check" aria-hidden="true">{selected && <CheckIcon size={14} />}</span>
              </span>
              {option.description && <small>{option.description}</small>}
            </button>;
          })}
        </div>
      </section>
      {knownLevels.length > 0 && <section className="chat-composer-settings-section" aria-labelledby={`${menuId}-effort`}>
        <h3 id={`${menuId}-effort`}>Esfuerzo</h3>
        <div className="chat-composer-settings-efforts">
          {knownLevels.map(level => <button key={level} type="button" aria-pressed={effort === level}
            className="chat-composer-settings-effort" title={EFFORT_LEVELS[level].hint}
            data-menu-autofocus={focusEffort && level === effortTarget ? "" : undefined}
            onClick={() => { if (effort !== level) onEffort(level); }}>{EFFORT_LEVELS[level].label}</button>)}
        </div>
      </section>}
      {speed && <div className="chat-composer-settings-section">
        <button type="button" role="switch" aria-checked={fast} aria-labelledby={`${menuId}-speed`}
          aria-describedby={`${menuId}-speed-hint`} className="chat-composer-settings-speed"
          data-menu-autofocus={focusSpeed ? "" : undefined} onClick={() => onFast(!fast)}>
          <BoltIcon size={16} />
          <span id={`${menuId}-speed`}>Velocidad rápida</span>
          <span className="chat-composer-settings-switch" aria-hidden="true"><span /></span>
        </button>
        <p id={`${menuId}-speed-hint`} className="chat-composer-settings-hint">{speed.hint}</p>
      </div>}
    </DropdownMenu>
  </>;
}
