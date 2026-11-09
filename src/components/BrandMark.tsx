/**
 * La «t» de trex (la misma de `public/trex.svg`) sin el recuadro redondeado:
 * una letra de ángulos rectos, con la cola del trazo doblada, que se asienta
 * sobre la retícula. Toma el color del texto (`currentColor`).
 */
export default function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={`brand-mark${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="240 248 544 544"
      fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M432 248h120v104h200v112H552v160q0 56 56 56h128v112H592q-160 0-160-160V464H272V352h160Z" />
    </svg>
  );
}
