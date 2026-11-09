import { useId } from "react";
import type { Settings } from "../types";
import { TONE_PRESETS, matchingTone } from "../visualDesign";
import { toneUi } from "../palettes";
import { resolveThemeMode } from "../theme";
import { CheckIcon } from "./Icons";

type Props = { settings: Settings; onChange: (patch: Partial<Settings>) => void };

/**
 * Tono de la interfaz: combinaciones de un clic (tono y acento a la vez) y, para quien quiera
 * afinar, un matiz y una intensidad libres. El contraste no depende del tono: ver `toneUi`.
 */
export default function TonePicker({ settings, onChange }: Props) {
  const id = useId();
  const mode = resolveThemeMode(settings.appearance);
  const active = matchingTone(settings);

  return <div className="settings-block">
    <h4 id={`${id}-tone`}>Tono de la interfaz <span className="design-custom-label">{active ? "" : "Personalizado"}</span></h4>
    <div className="design-palette-grid tone-grid" role="group" aria-labelledby={`${id}-tone`}>
      {TONE_PRESETS.map(preset => {
        const ui = toneUi(mode, { hue: preset.hue, tint: preset.tint });
        const selected = active === preset.id;
        return <button key={preset.id} type="button" className={`design-palette${selected ? " selected" : ""}`} aria-pressed={selected}
          aria-label={`Combinación ${preset.name}: ${preset.description}`}
          onClick={() => onChange({ surfaceHue: preset.hue, surfaceTint: preset.tint, theme: preset.accent })}>
          <span className="design-palette-sample" aria-hidden="true" style={{ background: ui.sidebar }}>
            <span style={{ background: ui.app, borderColor: ui.border }}>
              <i style={{ background: ui.text }} />
              <span>
                <i style={{ background: preset.accent, opacity: 1 }} />
                <i style={{ background: ui.muted }} />
                <i style={{ background: ui.borderStrong }} />
              </span>
            </span>
          </span>
          <span className="design-choice-title">{preset.name}{selected && <CheckIcon size={13} />}</span>
          <span className="design-choice-description">{preset.description}</span>
        </button>;
      })}
    </div>
    <label className="design-slider" htmlFor={`${id}-hue`}>
      <span>Tono <output>{settings.surfaceHue}°</output></span>
      <input id={`${id}-hue`} className="tone-hue" type="range" min="0" max="360" value={settings.surfaceHue}
        onChange={event => onChange({ surfaceHue: Number(event.currentTarget.value) })} />
    </label>
    <label className="design-slider" htmlFor={`${id}-tint`}>
      <span>Intensidad <output>{settings.surfaceTint} %</output></span>
      <input id={`${id}-tint`} className="tone-tint" type="range" min="0" max="100" value={settings.surfaceTint}
        style={{ "--tone-hue": settings.surfaceHue } as React.CSSProperties}
        onChange={event => onChange({ surfaceTint: Number(event.currentTarget.value) })} />
    </label>
    <p className="settings-note">Cada combinación elige el tono y el acento a la vez; luego puedes retocar el acento aparte. Con intensidad 0 la interfaz es de grises puros. El contraste del texto es el mismo en todos los tonos.</p>
  </div>;
}
