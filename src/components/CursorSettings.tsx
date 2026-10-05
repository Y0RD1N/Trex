import { useId, type KeyboardEvent } from "react";
import { CURSOR_PRESETS, MAX_CURSOR_WIDTH, MIN_CURSOR_WIDTH, type CursorAppearance } from "../cursor";
import { DEFAULT_FONT_FAMILY } from "../api";
import type { CursorStyle, Settings } from "../types";
import { CheckIcon } from "./Icons";

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
      <span className="settings-preview-caption">Vista previa del cursor{settings.cursorStyle === "auto" ? " · ejemplo de bloque" : ""}</span>
      <span><span className="settings-prompt">❯</span> Escribe tu próxima idea <CursorSample settings={settings} blink /></span>
      <span className="settings-preview-muted">El color sigue el acento que elijas en Apariencia.</span>
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
      <div className="setting-field-info"><label htmlFor={`${id}-shape`}>Forma del cursor</label><p id={`${id}-shape-hint`}>Automático permite que cada aplicación elija su cursor.</p></div>
      <select id={`${id}-shape`} className="input" value={settings.cursorStyle} aria-describedby={`${id}-shape-hint`}
        onChange={event => onChange({ cursorStyle: event.currentTarget.value as CursorStyle })}>
        <option value="auto">Automático</option><option value="bar">Barra vertical</option><option value="block">Bloque</option><option value="underline">Subrayado</option>
      </select>
    </div>
    {settings.cursorStyle === "bar" && <div className="setting-field">
      <div className="setting-field-info"><span id={`${id}-width`}>Grosor de la barra</span><p>De 1 a 6 píxeles; elige lo que te resulte más cómodo.</p></div>
      <div className="settings-stepper" role="group" aria-labelledby={`${id}-width`}>
        <button type="button" aria-label="Reducir grosor del cursor" disabled={settings.cursorWidth <= MIN_CURSOR_WIDTH} onClick={() => onChange({ cursorWidth: settings.cursorWidth - 1 })}>−</button>
        <output aria-live="polite">{settings.cursorWidth}<span>px</span></output>
        <button type="button" aria-label="Aumentar grosor del cursor" disabled={settings.cursorWidth >= MAX_CURSOR_WIDTH} onClick={() => onChange({ cursorWidth: settings.cursorWidth + 1 })}>+</button>
      </div>
    </div>}
    <label className="settings-toggle">
      <span className="setting-field-info"><span id={`${id}-blink`}>Cursor parpadeante</span><span id={`${id}-blink-hint`}>Hace más fácil encontrar dónde estás escribiendo.</span></span>
      <input type="checkbox" role="switch" className="settings-switch" checked={settings.cursorBlink} aria-labelledby={`${id}-blink`} aria-describedby={`${id}-blink-hint`}
        onChange={event => onChange({ cursorBlink: event.currentTarget.checked })} />
    </label>
    <p className="settings-note">Guarda para aplicar el estilo a las terminales abiertas de Claude Code, Codex y tus shells, en Windows y Linux.</p>
  </>;
}
