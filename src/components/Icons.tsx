/**
 * Iconos de interfaz en SVG (trazo fino, estilo lineal).
 *
 * Van con `currentColor`, así que heredan el color del botón en el que se usan
 * y funcionan igual en modo claro y oscuro. Todos comparten la misma caja de
 * 24×24 para que la alineación óptica sea idéntica entre controles.
 */
type IconProps = {
  size?: number;
  strokeWidth?: number;
};

const svgProps = (size: number, strokeWidth: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

/** Sol: pasar a modo claro. */
export function SunIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <circle cx="12" cy="12" r="3.7" />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.35 5.35l1.56 1.56M17.09 17.09l1.56 1.56M18.65 5.35l-1.56 1.56M6.91 17.09l-1.56 1.56" />
    </svg>
  );
}

/** Luna: pasar a modo oscuro. */
export function MoonIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M20.2 14.64A8.6 8.6 0 0 1 9.36 3.8 8.6 8.6 0 1 0 20.2 14.64Z" />
    </svg>
  );
}

/** Monitor: seguir el tema del sistema. */
export function SystemIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <rect x="3" y="4.2" width="18" height="12.2" rx="2.2" />
      <path d="M8.6 20.2h6.8M12 16.4v3.8" />
    </svg>
  );
}

/** Controles deslizantes: ajustes. */
export function SettingsIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M4 7h7M16.4 7H20M4 12h2.6M11.4 12H20M4 17h7M16.4 17H20" />
      <circle cx="13.7" cy="7" r="1.9" />
      <circle cx="8.7" cy="12" r="1.9" />
      <circle cx="13.7" cy="17" r="1.9" />
    </svg>
  );
}

/** Signo más: añadir proyecto o pestaña. */
export function PlusIcon({ size = 16, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M12 5.2v13.6M5.2 12h13.6" />
    </svg>
  );
}

/** Aspa: cerrar. */
export function CloseIcon({ size = 16, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" />
    </svg>
  );
}

/** Marca de verificación. */
export function CheckIcon({ size = 16, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M4.8 12.6l4.7 4.6L19.2 7" />
    </svg>
  );
}

/** Lupa: buscar dentro del terminal. */
export function SearchIcon({ size = 16, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <circle cx="10.8" cy="10.8" r="6.2" />
      <path d="M15.4 15.4 20 20" />
    </svg>
  );
}

/** Círculo con "i": información neutra (diálogos no destructivos). */
export function InfoIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.2M12 7.9v.5" />
    </svg>
  );
}

/** Carpeta: abrir en el explorador. */
export function FolderIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M3.4 6.6a1.9 1.9 0 0 1 1.9-1.9h3.3l1.7 2.1h8.4a1.9 1.9 0 0 1 1.9 1.9v8.2a1.9 1.9 0 0 1-1.9 1.9H5.3a1.9 1.9 0 0 1-1.9-1.9z" />
    </svg>
  );
}

/** Dos hojas: copiar. */
export function CopyIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <rect x="9.2" y="9.2" width="10.6" height="10.6" rx="2.1" />
      <path d="M15.2 6.4V5.6a1.6 1.6 0 0 0-1.6-1.6H5.6A1.6 1.6 0 0 0 4 5.6v8a1.6 1.6 0 0 0 1.6 1.6h.8" />
    </svg>
  );
}

/** Lápiz: renombrar. */
export function PencilIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M4.2 19.8h3.9L19 8.9a2 2 0 0 0-2.8-2.8L5.3 17z" />
      <path d="M15.4 7.1l2.7 2.7" />
    </svg>
  );
}

/** Papelera: eliminar. */
export function TrashIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M4.6 7h14.8M9.6 7V5.4a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.6 7l.9 11.3A1.7 1.7 0 0 0 9.2 20h5.6a1.7 1.7 0 0 0 1.7-1.7L17.4 7" />
    </svg>
  );
}

/** Aviso: atención. */
export function AlertIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M12 4.4 3.3 19.6h17.4z" />
      <path d="M12 10.2v3.6M12 16.7v.5" />
    </svg>
  );
}

/** Engranaje: acceso a los ajustes de la app. */
export function GearIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <circle cx="12" cy="12" r="2.5" />
      <path d="M10.9 3.9a1.1 1.1 0 0 1 2.2 0l.17.86a6.5 6.5 0 0 1 1.63.94l.83-.29a1.1 1.1 0 0 1 1.36.6l.63 1.42a1.1 1.1 0 0 1-.4 1.35l-.73.52a6.6 6.6 0 0 1 0 1.88l.73.52c.48.34.63.98.4 1.35l-.63 1.42a1.1 1.1 0 0 1-1.36.6l-.83-.29a6.5 6.5 0 0 1-1.63.94l-.17.86a1.1 1.1 0 0 1-2.2 0l-.17-.86a6.5 6.5 0 0 1-1.63-.94l-.83.29a1.1 1.1 0 0 1-1.36-.6l-.63-1.42a1.1 1.1 0 0 1 .4-1.35l.73-.52a6.6 6.6 0 0 1 0-1.88l-.73-.52a1.1 1.1 0 0 1-.4-1.35l.63-1.42a1.1 1.1 0 0 1 1.36-.6l.83.29a6.5 6.5 0 0 1 1.63-.94z" />
    </svg>
  );
}

/** Tres puntos horizontales: menú de opciones. */
export function EllipsisIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size, 1.6)}>
      <circle cx="5.7" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.3" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Rectángulo con panel lateral: mostrar u ocultar la barra lateral. */
export function PanelIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <rect x="3.6" y="4.8" width="16.8" height="14.4" rx="2.6" />
      <path d="M9.2 4.8v14.4" />
    </svg>
  );
}

/** Cuadrado: maximizar la ventana. */
export function MaximizeIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <rect x="4.8" y="4.8" width="14.4" height="14.4" rx="3.2" />
    </svg>
  );
}

/** Dos cuadrados superpuestos: restaurar la ventana. */
export function RestoreIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <rect x="8.6" y="4.6" width="10.8" height="10.8" rx="2.8" />
      <path d="M15.6 18.9H7.4a2.8 2.8 0 0 1-2.8-2.8V8" />
    </svg>
  );
}

/** Guion: minimizar la ventana. */
export function MinimizeIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M5.6 12h12.8" />
    </svg>
  );
}

/** Círculo con línea: salir de la aplicación. */
export function PowerIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg {...svgProps(size, strokeWidth)}>
      <path d="M12 3.6v8" />
      <path d="M7.4 6.2a7 7 0 1 0 9.2 0" />
    </svg>
  );
}

export function TerminalIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></svg>;
}

export function ArrowRightIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M5 12h14m-5-5 5 5-5 5" /></svg>;
}

export function ChevronIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="m9 5 7 7-7 7" /></svg>;
}
