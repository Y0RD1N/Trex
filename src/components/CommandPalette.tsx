import { useEffect, useId, useMemo, useRef, useState } from "react";
import { filterCommands, type PaletteCommand } from "../commandPalette";
import { shortcutLabel } from "../shortcuts";
import FeatureDialog, { type FeatureDialogMotionProps } from "./FeatureDialog";
import { ArrowRightIcon, CloseIcon, FolderIcon, FolderPlusIcon, GaugeIcon, GridIcon, MapIcon, PanelIcon, ProfilesIcon, RefreshIcon, RotateIcon, SearchIcon, SettingsIcon, SparkIcon, SplitIcon, SunIcon, TerminalIcon } from "./Icons";
import "./CommandPalette.css";

const commandIcons = {
  split: SplitIcon, grid: GridIcon, rotate: RotateIcon, recover: RefreshIcon,
  usage: GaugeIcon, settings: SettingsIcon, theme: SunIcon, sidebar: PanelIcon,
  folder: FolderIcon, add: FolderPlusIcon, shell: TerminalIcon, "agent-workflow": MapIcon,
};

function CommandIcon({ command }: { command: PaletteCommand }) {
  const Icon = (Object.prototype.hasOwnProperty.call(commandIcons, command.id) ? commandIcons[command.id as keyof typeof commandIcons] : undefined)
    ?? (command.group === "Proyectos" ? FolderIcon : command.group === "Sesiones abiertas" ? TerminalIcon
      : command.group === "Crear sesión" ? ProfilesIcon : SparkIcon);
  return <Icon size={18} />;
}

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
  const inputRef = useRef<HTMLInputElement>(null);
  const executingRef = useRef(false);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(0),
    id = useId();
  const filtered = useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );
  // Keep the existing result order and keyboard indexes while labelling each
  // consecutive category once, rather than repeating it on every row.
  const sections = useMemo(() => {
    const result: { group: string; start: number; commands: PaletteCommand[] }[] = [];
    filtered.forEach((command, position) => {
      const previous = result[result.length - 1];
      if (previous?.group === command.group) previous.commands.push(command);
      else result.push({ group: command.group, start: position, commands: [command] });
    });
    return result;
  }, [filtered]);
  useEffect(() => setSelected(0), [query]);
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  useEffect(() => {
    document
      .getElementById(`${id}-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [id, index]);
  useEffect(() => () => {
    const run = pendingActionRef.current;
    pendingActionRef.current = null;
    // FeatureDialog releases background inertness and restores focus during
    // unmount. Open the chosen action only after that cleanup has completed.
    if (run) requestAnimationFrame(run);
  }, []);
  const execute = (command: PaletteCommand): void => {
    if (executingRef.current) return;
    executingRef.current = true;
    pendingActionRef.current = command.run;
    onClose();
  };
  return (
    <FeatureDialog
      {...motion}
      surfaceRef={dialogRef}
      title="Paleta de comandos"
      onClose={onClose}
      className="command-dialog"
      footer={
        <div className="command-keyboard">
          <span><kbd>↑</kbd><kbd>↓</kbd> <span>Elegir</span></span>
          <span><kbd>↵</kbd> <span>Abrir</span></span>
          <span><kbd>Esc</kbd> <span>Cerrar</span></span>
        </div>
      }
    >
      <div className="command-search">
        <SearchIcon size={18} />
        <input
          ref={inputRef}
          data-autofocus
          className="input"
          role="combobox"
          aria-label="Buscar proyectos, sesiones o acciones"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-describedby={`${id}-summary`}
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
        {query && <button type="button" className="command-clear" aria-label="Limpiar búsqueda" title="Limpiar búsqueda"
          onClick={() => { setQuery(""); inputRef.current?.focus({ preventScroll: true }); }}><CloseIcon size={15} /></button>}
      </div>
      <div className="command-summary" id={`${id}-summary`}>
        <span>{query.trim() ? "Resultados de búsqueda" : "Acceso rápido a tu espacio"}</span>
        <span role="status" aria-live="polite" aria-atomic="true">{filtered.length === 1 ? "1 resultado" : `${filtered.length} resultados`}</span>
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Resultados de comandos"
        className="command-results"
      >
        {sections.map(section => <div key={`${section.group}-${section.start}`} className="command-section"
          role="group" aria-labelledby={`${id}-group-${section.start}`}>
          <div className="command-group" id={`${id}-group-${section.start}`}>{section.group}</div>
          {section.commands.map((command, offset) => {
            const position = section.start + offset;
            return (
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
                <span className="command-icon" aria-hidden="true"><CommandIcon command={command} /></span>
                <span className="command-label">
                  <strong title={command.label}>{command.label}</strong>
                  {command.detail && <small title={command.detail}>{command.detail}</small>}
                </span>
                <span className="command-tail">
                  {command.shortcut && <kbd>{shortcutLabel(command.shortcut)}</kbd>}
                  <span className="command-open" aria-hidden="true"><ArrowRightIcon size={15} /></span>
                </span>
              </button>
            );
          })}
        </div>)}
        {!filtered.length && (
          <div className="command-empty">
            <span aria-hidden="true"><SearchIcon size={22} /></span>
            <strong>No encontramos resultados</strong>
            <p>Prueba con el nombre de un proyecto, una sesión o una acción.</p>
          </div>
        )}
      </div>
    </FeatureDialog>
  );
}
