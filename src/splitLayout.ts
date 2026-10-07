export type SplitDirection = "columns" | "rows" | "grid";
export type SplitLayout = {
  panes: (string | null)[];
  direction: SplitDirection;
  ratio: number;
  rowRatio: number;
};

export function clampSplitRatio(value: number): number {
  return Math.min(0.75, Math.max(0.25, Number.isFinite(value) ? value : 0.5));
}

/** Migra la división de dos terminales y conserva los huecos de la cuadrícula. */
export function normalizeSplitLayout(value: unknown): SplitLayout | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const direction = raw.direction === "grid" ? "grid" : raw.direction === "rows" ? "rows" : "columns";
  const source = Array.isArray(raw.panes) ? raw.panes : [raw.first, raw.second];
  if (!source.some(id => typeof id === "string" && id.length > 0)) return null;
  const seen = new Set<string>();
  const panes = Array.from({ length: direction === "grid" ? 4 : 2 }, (_, index) => {
    const id = source[index];
    if (typeof id !== "string" || !id || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
  if (!seen.size) return null;
  return {
    panes, direction,
    ratio: clampSplitRatio(typeof raw.ratio === "number" ? raw.ratio : 0.5),
    rowRatio: clampSplitRatio(typeof raw.rowRatio === "number" ? raw.rowRatio : 0.5),
  };
}

/** El foco no cambia las posiciones. Las sesiones cerradas dejan un panel libre. */
export function visibleSplit(layout: SplitLayout | null, ids: string[], active: string | null): SplitLayout | null {
  if (!layout || !active || !ids.includes(active)) return null;
  const panes = layout.panes.map(id => id && ids.includes(id) ? id : null);
  if (!panes.includes(active)) panes[Math.max(0, panes.indexOf(null))] = active;
  return panes.every((id, index) => id === layout.panes[index]) ? layout : { ...layout, panes };
}

export function createSplitLayout(direction: SplitDirection, ids: string[], active: string, previous: SplitLayout | null): SplitLayout {
  if (previous?.direction === direction) {
    const visible = visibleSplit(previous, ids, active);
    if (visible) return visible;
  }
  const count = direction === "grid" ? 4 : 2;
  const ordered = [...new Set([...(previous?.panes ?? []).filter((id): id is string => !!id && ids.includes(id)), active, ...ids])];
  const panes: (string | null)[] = ordered.slice(0, count);
  if (!panes.includes(active)) panes[count - 1] = active;
  while (panes.length < count) panes.push(null);
  return { panes, direction, ratio: previous?.ratio ?? 0.5, rowRatio: previous?.rowRatio ?? 0.5 };
}

/** Una sesión ocupa un solo panel; elegirla de nuevo no duplica su PTY. */
export function replaceSplitPane(layout: SplitLayout, index: number, id: string): SplitLayout {
  if (index < 0 || index >= layout.panes.length || layout.panes.some((pane, position) => pane === id && position !== index)) return layout;
  return { ...layout, panes: layout.panes.map((pane, position) => position === index ? id : pane) };
}

/** Usa los mismos márgenes exteriores e interiores en terminales y paneles libres. */
export function splitPaneStyle(layout: SplitLayout, index: number): Record<string, string> {
  const style: Record<string, string> = {};
  if (layout.direction !== "rows") {
    if (index % 2 === 0) style.right = `calc(${(1 - layout.ratio) * 100}% + var(--terminal-gap) / 2)`;
    else style.left = `calc(${layout.ratio * 100}% + var(--terminal-gap) / 2)`;
  }
  if (layout.direction !== "columns") {
    const ratio = layout.direction === "grid" ? layout.rowRatio : layout.ratio;
    if (layout.direction === "grid" ? index < 2 : index === 0) style.bottom = `calc(${(1 - ratio) * 100}% + var(--terminal-gap) / 2)`;
    else style.top = `calc(${ratio * 100}% + var(--terminal-gap) / 2)`;
  }
  return style;
}
