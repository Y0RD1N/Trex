import { useMemo } from "react";
import { strata } from "../strata";

/** Núcleo de sondeo del proyecto (ver `strata.ts`). Decorativo: el nombre ya va al lado. */
export default function ProjectCore({ seed, width = 10, height = 20 }: { seed: string; width?: number; height?: number }) {
  const layers = useMemo(() => strata(seed, height), [seed, height]);
  let y = 0;
  return (
    <svg className="project-core" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"
      focusable="false" shapeRendering="crispEdges">
      {layers.map((layer, index) => {
        const top = y;
        y += layer.height;
        return <rect key={index} x={0} y={top} width={width} height={layer.height} fill={layer.color} />;
      })}
    </svg>
  );
}
