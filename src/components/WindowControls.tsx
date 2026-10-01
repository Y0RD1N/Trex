/**
 * Controles de ventana del extremo derecho de la barra de título: "⋯" (menú de
 * la aplicación), "▢/❐" (maximizar / restaurar) y "—" (minimizar).
 *
 * El menú reutiliza la estética del menú contextual de los proyectos y sus
 * entradas son: Ajustes, abrir la carpeta del proyecto activo (solo si hay
 * proyecto), salir de trex y —al final, tras un separador— cerrar la ventana
 * (la ventana no tiene bordes nativos y ya no hay botón de cerrar).
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
import {
  CloseIcon,
  EllipsisIcon,
  FolderIcon,
  GearIcon,
  MaximizeIcon,
  MinimizeIcon,
  PowerIcon,
  RestoreIcon,
} from "./Icons";

type Props = {
  /** Abre el panel de ajustes. */
  onOpenSettings: () => void;
  /** Abre la carpeta del proyecto activo; null si no hay proyecto. */
  onRevealProject: (() => void) | null;
};

export default function WindowControls({ onOpenSettings, onRevealProject }: Props) {
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
        data-tip="Minimizar"
        aria-label="Minimizar ventana"
        onClick={minimizeWindow}
      >
        <MinimizeIcon size={16} />
      </button>

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

          <div className="context-sep" role="separator" />

          <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => run(closeWindow)}>
            <span className="context-icon" aria-hidden="true">
              <PowerIcon size={16} />
            </span>
            Salir de trex
          </button>

          <div className="context-sep" role="separator" />

          <button type="button" role="menuitem" tabIndex={-1} className="context-item" onClick={() => run(closeWindow)}>
            <span className="context-icon" aria-hidden="true">
              <CloseIcon size={16} />
            </span>
            Cerrar ventana
          </button>
        </DropdownMenu>
      }
    </div>
  );
}
