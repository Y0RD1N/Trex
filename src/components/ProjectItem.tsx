/**
 * Elemento de proyecto en la barra lateral.
 *
 * Fila compacta de carpeta con expansión de sesiones y menú contextual.
 * El nombre se puede editar con doble clic o desde el propio menú.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { FloatingAnchor } from "../hooks/useFloatingPosition";
import type { AgentActivity, LauncherProfile, Project } from "../types";
import { ChevronIcon, CopyIcon, EllipsisIcon, FolderIcon, PencilIcon, StarIcon, TrashIcon } from "./Icons";
import DropdownMenu from "./DropdownMenu";
import ProfileMenuItems from "./ProfileMenuItems";
import { useProjectIcon } from "../projectIcons";

type Props = {
  project: Project;
  profiles: LauncherProfile[];
  active: boolean;
  tabCount: number;
  activity: AgentActivity;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelect: () => void;
  onQuickOpen: (profileId: string) => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onRename: (name: string) => void;
  onToggleFavorite: () => void;
  onDelete: (trigger: HTMLElement, returnFocus: HTMLElement | null) => void;
};

export default function ProjectItem({
  project,
  profiles,
  active,
  tabCount,
  activity,
  expanded,
  onToggleExpanded,
  onSelect,
  onQuickOpen,
  onReveal,
  onCopyPath,
  onRename,
  onToggleFavorite,
  onDelete,
}: Props) {
  const [menu, setMenu] = useState<FloatingAnchor | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const logo = useProjectIcon(project.path);
  const [brokenLogo, setBrokenLogo] = useState<string | null>(null);
  const activityId = useId();
  const activityText = activity === "working" ? "Hay un agente trabajando en este proyecto"
    : activity === "waiting" ? "Un agente espera tu respuesta en este proyecto" : "";

  useEffect(() => {
    setDraftName(project.name);
  }, [project.name]);

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
      className={`project-item${active ? " active" : ""}`}
      data-activity={activity}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {tabCount > 0 ? (
        <button
          type="button"
          className={`project-disclosure${expanded ? " expanded" : ""}`}
          aria-label={`${expanded ? "Contraer" : "Expandir"} sesiones de ${project.name}`}
          aria-expanded={expanded}
          onClick={(event) => { event.stopPropagation(); onToggleExpanded(); }}
        >
          <ChevronIcon size={11} />
        </button>
      ) : <span className="project-disclosure-placeholder" />}
      <span className={`project-icon${logo && logo !== brokenLogo ? " has-logo" : ""}`} aria-hidden="true" title={activityText || undefined}>
        {logo && logo !== brokenLogo
          ? <img src={logo} alt="" draggable={false} onError={() => setBrokenLogo(logo)} />
          : <FolderIcon size={16} />}
        {activity !== "idle" && <span className={`project-activity is-${activity}`} />}
      </span>
      <span id={activityId} className="sr-only">{activityText}</span>

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
          <button
            type="button"
            className="project-name project-select tip"
            data-tip={`${project.name}\n${project.path}${activityText ? `\n${activityText}` : ""}\nDoble clic para renombrar`}
            aria-label={project.name}
            aria-describedby={activityText ? activityId : undefined}
            onClick={(event) => { event.stopPropagation(); onSelect(); }}
          >
            <span
              className="project-name-text"
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
            {project.favorite && <span className="project-favorite-mark" aria-label="Favorito"><StarIcon size={11} /></span>}
          </button>
        )}
      </div>

      <button
        ref={menuButtonRef}
        type="button"
        className="project-menu-btn"
        data-tip="Opciones del proyecto"
        aria-label={`Opciones de ${project.name}`}
        aria-expanded={menu !== null}
        aria-haspopup="menu"
        onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); setMenu({ element: event.currentTarget }); }
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (menu) {
            setMenu(null);
            return;
          }
          setMenu({ element: event.currentTarget });
        }}
      >
        <EllipsisIcon size={16} />
      </button>

      {
        <DropdownMenu
          anchor={menu}
          triggerRef={menuButtonRef}
          label={`Opciones de ${project.name}`}
          className="project-context-menu"
          onClose={() => setMenu(null)}
        >
          <ProfileMenuItems profiles={profiles} onOpen={profileId => runAction(() => onQuickOpen(profileId))} />
          <div className="context-sep" role="separator" />
          <button type="button" role="menuitemcheckbox" tabIndex={-1} className="context-item" aria-checked={!!project.favorite} onClick={() => runAction(onToggleFavorite)}>
            <span className="context-icon" aria-hidden="true"><StarIcon size={16} /></span>
            {project.favorite ? "Quitar de favoritos" : "Añadir a favoritos"}
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => runAction(onReveal)}>
            <span className="context-icon" aria-hidden="true">
              <FolderIcon size={16} />
            </span>
            Abrir carpeta en el explorador
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => runAction(onCopyPath)}>
            <span className="context-icon" aria-hidden="true">
              <CopyIcon size={16} />
            </span>
            Copiar ruta
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-item"
            onClick={() => runAction(startRename)}
          >
            <span className="context-icon" aria-hidden="true">
              <PencilIcon size={16} />
            </span>
            Renombrar
          </button>
          <div className="context-sep" role="separator" />
          <button type="button" role="menuitem" tabIndex={-1} className="context-item danger" onClick={event => {
            const trigger = event.currentTarget;
            runAction(() => onDelete(trigger, menuButtonRef.current));
          }}>
            <span className="context-icon" aria-hidden="true">
              <TrashIcon size={16} />
            </span>
            Eliminar proyecto
          </button>
        </DropdownMenu>
      }
    </div>
  );
}
