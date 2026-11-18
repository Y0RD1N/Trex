import { SKULL_BONE, SKULL_BOX, SKULL_EYE, SKULL_SHADE } from "./brandSkull";

/**
 * La marca de trex: el cráneo de un Tyrannosaurus rex en pixel art (el mismo de
 * `public/trex.svg`), sin el recuadro del icono. El hueso toma el color del texto
 * (`currentColor`), la sombra es ese mismo color atenuado y el ojo, el acento.
 * `size` es el alto; el ancho sale de la proporción del dibujo, que es apaisado.
 * El dibujo se genera con `scripts/make_logo.py`.
 */
export default function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  const [x, y, width, height] = SKULL_BOX;
  return (
    <svg className={`brand-mark${className ? ` ${className}` : ""}`} width={Math.round((size * width) / height)} height={size}
      viewBox={`${x} ${y} ${width} ${height}`} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={SKULL_BONE} />
      <path d={SKULL_SHADE} opacity=".55" />
      <path d={SKULL_EYE} fill="var(--accent-strong)" />
    </svg>
  );
}
