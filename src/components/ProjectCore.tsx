import { useId, useMemo } from "react";
import { strata } from "../strata";
import { FOLDER_PATH } from "./Icons";

/** El sedimento llena la mitad baja de la carpeta: desde aquí hasta el fondo (y = 18,9 en la caja de 24). */
const SEDIMENT_TOP = 11.6;
const SEDIMENT_HEIGHT = 7.4;

/**
 * Carpeta del proyecto con su sedimento: el contorno es el de los demás iconos y la mitad de abajo lleva
 * los estratos del proyecto (ver `strata.ts`), así que se lee como carpeta y sigue siendo única.
 * Decorativa: el nombre ya va al lado.
 */
export default function ProjectCore({ seed, size = 18 }: { seed: string; size?: number }) {
  const clip = `sediment-${useId().replace(/[^\w-]/g, "")}`;
  const layers = useMemo(() => strata(seed), [seed]);
  let y = SEDIMENT_TOP;
  return (
    <svg className="project-core" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <clipPath id={clip}><path d={FOLDER_PATH} /></clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect width={24} height={24} fill="currentColor" opacity={0.1} />
        {layers.map((layer, index) => {
          const top = y;
          const height = layer.height * SEDIMENT_HEIGHT / 20;
          y += height;
          // Un pelo de solape para que el antialiasing no deje rendijas entre estratos.
          return <rect key={index} x={0} y={top} width={24} height={height + 0.02} fill={layer.color} />;
        })}
      </g>
      <path d={FOLDER_PATH} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
