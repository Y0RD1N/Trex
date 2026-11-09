import { useEffect, useState } from "react";
import { ACCENT_PRESETS } from "../api";
import { CheckIcon, PlusIcon } from "./Icons";

type Props = { value: string; onChange: (value: string) => void; labelledBy: string };

/** «#abc» o «#aabbcc» (con o sin #) a «#aabbcc» en minúsculas; null si no es un color. */
export const normalizeHex = (text: string): string | null => {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? match[1].replace(/./g, digit => digit + digit) : match[1];
  return `#${digits.toLowerCase()}`;
};

/** Tinta (oscura o blanca) que se lee sobre una muestra del color dado. */
const inkOn = (hex: string): string => {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? "#18181b" : "#ffffff";
};

/**
 * Color de acento: las muestras de siempre y, además, un selector de color propio (el del sistema)
 * con un campo para escribir el hex. Si el color elegido se pareciera al fondo, `applyAccent` lo
 * acerca al blanco o al negro lo justo para que se lea.
 */
export default function AccentPicker({ value, onChange, labelledBy }: Props) {
  const current = normalizeHex(value) ?? "#f06a8d";
  const custom = !ACCENT_PRESETS.some(preset => preset.value.toLowerCase() === current);
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);

  return <>
    <div className="settings-accents" role="group" aria-labelledby={labelledBy}>
      {ACCENT_PRESETS.map(preset => {
        const selected = current === preset.value.toLowerCase();
        return <button key={preset.value} type="button" className={`settings-accent${selected ? " selected" : ""}`}
          aria-label={preset.name} aria-pressed={selected} title={preset.name} onClick={() => onChange(preset.value)}>
          <span style={{ backgroundColor: preset.value }}>{selected && <CheckIcon size={14} />}</span>
        </button>;
      })}
      <label className={`settings-accent settings-accent-custom${custom ? " selected" : ""}`} title="Elegir un color propio">
        <input type="color" value={current} aria-label="Elegir un color de acento propio" onChange={event => onChange(event.currentTarget.value)} />
        <span style={custom ? { background: current, color: inkOn(current) } : undefined}>{custom ? <CheckIcon size={14} /> : <PlusIcon size={14} />}</span>
      </label>
    </div>
    <label className="settings-hex">
      <span>Color propio</span>
      <input type="text" value={text} maxLength={7} spellCheck={false} autoComplete="off" aria-label="Color de acento en hexadecimal"
        aria-invalid={normalizeHex(text) === null || undefined} placeholder="#f06a8d"
        onChange={event => { const next = event.currentTarget.value; setText(next); const hex = normalizeHex(next); if (hex) onChange(hex); }}
        onBlur={() => setText(current)} />
    </label>
  </>;
}
