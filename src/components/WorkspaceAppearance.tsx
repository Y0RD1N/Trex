import { useId, type CSSProperties } from "react";
import type { Settings } from "../types";
import { FRAME_PRESETS, matchingFrame } from "../visualDesign";
import { PALETTES, paletteFor } from "../palettes";
import { resolveThemeMode } from "../theme";
import { CheckIcon } from "./Icons";

type Props = { settings: Settings; onChange: (patch: Partial<Settings>) => void };

/** Vista previa local y controles del marco: no inicia otra terminal. */
export default function WorkspaceAppearance({ settings, onChange }: Props) {
  const id = useId();
  const mode = resolveThemeMode(settings.appearance);
  const selected = paletteFor(settings.colorScheme)[mode];
  const preset = matchingFrame(settings);
  const previewStyle = {
    "--preview-bg": selected.ui.sidebar,
    "--preview-term": selected.terminal.background,
    "--preview-fg": selected.terminal.foreground,
    "--preview-border": settings.terminalBorder ? selected.ui.borderStrong : "transparent",
    "--preview-radius": `${settings.terminalRadius}px`,
    "--preview-gap": `${settings.terminalMargin}px`,
    "--preview-selection": selected.terminal.selectionBackground,
  } as CSSProperties;

  return <>
    <div className="settings-block">
      <h4 id={`${id}-palettes`}>Colores del terminal</h4>
      <div className="design-palette-grid" role="group" aria-labelledby={`${id}-palettes`}>
        {PALETTES.map(palette => {
          const variant = palette[mode];
          return <button key={palette.id} type="button" className={`design-palette${settings.colorScheme === palette.id ? " selected" : ""}`}
            aria-pressed={settings.colorScheme === palette.id} aria-label={`Paleta ${palette.name}`}
            onClick={() => onChange({ colorScheme: palette.id, theme: palette.accent })}>
            <span className="design-palette-sample" aria-hidden="true" style={{ background: variant.ui.sidebar }}>
              <span style={{ background: variant.terminal.background, borderColor: variant.ui.border }}>
                <i style={{ background: variant.terminal.foreground }} />
                <span>{(["red", "green", "yellow", "blue", "magenta", "cyan"] as const).map(color => <i key={color} style={{ background: variant.terminal[color] }} />)}</span>
              </span>
            </span>
            <span className="design-choice-title">{palette.name}{settings.colorScheme === palette.id && <CheckIcon size={13} />}</span>
            <span className="design-choice-description">{palette.description}</span>
          </button>;
        })}
      </div>
      <p className="settings-note">La interfaz mantiene sus tonos neutros y un único acento. Estas paletas conservan los colores ANSI del terminal, en claro y oscuro.</p>
    </div>

    <div className="settings-block">
      <h4>Vista previa de tu terminal</h4>
      <div className="design-preview" style={previewStyle} aria-label="Vista previa del marco y los colores">
        <div className="design-preview-terminal">
          <span className="design-preview-caption">trex · tu espacio de trabajo</span>
          <span><span style={{ color: settings.theme }}>❯</span> npm run dev</span>
          <span style={{ color: selected.terminal.green }}>✓ Proyecto listo para trabajar</span>
          <span style={{ color: selected.terminal.red }}>Error: ejemplo de mensaje</span>
          <span><span className="design-preview-selection">Texto seleccionado</span> <span style={{ color: selected.terminal.blue }}>src/App.tsx</span></span>
        </div>
      </div>
    </div>

    <div className="settings-block">
      <h4 id={`${id}-frame`}>Estilo del marco <span className="design-custom-label">{preset ? "" : "Personalizado"}</span></h4>
      <div className="design-frame-grid" role="group" aria-labelledby={`${id}-frame`}>
        {FRAME_PRESETS.map(frame => <button key={frame.id} type="button" className={`design-frame${preset === frame.id ? " selected" : ""}`}
          aria-pressed={preset === frame.id} onClick={() => onChange({ terminalRadius: frame.terminalRadius, terminalMargin: frame.terminalMargin, terminalBorder: frame.terminalBorder })}>
          <span className="design-frame-sample" aria-hidden="true" style={{ padding: `${frame.terminalMargin / 2 + 2}px` }}>
            <span style={{ borderRadius: `${frame.terminalRadius / 2}px`, borderColor: frame.terminalBorder ? "var(--border-strong)" : "transparent" }} />
          </span>
          <span className="design-choice-title">{frame.name}{preset === frame.id && <CheckIcon size={13} />}</span>
          <span className="design-choice-description">{frame.description}</span>
        </button>)}
      </div>
      <label className="design-slider" htmlFor={`${id}-radius`}>
        <span>Redondeado <output>{settings.terminalRadius} px</output></span>
        <input id={`${id}-radius`} type="range" min="0" max="36" value={settings.terminalRadius} onChange={event => onChange({ terminalRadius: Number(event.currentTarget.value) })} />
      </label>
      <label className="design-slider" htmlFor={`${id}-margin`}>
        <span>Margen alrededor <output>{settings.terminalMargin} px</output></span>
        <input id={`${id}-margin`} type="range" min="0" max="24" value={settings.terminalMargin} onChange={event => onChange({ terminalMargin: Number(event.currentTarget.value) })} />
      </label>
      <label className="settings-toggle">
        <span className="setting-field-info"><span id={`${id}-border-label`}>Borde sutil</span><span id={`${id}-border-hint`}>Define el contorno con un borde y una sombra suave.</span></span>
        <input type="checkbox" role="switch" className="settings-switch" checked={settings.terminalBorder} aria-labelledby={`${id}-border-label`} aria-describedby={`${id}-border-hint`} onChange={event => onChange({ terminalBorder: event.currentTarget.checked })} />
      </label>
      <p className="settings-note">En ventanas pequeñas, el margen y el redondeado se ajustan para aprovechar el espacio.</p>
    </div>

    <div className="settings-block">
      <h4>Movimiento</h4>
      <label className="settings-toggle">
        <span className="setting-field-info"><span id={`${id}-motion-label`}>Reducir animaciones</span><span id={`${id}-motion-hint`}>Transiciones mínimas al cambiar de sesión o abrir paneles. También se respeta la preferencia de tu equipo.</span></span>
        <input type="checkbox" role="switch" className="settings-switch" checked={settings.motion === "reduced"} aria-labelledby={`${id}-motion-label`} aria-describedby={`${id}-motion-hint`} onChange={event => onChange({ motion: event.currentTarget.checked ? "reduced" : "system" })} />
      </label>
    </div>
  </>;
}
