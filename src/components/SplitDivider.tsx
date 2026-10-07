import type { SplitLayout } from "../splitLayout";
import { clampSplitRatio } from "../splitLayout";
export default function SplitDivider({
  layout,
  axis,
  onChange,
}: {
  layout: SplitLayout;
  axis: "columns" | "rows";
  onChange: (layout: SplitLayout) => void;
}) {
  const columns = axis === "columns";
  const field = layout.direction === "grid" && !columns ? "rowRatio" : "ratio";
  const ratio = layout[field];
  return (
    <div
      className={`split-divider ${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={columns ? "Ajustar ancho de los paneles" : "Ajustar alto de los paneles"}
      aria-orientation={columns ? "vertical" : "horizontal"}
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(ratio * 100)}
      style={
        columns
          ? { left: `calc(${ratio * 100}% - 5px)` }
          : { top: `calc(${ratio * 100}% - 5px)` }
      }
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds =
          event.currentTarget.parentElement!.getBoundingClientRect();
        const value = columns
          ? (event.clientX - bounds.left) / bounds.width
          : (event.clientY - bounds.top) / bounds.height;
        onChange({ ...layout, [field]: clampSplitRatio(value) });
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        const delta = ["ArrowLeft", "ArrowUp"].includes(event.key)
          ? -0.05
          : ["ArrowRight", "ArrowDown"].includes(event.key)
            ? 0.05
            : 0;
        if (delta || event.key === "Home") {
          event.preventDefault();
          onChange({
            ...layout,
            [field]:
              event.key === "Home"
                ? 0.5
                : clampSplitRatio(ratio + delta),
          });
        }
      }}
    />
  );
}
