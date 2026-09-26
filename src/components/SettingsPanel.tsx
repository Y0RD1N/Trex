/**
 * Panel modal de ajustes: apariencia (claro / oscuro / sistema y color de
 * acento), shell, comando y argumentos de Claude, tipografía del terminal y
 * comportamiento de las pestañas.
 *
 * Estética de "Ajustes del Sistema" de macOS: secciones con título en
 * versalitas y hairline, filas etiqueta/control a dos columnas y control
 * segmentado con píldora deslizante.
 *
 * El modo y el acento se previsualizan en vivo; el resto se aplica al guardar
 * (el padre actualiza los ajustes y los terminales abiertos reaccionan). Si se
 * cierra con cambios pendientes, se pide confirmación con el diálogo propio.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ACCENT_PRESETS, clamp } from "../api";
import { APPEARANCE_OPTIONS, applyTheme, normalizeAppearance, type Appearance } from "../theme";
import type { AppInfo, ClaudeInfo, Settings } from "../types";
import { useDialog } from "./DialogProvider";
import { CloseIcon, MoonIcon, SunIcon, SystemIcon } from "./Icons";
import { ClaudeStatusCard } from "./WelcomeScreen";

type Props = {
  settings: Settings;
  appInfo: AppInfo | null;
  claudeInfo: ClaudeInfo | null;
  onSave: (settings: Settings) => void;
  onClose: () => void;
  onRedetect: () => void;
};

const ARGS_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "ninguno", value: "" },
  { label: "--continue", value: "--continue" },
  { label: "--resume", value: "--resume" },
  { label: "--dangerously-skip-permissions", value: "--dangerously-skip-permissions" },
];

export default function SettingsPanel({
  settings,
  appInfo,
  claudeInfo,
  onSave,
  onClose,
  onRedetect,
}: Props) {
  const dialog = useDialog();
  const [draft, setDraft] = useState<Settings>(settings);
  const savedThemeRef = useRef(settings.theme);
  savedThemeRef.current = settings.theme;
  const savedAppearanceRef = useRef(settings.appearance);
  savedAppearanceRef.current = settings.appearance;

  // Previsualización en vivo del modo y del acento mientras el panel está abierto.
  useEffect(() => {
    applyTheme(draft.appearance, draft.theme);
  }, [draft.appearance, draft.theme]);

  // Al cerrar sin guardar, el tema vuelve a los valores persistidos.
  useEffect(() => {
    return () => {
      applyTheme(savedAppearanceRef.current, savedThemeRef.current);
    };
  }, []);

  /** ¿Hay cambios sin guardar respecto a los ajustes persistidos? */
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );

  /**
   * Cerrar con cambios pendientes pide confirmación (diálogo propio, tono
   * neutro); sin cambios se cierra directamente.
   */
  const requestClose = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    void dialog
      .confirm({
        title: "¿Descartar los cambios?",
        message: "Has modificado ajustes que todavía no se han guardado.",
        detail: "Si descartas, el panel y el tema vuelven a como estaban.",
        confirmLabel: "Descartar",
        cancelLabel: "Seguir editando",
      })
      .then((ok) => {
        if (ok) onClose();
      });
  }, [dialog, dirty, onClose]);

  // Escape cierra el panel (preguntando antes si hay cambios pendientes).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  const patch = (partial: Partial<Settings>): void =>
    setDraft((prev) => ({ ...prev, ...partial }));

  const shellOptions = appInfo?.shellOptions ?? [
    { id: "default", label: "Shell por defecto", available: true, program: "" },
  ];

  const handleSave = (): void => {
    onSave({
      ...draft,
      claudeCommand: draft.claudeCommand.trim() || "claude",
      claudeArgs: draft.claudeArgs.trim(),
      fontSize: clamp(Math.round(draft.fontSize), 10, 24),
      scrollback: clamp(Math.round(draft.scrollback), 200, 200000),
      shell: draft.shell || "default",
      launchMode: draft.launchMode === "inject" ? "inject" : "arg",
      appearance: normalizeAppearance(draft.appearance),
    });
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header">
          <div className="modal-heading">
            <h2 className="modal-title" id="settings-title">
              Ajustes
            </h2>
            <p className="modal-subtitle">Apariencia, Claude Code y terminal</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="Cerrar (Esc)"
            aria-label="Cerrar ajustes"
            onClick={requestClose}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="modal-body">
          <section className="settings-section">
            <h3 className="settings-section-title">Apariencia</h3>
            <Field label="Tema de la interfaz" hint="«Sistema» sigue el modo claro/oscuro del equipo">
              <AppearanceControl
                value={normalizeAppearance(draft.appearance)}
                onChange={(appearance) => patch({ appearance })}
              />
            </Field>
            <Field label="Color de acento" hint="Se usa en la interfaz y en el cursor del terminal">
              <div className="accent-swatches">
                {ACCENT_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    title={preset.name}
                    aria-label={preset.name}
                    aria-pressed={draft.theme === preset.value}
                    className={`swatch${draft.theme === preset.value ? " active" : ""}`}
                    style={{ backgroundColor: preset.value }}
                    onClick={() => patch({ theme: preset.value })}
                  />
                ))}
              </div>
            </Field>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">Claude Code</h3>
            <ClaudeStatusCard claudeInfo={claudeInfo} appInfo={appInfo} onRedetect={onRedetect} />
            <Field label="Comando de Claude" hint="Ejecutable que se lanza dentro del PTY">
              <input
                className="input"
                value={draft.claudeCommand}
                spellCheck={false}
                placeholder="claude"
                onChange={(event) => patch({ claudeCommand: event.currentTarget.value })}
              />
            </Field>
            <Field label="Argumentos" hint="Se añaden al comando de Claude al abrir una pestaña">
              <input
                className="input"
                value={draft.claudeArgs}
                spellCheck={false}
                placeholder="sin argumentos"
                onChange={(event) => patch({ claudeArgs: event.currentTarget.value })}
              />
              <div className="chips">
                {ARGS_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={`chip${draft.claudeArgs === preset.value ? " active" : ""}`}
                    onClick={() => patch({ claudeArgs: preset.value })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Field>
            <Check
              label="Ejecutar Claude automáticamente"
              hint="Si lo desactivas, las pestañas nuevas abren un shell normal"
              checked={draft.autoRunClaude}
              onChange={(value) => patch({ autoRunClaude: value })}
            />
            <Field
              label="Modo de lanzamiento"
              hint="«arg» pasa el comando como argumento; «inject» lo escribe en el shell"
            >
              <select
                className="input"
                value={draft.launchMode}
                onChange={(event) => patch({ launchMode: event.currentTarget.value })}
              >
                <option value="arg">arg — como argumento del shell</option>
                <option value="inject">inject — escribirlo en el terminal</option>
              </select>
            </Field>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">Terminal</h3>
            <Field label="Shell">
              <select
                className="input"
                value={draft.shell}
                onChange={(event) => patch({ shell: event.currentTarget.value })}
              >
                {shellOptions.map((option) => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.label}
                    {option.available ? "" : " — no disponible"}
                  </option>
                ))}
              </select>
            </Field>
            <div className="field-row">
              <Field label="Tamaño de fuente" hint="10 – 24 px" stacked>
                <input
                  className="input"
                  type="number"
                  min={10}
                  max={24}
                  value={draft.fontSize}
                  onChange={(event) =>
                    patch({ fontSize: Number(event.currentTarget.value) || 14 })
                  }
                />
              </Field>
              <Field label="Scrollback" hint="Líneas conservadas en el buffer" stacked>
                <input
                  className="input"
                  type="number"
                  min={200}
                  step={100}
                  value={draft.scrollback}
                  onChange={(event) =>
                    patch({ scrollback: Number(event.currentTarget.value) || 10000 })
                  }
                />
              </Field>
            </div>
            <Field label="Familia tipográfica" hint="Vacío = familia monoespaciada por defecto">
              <input
                className="input"
                value={draft.fontFamily}
                spellCheck={false}
                placeholder={'"SF Mono", ui-monospace, Consolas, monospace'}
                onChange={(event) => patch({ fontFamily: event.currentTarget.value })}
              />
            </Field>
            <div className="checks-grid">
              <Check
                label="Cursor parpadeante"
                checked={draft.cursorBlink}
                onChange={(value) => patch({ cursorBlink: value })}
              />
              <Check
                label="Copiar al seleccionar"
                hint="Copia el texto seleccionado con el ratón"
                checked={draft.copyOnSelect}
                onChange={(value) => patch({ copyOnSelect: value })}
              />
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">Comportamiento</h3>
            <div className="checks-grid">
              <Check
                label="Confirmar antes de cerrar pestañas activas"
                hint="Usa el diálogo propio de trex"
                checked={draft.confirmCloseTab}
                onChange={(value) => patch({ confirmCloseTab: value })}
              />
              <Check
                label="Restaurar pestañas al iniciar"
                hint="Reabre los terminales que quedaron abiertos la última vez"
                checked={draft.restoreOnStart}
                onChange={(value) => patch({ restoreOnStart: value })}
              />
            </div>
          </section>
        </div>

        <footer className="modal-footer">
          <div className="modal-meta">
            <div className="modal-meta-line">
              <span className="modal-meta-label">Configuración</span>
              <span className="mono">{appInfo?.configPath ?? "—"}</span>
            </div>
            <div className="modal-meta-line">
              <span className="modal-meta-label">Versión</span>
              <span className="mono">{appInfo?.version ?? "—"}</span>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={requestClose}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave}>
              Guardar cambios
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// --- Control segmentado de apariencia ---------------------------------------

