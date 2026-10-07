/** Preferencias visuales compartidas; independientes del sistema operativo. */
export type ColorScheme = "trex" | "ocean" | "forest" | "rose";
export type MotionPreference = "system" | "reduced";
export type DesignSettings = {
  colorScheme: ColorScheme;
  terminalRadius: number;
  terminalMargin: number;
  terminalBorder: boolean;
  motion: MotionPreference;
};

const bounded = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : fallback;

export const normalizeDesign = (raw: Partial<Record<keyof DesignSettings, unknown>>): DesignSettings => ({
  colorScheme: raw.colorScheme === "ocean" || raw.colorScheme === "forest" || raw.colorScheme === "rose" ? raw.colorScheme : "trex",
  terminalRadius: bounded(raw.terminalRadius, 22, 36),
  terminalMargin: bounded(raw.terminalMargin, 12, 24),
  terminalBorder: typeof raw.terminalBorder === "boolean" ? raw.terminalBorder : true,
  motion: raw.motion === "reduced" ? "reduced" : "system",
});

export const FRAME_PRESETS = [
  { id: "compact", name: "Compacto", description: "Más espacio para trabajar", terminalRadius: 12, terminalMargin: 6, terminalBorder: true },
  { id: "comfortable", name: "Cómodo", description: "Esquinas suaves y aire alrededor", terminalRadius: 22, terminalMargin: 12, terminalBorder: true },
  { id: "minimal", name: "Minimalista", description: "Un contorno discreto", terminalRadius: 16, terminalMargin: 4, terminalBorder: false },
] as const;

export const matchingFrame = (settings: DesignSettings): typeof FRAME_PRESETS[number]["id"] | null =>
  FRAME_PRESETS.find(preset => preset.terminalRadius === settings.terminalRadius && preset.terminalMargin === settings.terminalMargin && preset.terminalBorder === settings.terminalBorder)?.id ?? null;

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
  if (root.dataset.motion !== clean.motion) {
    root.dataset.motion = clean.motion;
    window.dispatchEvent(new Event("trex:motion-change"));
  }
};
