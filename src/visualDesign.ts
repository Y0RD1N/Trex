/** Preferencias visuales compartidas; independientes del sistema operativo. */
export type ColorScheme = "trex" | "ocean" | "forest" | "rose";
export type MotionPreference = "system" | "reduced";
/** Fondo de la ventana: sólido, o un material de Windows 11 que el sistema pinta detrás del webview. */
export type WindowMaterial = "solid" | "mica" | "mica-alt" | "acrylic";
export type DesignSettings = {
  colorScheme: ColorScheme;
  terminalRadius: number;
  terminalMargin: number;
  terminalBorder: boolean;
  motion: MotionPreference;
  /** Transparencias: Mica en Windows 11 y cristal en lo que flota sobre el chat. */
  glass: boolean;
  windowBackdrop: WindowMaterial;
  /** Opacidad (20–90 %) del gris grafito que tiñe el material de la ventana. */
  materialTint: number;
};

const bounded = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : fallback;

export const normalizeDesign = (raw: Partial<Record<keyof DesignSettings, unknown>>): DesignSettings => ({
  colorScheme: raw.colorScheme === "ocean" || raw.colorScheme === "forest" || raw.colorScheme === "rose" ? raw.colorScheme : "trex",
  terminalRadius: bounded(raw.terminalRadius, 22, 36),
  terminalMargin: bounded(raw.terminalMargin, 12, 24),
  terminalBorder: typeof raw.terminalBorder === "boolean" ? raw.terminalBorder : true,
  motion: raw.motion === "reduced" ? "reduced" : "system",
  glass: typeof raw.glass === "boolean" ? raw.glass : true,
  windowBackdrop: raw.windowBackdrop === "mica" || raw.windowBackdrop === "mica-alt" || raw.windowBackdrop === "acrylic" ? raw.windowBackdrop : "solid",
  materialTint: typeof raw.materialTint === "number" && Number.isFinite(raw.materialTint)
    ? Math.min(90, Math.max(20, Math.round(raw.materialTint))) : 60,
});

/** Opciones del fondo, de sólido a más transparente. */
export const WINDOW_MATERIALS: ReadonlyArray<{ id: WindowMaterial; name: string; description: string }> = [
  { id: "solid", name: "Sólido", description: "Negro grafito, como el resto de la app" },
  { id: "mica", name: "Mica", description: "Un toque del color de tu fondo de escritorio" },
  { id: "mica-alt", name: "Mica intensa", description: "Más color de tu fondo de escritorio" },
  { id: "acrylic", name: "Acrílico", description: "Deja ver difuminado lo que hay detrás" },
];

export const FRAME_PRESETS = [
  { id: "compact", name: "Compacto", description: "Más espacio para trabajar", terminalRadius: 12, terminalMargin: 6, terminalBorder: true },
  { id: "comfortable", name: "Cómodo", description: "Esquinas suaves y aire alrededor", terminalRadius: 22, terminalMargin: 12, terminalBorder: true },
  { id: "minimal", name: "Minimalista", description: "Un contorno discreto", terminalRadius: 16, terminalMargin: 4, terminalBorder: false },
] as const;

export const matchingFrame = (settings: DesignSettings): typeof FRAME_PRESETS[number]["id"] | null =>
  FRAME_PRESETS.find(preset => preset.terminalRadius === settings.terminalRadius && preset.terminalMargin === settings.terminalMargin && preset.terminalBorder === settings.terminalBorder)?.id ?? null;

/** «Reducir transparencias» del sistema apaga el cristal aunque el ajuste esté encendido. */
export const glassActive = (enabled: unknown, systemReduced: boolean): boolean =>
  enabled !== false && !systemReduced;

export const systemReducesTransparency = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-transparency: reduce)").matches;

/** La preferencia del sistema también se respeta cuando no se fuerza la reducción. */
export const reducedMotion = (preference: unknown, systemReduced: boolean): boolean =>
  preference === "reduced" || systemReduced;

export const applyDesign = (settings: DesignSettings): void => {
  const clean = normalizeDesign(settings);
  const root = document.documentElement;
  root.style.setProperty("--terminal-gap-setting", `${clean.terminalMargin}px`);
  root.style.setProperty("--terminal-radius-setting", `${clean.terminalRadius}px`);
  root.style.setProperty("--terminal-border-color", clean.terminalBorder ? "var(--border)" : "transparent");
  root.style.setProperty("--terminal-shadow", clean.terminalBorder ? "var(--shadow-sm)" : "none");
  root.dataset.glass = glassActive(clean.glass, systemReducesTransparency()) ? "on" : "off";
  root.style.setProperty("--material-tint", `${clean.materialTint}%`);
  if (root.dataset.motion !== clean.motion) {
    root.dataset.motion = clean.motion;
    window.dispatchEvent(new Event("trex:motion-change"));
  }
};