type AppearanceControlProps = {
  value: Appearance;
  onChange: (appearance: Appearance) => void;
};

const APPEARANCE_ICONS: Record<Appearance, ReactNode> = {
  system: <SystemIcon size={16} />,
  light: <SunIcon size={16} />,
  dark: <MoonIcon size={16} />,
};

/**
 * Tres opciones con una píldora que se desliza: la posición se pasa al CSS con
 * la variable `--seg-index` y la transición la resuelve `transform`.
 */
function AppearanceControl({ value, onChange }: AppearanceControlProps) {
  const index = Math.max(
    0,
    APPEARANCE_OPTIONS.findIndex((option) => option.id === value),
  );

  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label="Tema de la interfaz"
      style={{ "--seg-index": index } as CSSProperties}
    >
      <span className="segment-pill" aria-hidden="true" />
      {APPEARANCE_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          className={`segment${value === option.id ? " active" : ""}`}
          onClick={() => onChange(option.id)}
        >
          <span className="segment-icon" aria-hidden="true">
            {APPEARANCE_ICONS[option.id]}
          </span>
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

// --- Controles de formulario -------------------------------------------------

type FieldProps = {
  label: string;
  hint?: string;
  children: ReactNode;
  /** Etiqueta encima del control: se usa en las parejas de campos. */
  stacked?: boolean;
};

/** Fila etiqueta/control a dos columnas, alineadas en la misma línea base. */
function Field({ label, hint, children, stacked }: FieldProps) {
  return (
    <label className={`field${stacked ? " stacked" : ""}`}>
      <span className="field-info">
        <span className="field-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <span className="field-control">{children}</span>
    </label>
  );
}

type CheckProps = {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
};

function Check({ label, hint, checked, onChange }: CheckProps) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="check-text">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
    </label>
  );
}
