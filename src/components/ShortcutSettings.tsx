import { useState, type KeyboardEvent } from "react";
import type { Settings } from "../types";
import { parseShortcut, shortcutFromEvent } from "../paste";
import {
  bindingError,
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  shortcutLabel,
  type ShortcutAction,
} from "../shortcuts";
export default function ShortcutSettings({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const [recording, setRecording] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const capture = (
    event: KeyboardEvent<HTMLInputElement>,
    action: ShortcutAction | "paste",
  ): void => {
    if (
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(null);
      event.currentTarget.blur();
      return;
    }
    if (
      ["Control", "Shift", "Alt", "Meta"].includes(event.key) ||
      event.repeat ||
      event.nativeEvent.isComposing
    )
      return;
    if (event.nativeEvent.getModifierState("AltGraph")) {
      setError("AltGr se reserva para escribir caracteres.");
      return;
    }
    const candidate = shortcutFromEvent(event.nativeEvent);
    if (!candidate) {
      setError("Usa una combinación con Ctrl, Alt o Meta.");
      return;
    }
    const bindings =
        action === "paste"
          ? settings.shortcuts
          : { ...settings.shortcuts, [action]: candidate },
      paste = action === "paste" ? candidate : settings.pasteShortcut;
    const problem = bindingError(bindings, paste);
    setError(problem);
    if (problem) return;
    onChange({ shortcuts: bindings, pasteShortcut: parseShortcut(paste)! });
    setRecording(null);
  };
  return (
    <>
      <p className="settings-note">
        Selecciona un campo y pulsa el nuevo atajo. Se aplica a las terminales
        abiertas al guardar.
      </p>
      <div className="shortcut-list">
        {[
          { id: "paste" as const, label: "Pegar texto e imágenes" },
          ...SHORTCUT_ACTIONS,
        ].map((action) => (
          <label className="shortcut-row" key={action.id}>
            <span>{action.label}</span>
            <input
              className="input settings-shortcut-input"
              data-shortcut-recorder
              aria-label={action.label}
              readOnly
              value={
                recording === action.id
                  ? "Pulsa tu atajo…"
                  : action.id === "paste"
                ? shortcutLabel(settings.pasteShortcut)
                : shortcutLabel(settings.shortcuts[action.id])
              }
              onFocus={() => setRecording(action.id)}
              onClick={() => setRecording(action.id)}
              onBlur={() => setRecording(null)}
              onKeyDown={(event) => capture(event, action.id)}
            />
          </label>
        ))}
      </div>
      <p role="status" className="settings-shortcut-error">
        {error ?? bindingError(settings.shortcuts, settings.pasteShortcut)}
      </p>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          onChange({
            shortcuts: { ...DEFAULT_SHORTCUTS },
            pasteShortcut: "Ctrl+V",
          });
          setRecording(null);
          setError(null);
        }}
      >
        Restablecer todos los atajos
      </button>
      <p className="settings-note">
        Ctrl+1…9 selecciona sesiones. Ctrl+Shift+V mantiene el pegado
        alternativo; Ctrl+C, Ctrl+D y Ctrl+Z conservan su función en el shell.
      </p>
    </>
  );
}
