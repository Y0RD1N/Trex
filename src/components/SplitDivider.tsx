import type { SplitLayout } from "../splitLayout";
import { clampSplitRatio } from "../splitLayout";
export default function SplitDivider({
  layout,
  onChange,
}: {
  layout: SplitLayout;
  onChange: (layout: SplitLayout) => void;
}) {
  const columns = layout.direction === "columns";
  return (
    <div
      className={`split-divider ${layout.direction}`}
      role="separator"
      tabIndex={0}
      aria-label="Redimensionar paneles de terminal"
      aria-orientation={columns ? "vertical" : "horizontal"}
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(layout.ratio * 100)}
      style={
        columns
          ? { left: `calc(${layout.ratio * 100}% - 5px)` }
          : { top: `calc(${layout.ratio * 100}% - 5px)` }
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
        onChange({ ...layout, ratio: clampSplitRatio(value) });
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
            ratio:
              event.key === "Home"
                ? 0.5
                : clampSplitRatio(layout.ratio + delta),
          });
        }
      }}
    >
      <span />
    </div>
  );
}
