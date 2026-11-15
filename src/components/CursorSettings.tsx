import { useId, type KeyboardEvent } from "react";
import { CURSOR_PRESETS, MAX_CURSOR_WIDTH, MIN_CURSOR_WIDTH, type CursorAppearance } from "../cursor";
import { DEFAULT_FONT_FAMILY } from "../api";
import type { CursorStyle, Settings } from "../types";
import { CheckIcon, MinusIcon, PlusIcon } from "./Icons";
import Select from "./Select";

function CursorSample({ settings, blink = false }: { settings: CursorAppearance; blink?: boolean }) {
  const style = settings.cursorStyle === "auto" ? "block" : settings.cursorStyle;
  return <span className={`settings-cursor-sample ${style}${blink && settings.cursorBlink ? " blinking" : ""}`}
    style={style === "bar" ? { width: settings.cursorWidth } : undefined} aria-hidden="true" />;
}

export default function CursorSettings({ settings, onChange }: { settings: Settings; onChange: (partial: Partial<Settings>) => void }) {
  const id = useId();
  const selectedPreset = CURSOR_PRESETS.findIndex(preset => settings.cursorStyle === preset.cursorStyle && (preset.cursorStyle !== "bar" || settings.cursorWidth === preset.cursorWidth));
  const choosePreset = (index: number): void => {
    const preset = CURSOR_PRESETS[index];
    onChange({ cursorStyle: preset.cursorStyle, cursorWidth: preset.cursorWidth });
  };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number;
    if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (index + 1) % CURSOR_PRESETS.length;
    else if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (index + CURSOR_PRESETS.length - 1) % CURSOR_PRESETS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = CURSOR_PRESETS.length - 1;
    else return;
    event.preventDefault();
    choosePreset(next);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return <>
    <div className="settings-terminal-preview" aria-label="Vista previa del cursor" style={{ fontSize: settings.fontSize, fontFamily: settings.fontFamily.trim() || DEFAULT_FONT_FAMILY }}>
      <span><span className="settings-prompt">❯</span> Escribe tu próxima idea <CursorSample settings={settings} blink /></span>
    </div>
    <div className="settings-block">
      <h4 id={`${id}-presets`}>Estilos predefinidos</h4>
      <div className="settings-cursor-presets" role="radiogroup" aria-labelledby={`${id}-presets`}>
        {CURSOR_PRESETS.map((preset, index) => {
          const selected = selectedPreset === index;
          return <button key={preset.name} type="button" role="radio" aria-checked={selected}
            className={`settings-cursor-preset${selected ? " selected" : ""}`}
            tabIndex={index === Math.max(0, selectedPreset) ? 0 : -1} onClick={() => choosePreset(index)} onKeyDown={event => navigate(event, index)}>
            <span className="settings-cursor-glyph"><CursorSample settings={{ ...preset, cursorBlink: false }} /></span>
            <span><strong>{preset.name}</strong><small>{preset.description}</small></span>
            {selected && <CheckIcon size={13} />}
          </button>;
        })}
      </div>
    </div>
    <div className="setting-field">
      <div className="setting-field-info"><label htmlFor={`${id}-shape`}>Forma</label><small id={`${id}-shape-hint`}>{settings.cursorStyle === "auto" ? "la elige cada aplicación" : ""}</small></div>
      <Select id={`${id}-shape`} value={settings.cursorStyle} aria-describedby={`${id}-shape-hint`}
        onChange={value => onChange({ cursorStyle: value as CursorStyle })} options={[
          { value: "auto", label: "Automático" }, { value: "bar", label: "Barra vertical" },
          { value: "block", label: "Bloque" }, { value: "underline", label: "Subrayado" },
        ]} />
    </div>
    {settings.cursorStyle === "bar" && <div className="setting-field">
      <div className="setting-field-info"><span id={`${id}-width`}>Grosor</span></div>
      <div className="settings-stepper" role="group" aria-labelledby={`${id}-width`}>
        <button type="button" aria-label="Reducir grosor del cursor" disabled={settings.cursorWidth <= MIN_CURSOR_WIDTH} onClick={() => onChange({ cursorWidth: settings.cursorWidth - 1 })}><MinusIcon size={14} /></button>
        <output aria-live="polite">{settings.cursorWidth}<span>px</span></output>
        <button type="button" aria-label="Aumentar grosor del cursor" disabled={settings.cursorWidth >= MAX_CURSOR_WIDTH} onClick={() => onChange({ cursorWidth: settings.cursorWidth + 1 })}><PlusIcon size={14} /></button>
      </div>
    </div>}
    <label className="settings-toggle">
      <span className="setting-field-info"><span id={`${id}-blink`}>Parpadeo</span></span>
      <input type="checkbox" role="switch" className="settings-switch" checked={settings.cursorBlink} aria-labelledby={`${id}-blink`}
        onChange={event => onChange({ cursorBlink: event.currentTarget.checked })} />
    </label>
  </>;
}
