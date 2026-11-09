import { useId, type CSSProperties } from "react";
import type { Settings } from "../types";
import { FRAME_PRESETS, WINDOW_MATERIALS, matchingFrame } from "../visualDesign";
import { PALETTES, paletteFor, toneUi } from "../palettes";
import { resolveThemeMode } from "../theme";
import { CheckIcon } from "./Icons";
import { IS_WINDOWS } from "../platform";
import TonePicker from "./TonePicker";

type Props = { settings: Settings; onChange: (patch: Partial<Settings>) => void };

/** Vista previa local y controles del marco: no inicia otra terminal. */
export default function WorkspaceAppearance({ settings, onChange }: Props) {
  const id = useId();
  const mode = resolveThemeMode(settings.appearance);
  const selected = paletteFor(settings.colorScheme)[mode];
  // Las superficies salen del tono elegido; la paleta solo aporta los colores ANSI.
  const ui = toneUi(mode, { hue: settings.surfaceHue, tint: settings.surfaceTint });
  const preset = matchingFrame(settings);
  const previewStyle = {
    "--preview-bg": ui.sidebar,
    "--preview-term": ui.app,
    "--preview-fg": ui.text,
    "--preview-border": settings.terminalBorder ? ui.borderStrong : "transparent",
    "--preview-radius": `${settings.terminalRadius}px`,
    "--preview-gap": `${settings.terminalMargin}px`,
    "--preview-selection": selected.terminal.selectionBackground,
  } as CSSProperties;

  return <>
    <TonePicker settings={settings} onChange={onChange} />

    <div className="settings-block">
      <h4 id={`${id}-palettes`}>Colores del terminal</h4>
      <div className="design-palette-grid" role="group" aria-labelledby={`${id}-palettes`}>
        {PALETTES.map(palette => {
          const variant = palette[mode];
          return <button key={palette.id} type="button" className={`design-palette${settings.colorScheme === palette.id ? " selected" : ""}`}
            aria-pressed={settings.colorScheme === palette.id} aria-label={`Paleta ${palette.name}`}
            onClick={() => onChange({ colorScheme: palette.id })}>
            <span className="design-palette-sample" aria-hidden="true" style={{ background: ui.sidebar }}>
              <span style={{ background: ui.app, borderColor: ui.border }}>
                <i style={{ background: ui.text }} />
                <span>{(["red", "green", "yellow", "blue", "magenta", "cyan"] as const).map(color => <i key={color} style={{ background: variant.terminal[color] }} />)}</span>
              </span>
            </span>
            <span className="design-choice-title">{palette.name}{settings.colorScheme === palette.id && <CheckIcon size={13} />}</span>
            <span className="design-choice-description">{palette.description}</span>
          </button>;
        })}
      </div>
      <p className="settings-note">Estas paletas solo cambian los colores ANSI del terminal, en claro y oscuro; el tono y el acento los eliges arriba y abajo.</p>
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
      <h4>Transparencias</h4>
      <label className="settings-toggle">
        <span className="setting-field-info"><span id={`${id}-glass-label`}>Efecto cristal</span><span id={`${id}-glass-hint`}>{IS_WINDOWS ? "Mica de Windows 11 detrás de la ventana y un desenfoque suave" : "Un desenfoque suave"} en la cabecera del chat, la caja de mensaje y los menús. Si tu equipo pide reducir las transparencias, se respeta.</span></span>
        <input type="checkbox" role="switch" className="settings-switch" checked={settings.glass} aria-labelledby={`${id}-glass-label`} aria-describedby={`${id}-glass-hint`} onChange={event => onChange({ glass: event.currentTarget.checked })} />
      </label>
      {IS_WINDOWS && <>
        <h4 id={`${id}-material`}>Fondo de la ventana</h4>
        <div className="design-palette-grid design-material-grid" role="group" aria-labelledby={`${id}-material`}>
          {WINDOW_MATERIALS.map(material => <button key={material.id} type="button" disabled={!settings.glass && material.id !== "solid"}
            className={`design-frame${settings.windowBackdrop === material.id ? " selected" : ""}`}
            aria-pressed={settings.windowBackdrop === material.id} onClick={() => onChange({ windowBackdrop: material.id })}>
            <span className="design-choice-title">{material.name}{settings.windowBackdrop === material.id && <CheckIcon size={13} />}</span>
            <span className="design-choice-description">{material.description}</span>
          </button>)}
        </div>
        <label className="design-slider" htmlFor={`${id}-tint`}>
          <span>Gris sobre el material <output>{settings.materialTint} %</output></span>
          <input id={`${id}-tint`} type="range" min="20" max="90" step="5" value={settings.materialTint} disabled={!settings.glass || settings.windowBackdrop === "solid"}
            onChange={event => onChange({ materialTint: Number(event.currentTarget.value) })} />
        </label>
        <p className="settings-note">Mica y Acrílico los pinta Windows 11 detrás de la ventana. Más gris lo vuelve más sobrio; menos deja ver más el color de tu fondo de escritorio. En Windows 10 la ventana sigue opaca y solo se difumina lo que flota.</p>
      </>}
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
