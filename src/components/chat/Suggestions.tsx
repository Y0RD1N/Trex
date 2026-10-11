/**
 * Sugerencias sobre la caja del chat (`@`, `/`, `$`). Se manejan con el teclado
 * desde la caja de texto; aquí solo se pintan y se eligen con el ratón.
 */
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { Suggestion } from "../../chatCommands";
import { FileIcon, FolderIcon, SparkIcon, StarIcon, TerminalIcon } from "../Icons";

const SECTIONS: Record<Suggestion["kind"], string> = {
  agent: "Subagentes", folder: "Archivos y carpetas", file: "Archivos y carpetas", command: "Comandos", skill: "Skills",
};
const ICONS: Record<Suggestion["kind"], ReactNode> = {
  file: <FileIcon size={14} />, folder: <FolderIcon size={14} />, agent: <SparkIcon size={14} />,
  command: <TerminalIcon size={14} />, skill: <StarIcon size={13} />,
};

export default function Suggestions({ id, items, active, loading, onPick, onHover }: {
  id: string;
  items: Suggestion[];
  active: number;
  /** Aún se está leyendo la lista de archivos. */
  loading: boolean;
  onPick: (item: Suggestion, drill: boolean) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const folders = items.some(item => item.kind === "folder");
  return <div className="chat-suggest">
    <div className="chat-suggest-list" ref={listRef} id={id} role="listbox" aria-label="Sugerencias">
      {items.length === 0 && <div className="chat-suggest-empty">{loading ? "Buscando archivos…" : "Sin resultados"}</div>}
      {items.map((item, index) => {
        const section = SECTIONS[item.kind];
        return <Fragment key={item.id}>
          {(index === 0 || SECTIONS[items[index - 1].kind] !== section) && <div className="chat-suggest-section" role="presentation">{section}</div>}
          <div id={`${id}-${index}`} role="option" aria-selected={index === active} data-index={index}
            className={`chat-suggest-item ${item.kind}${index === active ? " active" : ""}`}
            onMouseDown={event => event.preventDefault()} onMouseEnter={() => onHover(index)} onClick={() => onPick(item, false)}>
            <span className={`chat-suggest-icon ${item.kind}`} aria-hidden="true">{ICONS[item.kind]}</span>
            <span className="chat-suggest-label">{item.label}</span>
            {item.detail && <span className="chat-suggest-detail">{item.detail}</span>}
          </div>
        </Fragment>;
      })}
    </div>
    <div className="chat-suggest-hint" aria-hidden="true">
      <span><kbd>↑</kbd><kbd>↓</kbd> elegir</span>
      <span><kbd>Enter</kbd> {items[active]?.run ? "ejecutar" : "insertar"}</span>
      {folders && <span><kbd>Tab</kbd> abrir carpeta</span>}
      <span><kbd>Esc</kbd> cerrar</span>
    </div>
  </div>;
}
