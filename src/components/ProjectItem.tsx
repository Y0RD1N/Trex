/**
 * Elemento de proyecto en la barra lateral.
 *
 * Fila de 44 px con el icono de carpeta (el identificador visual: ya no hay
 * punto de color), el nombre, el contador discreto de pestañas abiertas y el
 * botón "⋯" que abre el menú de opciones. El renombrado en línea se hace con
 * doble clic en el nombre o desde el propio menú (el plugin dialog v2 no
 * expone prompt()).
 */
import { useEffect, useRef, useState } from "react";
import type { Project } from "../types";
import { CopyIcon, EllipsisIcon, FolderIcon, PencilIcon, TrashIcon } from "./Icons";

type Props = {
  project: Project;
  active: boolean;
  tabCount: number;
  onSelect: () => void;
  onQuickOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
};

type MenuPosition = { x: number; y: number };

export default function ProjectItem({
  project,
  active,
  tabCount,
  onSelect,
  onQuickOpen,
  onReveal,
  onCopyPath,
  onRename,
  onDelete,
}: Props) {
  const [menu, setMenu] = useState<MenuPosition | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const itemRef = useRef<HTMLDivElement | null>(null);

  // Cierra el menú contextual al pulsar fuera o al redimensionar la ventana.
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent): void => {
      if (itemRef.current?.querySelector(".context-menu")?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnResize = (): void => setMenu(null);
    const closeOnKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [menu]);

  useEffect(() => {
    setDraftName(project.name);
  }, [project.name]);

  /** Abre el menú de opciones evitando que se salga de la ventana. */
  const openMenu = (x: number, y: number): void => {
    const width = 244;
    const height = 232;
    const left = Math.min(x, Math.max(8, window.innerWidth - width - 8));
    const top = Math.min(y, Math.max(8, window.innerHeight - height - 8));
    setMenu({ x: left, y: top });
  };

  const startRename = (): void => {
    setDraftName(project.name);
    setEditing(true);
  };

  const commitRename = (): void => {
    const value = draftName.trim();
    if (value && value !== project.name) onRename(value);
    else setDraftName(project.name);
    setEditing(false);
  };

  const runAction = (action: () => void): void => {
    setMenu(null);
    action();
  };

  return (
    <div
      ref={itemRef}
      className={`project-item${active ? " active" : ""}`}
      title={project.path}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect();
        openMenu(event.clientX, event.clientY);
      }}
    >
      <span className="project-icon" aria-hidden="true">
        <FolderIcon size={20} />
      </span>

      <div className="project-info">
        {editing ? (
          <input
            className="project-rename-input"
            value={draftName}
            autoFocus
            spellCheck={false}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraftName(project.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <div className="project-name">
            <span
              className="project-name-text"
              title={`${project.name} — doble clic para renombrar`}
              onDoubleClick={(event) => {
                event.stopPropagation();
                startRename();
              }}
            >
              {project.name}
            </span>
            {tabCount > 0 && (
              <span
                className="project-tabcount"
                title={`${tabCount} ${tabCount === 1 ? "pestaña abierta" : "pestañas abiertas"}`}
              >
                {tabCount}
              </span>
            )}
          </div>
        )}
        <div className="project-meta">{tabCount > 0 ? `${tabCount} ${tabCount === 1 ? "sesión abierta" : "sesiones abiertas"}` : "Listo para empezar"}</div>
      </div>

      <button
        type="button"
        className="project-menu-btn"
        title="Opciones del proyecto"
        aria-label={`Opciones de ${project.name}`}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu(rect.right - 244, rect.bottom + 4);
        }}
      >
        <EllipsisIcon size={16} />
      </button>

      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" className="context-item" onClick={() => runAction(onQuickOpen)}>
            <span className="context-icon" aria-hidden="true">
              ✳
            </span>
            Abrir Claude en este proyecto
          </button>
          <div className="context-sep" />
          <button type="button" className="context-item" onClick={() => runAction(onReveal)}>
            <span className="context-icon" aria-hidden="true">
              <FolderIcon size={16} />
            </span>
            Abrir carpeta en el explorador
          </button>
          <button type="button" className="context-item" onClick={() => runAction(onCopyPath)}>
            <span className="context-icon" aria-hidden="true">
              <CopyIcon size={16} />
            </span>
            Copiar ruta
          </button>
          <button
            type="button"
            className="context-item"
            onClick={() => runAction(startRename)}
          >
            <span className="context-icon" aria-hidden="true">
              <PencilIcon size={16} />
            </span>
            Renombrar
          </button>
          <div className="context-sep" />
          <button type="button" className="context-item danger" onClick={() => runAction(onDelete)}>
            <span className="context-icon" aria-hidden="true">
              <TrashIcon size={16} />
            </span>
            Eliminar proyecto
          </button>
        </div>
      )}
    </div>
  );
}
