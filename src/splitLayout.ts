export type SplitLayout = {
  first: string;
  second: string;
  direction: "columns" | "rows";
  ratio: number;
};
export function clampSplitRatio(value: number): number {
  return Math.min(0.75, Math.max(0.25, Number.isFinite(value) ? value : 0.5));
}
/** Cambiar el foco entre los dos paneles conserva sus posiciones y buffers. */
export function visibleSplit(
  layout: SplitLayout | null,
  ids: string[],
  active: string | null,
): SplitLayout | null {
  if (
    !layout ||
    !active ||
    !ids.includes(active) ||
    !ids.includes(layout.first) ||
    !ids.includes(layout.second) ||
    layout.first === layout.second
  )
    return null;
  if (active === layout.first || active === layout.second) return layout;
  return { ...layout, first: active };
}
