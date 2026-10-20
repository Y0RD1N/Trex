import { useEffect, useId, useMemo, useRef, useState } from "react";
import { filterCommands, type PaletteCommand } from "../commandPalette";
import { shortcutLabel } from "../shortcuts";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import { waitForMotion } from "../motion";
import { SearchIcon } from "./Icons";
export default function CommandPalette({
  commands,
  onClose,
  surfaceRef,
  ...motion
}: {
  commands: PaletteCommand[];
  onClose: () => void;
} & FeatureDialogMotionProps) {
  const localSurfaceRef = useRef<HTMLDivElement>(null);
  const dialogRef = surfaceRef ?? localSurfaceRef;
  const executingRef = useRef(false);
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(0),
    id = useId();
  const filtered = useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );
  useEffect(() => setSelected(0), [query]);
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  useEffect(() => {
    document
      .getElementById(`${id}-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [id, index]);
  const execute = (command: PaletteCommand): void => {
    if (executingRef.current) return;
    executingRef.current = true;
    const surface = dialogRef.current;
    onClose();
    // La siguiente acción puede abrir otra ventana: se ejecuta cuando esta
    // lámina ya ha liberado el fondo y devuelto el foco.
    requestAnimationFrame(() => {
      waitForMotion(surface, () => requestAnimationFrame(command.run));
    });
  };
  return (
    <FeatureDialog
      {...motion}
      surfaceRef={dialogRef}
      title="Paleta de comandos"
      onClose={onClose}
      className="command-dialog"
      footer={
        <span className="feature-hint">
          ↑ ↓ para elegir · Enter para abrir · Esc para cerrar
        </span>
      }
    >
      <div className="command-search">
        <SearchIcon size={18} />
        <input
          data-autofocus
          className="input"
          role="combobox"
          aria-label="Buscar proyectos, sesiones o acciones"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={filtered.length ? `${id}-${index}` : undefined}
          placeholder="Busca un proyecto, una sesión o una acción…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setSelected(
                filtered.length
                  ? (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      filtered.length) %
                      filtered.length
                  : 0,
              );
            }
            if (event.key === "Enter" && filtered[index]) {
              event.preventDefault();
              execute(filtered[index]);
            }
          }}
        />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Resultados de comandos"
        className="command-results"
      >
        {filtered.map((command, position) => (
          <button
            id={`${id}-${position}`}
            key={command.id}
            type="button"
            role="option"
            aria-selected={index === position}
            tabIndex={-1}
            className={`command-result${index === position ? " selected" : ""}`}
            onMouseMove={() => setSelected(position)}
            onClick={() => execute(command)}
          >
            <span>
              <span className="command-group">{command.group}</span>
              <strong>{command.label}</strong>
              {command.detail && <small>{command.detail}</small>}
            </span>
            {command.shortcut && <kbd>{shortcutLabel(command.shortcut)}</kbd>}
          </button>
        ))}
        {!filtered.length && (
          <p className="feature-empty">No hay resultados para esta búsqueda.</p>
        )}
      </div>
    </FeatureDialog>
  );
}
