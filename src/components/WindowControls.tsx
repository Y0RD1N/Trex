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
  const [menuOpen, setMenuOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement | null>(null);

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

  // El menú se cierra al pulsar fuera o al redimensionar la ventana.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent): void => {
      if (groupRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const closeOnResize = (): void => setMenuOpen(false);
    const closeOnKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [menuOpen]);

  const run = (action: () => void): void => {
    setMenuOpen(false);
    action();
  };

  return (
    <div className="window-controls" ref={groupRef}>
      <button
        type="button"
        className="window-btn"
        title="Más opciones"
        aria-label="Más opciones"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <EllipsisIcon size={16} />
      </button>

      <button
        type="button"
        className="window-btn"
        title={maximized ? "Restaurar" : "Maximizar"}
        aria-label={maximized ? "Restaurar ventana" : "Maximizar ventana"}
        onClick={toggleMaximizeWindow}
      >
        {maximized ? <RestoreIcon size={16} /> : <MaximizeIcon size={16} />}
      </button>

      <button
        type="button"
        className="window-btn"
        title="Minimizar"
        aria-label="Minimizar ventana"
        onClick={minimizeWindow}
      >
        <MinimizeIcon size={16} />
      </button>

      {menuOpen && (
        <div className="context-menu window-menu">
          <button
            type="button"
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
              className="context-item"
              onClick={() => run(onRevealProject)}
            >
              <span className="context-icon" aria-hidden="true">
                <FolderIcon size={16} />
              </span>
              Abrir carpeta del proyecto en el explorador
            </button>
          )}

          <div className="context-sep" />

          <button type="button" className="context-item" onClick={() => run(closeWindow)}>
            <span className="context-icon" aria-hidden="true">
              <PowerIcon size={16} />
            </span>
            Salir de trex
          </button>

          <div className="context-sep" />

          <button type="button" className="context-item" onClick={() => run(closeWindow)}>
            <span className="context-icon" aria-hidden="true">
              <CloseIcon size={16} />
            </span>
            Cerrar ventana
          </button>
        </div>
      )}
    </div>
  );
}
