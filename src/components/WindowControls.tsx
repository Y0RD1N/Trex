/**
 * Menú de la aplicación y controles de ventana dentro de la barra superior.
 * Minimizar, maximizar/restaurar y cerrar se ocultan junto con ella.
 */
import { useEffect, useRef, useState } from "react";
import type { FloatingAnchor } from "../hooks/useFloatingPosition";
import DropdownMenu from "./DropdownMenu";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from "../window";
import { MOD_LABEL } from "../platform";
import {
  CheckIcon,
  CloseIcon,
  EllipsisIcon,
  FolderIcon,
  GearIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
} from "./Icons";

type Props = {
  /** Abre el panel de ajustes. */
  onOpenSettings: () => void;
  /** Abre la carpeta del proyecto activo; null si no hay proyecto. */
  onRevealProject: (() => void) | null;
  /** La barra superior se esconde sola (modo inmersivo). */
  autoHideTopBar: boolean;
  onToggleTopBar: () => void;
};

export default function WindowControls({ onOpenSettings, onRevealProject, autoHideTopBar, onToggleTopBar }: Props) {
  const [maximized, setMaximized] = useState(false);
  const [menu, setMenu] = useState<FloatingAnchor | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  // Icono maximizar/restaurar: se consulta al montar y en cada cambio de tamaño.
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void isWindowMaximized().then((value) => {
        if (alive) setMaximized(value);
      });
    };
    refresh();
    const unsubscribe = onWindowResized(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const run = (action: () => void): void => {
    setMenu(null);
    action();
  };

  return (
    <div className="window-controls">
      <button
        ref={menuButtonRef}
        type="button"
        className="window-btn tip tip-below"
        data-tip="Más opciones"
        aria-label="Más opciones"
        aria-expanded={menu !== null}
        aria-haspopup="menu"
        onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); setMenu({ element: event.currentTarget }); }
        }}
        onClick={event => setMenu(menu ? null : { element: event.currentTarget })}
      >
        <EllipsisIcon size={16} />
      </button>

      <div className="window-actions" role="group" aria-label="Controles de ventana">
      <button
        type="button"
        className="window-btn tip tip-below"
        data-tip="Minimizar"
        aria-label="Minimizar ventana"
        onClick={minimizeWindow}
      >
        <MinimizeIcon size={16} />
      </button>

      <button
        type="button"
        className="window-btn tip tip-below"
        data-tip={maximized ? "Restaurar" : "Maximizar"}
        aria-label={maximized ? "Restaurar ventana" : "Maximizar ventana"}
        onClick={toggleMaximizeWindow}
      >
        {maximized ? <RestoreIcon size={16} /> : <MaximizeIcon size={16} />}
      </button>

      <button
        type="button"
        className="window-btn tip tip-below"
        data-tip="Cerrar"
        aria-label="Cerrar ventana"
        onClick={closeWindow}
        data-window-action="close"
      >
        <CloseIcon size={16} />
      </button>
      </div>

      {
        <DropdownMenu anchor={menu} triggerRef={menuButtonRef} label="Opciones de la aplicación"
          className="window-menu" onClose={() => setMenu(null)}>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-item"
            onClick={() => run(onOpenSettings)}
          >
            <span className="context-icon" aria-hidden="true">
              <GearIcon size={16} />
            </span>
            Ajustes
            <span className="kbd">Ctrl+,</span>
          </button>

          {onRevealProject && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="context-item"
              onClick={() => run(onRevealProject)}
            >
              <span className="context-icon" aria-hidden="true">
                <FolderIcon size={16} />
              </span>
              Abrir carpeta del proyecto en el explorador
            </button>
          )}

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoHideTopBar}
            tabIndex={-1}
            className="context-item"
            onClick={() => run(onToggleTopBar)}
          >
            <span className="context-icon" aria-hidden="true">
              {autoHideTopBar && <CheckIcon size={16} />}
            </span>
            Ocultar esta barra automáticamente
            <span className="kbd">{MOD_LABEL} ⇧ B</span>
          </button>

        </DropdownMenu>
      }
    </div>
  );
}
