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

export function LayoutIcon({ size = 18, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M12 4.5v15M12 12h8.5" /></svg>;
}

export function SplitIcon({ size = 18, strokeWidth = 1.6, rows = false }: IconProps & { rows?: boolean }) {
  return <svg {...svgProps(size, strokeWidth)}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d={rows ? "M3.5 12h17" : "M12 4.5v15"} /></svg>;
}

export function GridIcon({ size = 18, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M12 4.5v15M3.5 12h17" /></svg>;
}

export function RotateIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M20 10a8 8 0 1 0-2.3 7.8M20 4v6h-6" /></svg>;
}

export function StarIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="m12 3 2.8 5.7 6.3.9-4.55 4.44 1.07 6.27L12 17.35l-5.62 2.96 1.07-6.27L2.9 9.6l6.3-.9Z" /></svg>;
}

export function FilterIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M4 6h16M7 12h10M10 18h4" /></svg>;
}

export function KeyboardIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10" />
  </svg>;
}

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

export function CursorIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M12 4v16M8 4h8M8 20h8" /></svg>;
}

export function ProfilesIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M5.5 16a3.5 3.5 0 0 1 7 0M16 9h2M16 13h2" /></svg>;
}

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

export function MinusIcon({ size = 16, strokeWidth = 1.8 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M5.2 12h13.6" /></svg>;
}

/** Descargar o guardar: flecha hacia una bandeja. */
export function DownloadIcon({ size = 16, strokeWidth = 1.7 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M12 4v11m0 0-4.2-4.2M12 15l4.2-4.2M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" /></svg>;
}

/** Abrir fuera de trex: flecha que sale de un recuadro. */
export function ExternalIcon({ size = 16, strokeWidth = 1.7 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" /></svg>;
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
      <path d="M10.54 3.73h2.92l.36 1.93 1.38.57 1.62-1.11 2.06 2.06-1.11 1.62.57 1.38 1.93.36v2.92l-1.93.36-.57 1.38 1.11 1.62-2.06 2.06-1.62-1.11-1.38.57-.36 1.93h-2.92l-.36-1.93-1.38-.57-1.62 1.11-2.06-2.06 1.11-1.62-.57-1.38-1.93-.36v-2.92l1.93-.36.57-1.38-1.11-1.62 2.06-2.06 1.62 1.11 1.38-.57z" />
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

export function FolderPlusIcon({ size = 18, strokeWidth = 1.7 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 10v6m-3-3h6" /></svg>;
}

export function BellIcon({ size = 18, strokeWidth = 1.7 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}

export function SoundIcon({ size = 16, strokeWidth = 1.7, muted = false }: IconProps & { muted?: boolean }) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M11 4 6 8H3v8h3l5 4Z" />
    {muted ? <path d="m16 9 5 6m0-6-5 6" /> : <><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>}
  </svg>;
}

// --- Chat -------------------------------------------------------------------

export function ArrowUpIcon({ size = 16, strokeWidth = 2 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M12 19V5m-6 6 6-6 6 6" /></svg>;
}

export function ArrowDownIcon({ size = 16, strokeWidth = 1.8 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M12 5v14m6-6-6 6-6-6" /></svg>;
}

export function StopIcon({ size = 14 }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" /></svg>;
}

export function FileIcon({ size = 15, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z" /><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h5" /></svg>;
}

export function GlobeIcon({ size = 15, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5Z" /></svg>;
}

export function SparkIcon({ size = 15, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5-1.9-5.5-5.6-2 5.6-2Z" /><path d="M18.5 3.5v3M17 5h3" /></svg>;
}

export function ListIcon({ size = 15, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M9 6.5h11M9 12h11M9 17.5h11" /><path d="m3.8 6.4 1.2 1.2 2-2.2M3.8 11.9 5 13.1l2-2.2" /><circle cx="5.2" cy="17.5" r="1" /></svg>;
}

export function MapIcon({ size = 15, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="m9 4.5-5.5 2v13l5.5-2 6 2 5.5-2v-13l-5.5 2Z" /><path d="M9 4.5v13m6-11v13" /></svg>;
}

export function WrenchIcon({ size = 15, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M14.7 6.3a4 4 0 0 0-5.2 5.2l-5.3 5.3a1.6 1.6 0 0 0 2.3 2.3l5.3-5.3a4 4 0 0 0 5.2-5.2l-2.4 2.4-2.1-.6-.6-2.1Z" /></svg>;
}

export function ShieldIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6Z" /><path d="m9.2 12.2 2 2 3.8-4.1" /></svg>;
}

export function PaperclipIcon({ size = 16, strokeWidth = 1.7 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="m20 11.5-7.7 7.7a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" /></svg>;
}

export function QuestionIcon({ size = 15, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7" /><circle cx="12" cy="17" r=".6" fill="currentColor" /></svg>;
}

export function ImageIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="9.5" r="1.6" /><path d="m20.5 15.5-4.6-4.6-8.9 8.6" /></svg>;
}

export function BranchIcon({ size = 13, strokeWidth = 1.7 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><circle cx="6.5" cy="5.5" r="2" /><circle cx="6.5" cy="18.5" r="2" /><circle cx="17.5" cy="7.5" r="2" /><path d="M6.5 7.5v9M17.5 9.5c0 4-5 3.5-9.6 7.3" /></svg>;
}

/** Velocidad rápida: un rayo. */
export function BoltIcon({ size = 14, strokeWidth = 1.7 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M13.2 3.5 5.5 13.4h6l-1 7.1 8-10.2h-6.1Z" /></svg>;
}

/** Indicador de uso: un medidor con la aguja a dos tercios. */
export function GaugeIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" /><path d="m12 14 4.2-4.6" /><circle cx="12" cy="14" r="1.4" /></svg>;
}

export function RefreshIcon({ size = 16, strokeWidth = 1.6 }: IconProps) {
  return <svg {...svgProps(size, strokeWidth)}><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></svg>;
}
