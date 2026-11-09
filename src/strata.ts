/**
 * Núcleo de sondeo de un proyecto: una columna de estratos de tierra que se
 * calcula del identificador. Es siempre la misma para el mismo proyecto y casi
 * nunca se repite entre dos, así que sustituye a la carpeta gris o al punto de
 * color como seña de identidad en la barra lateral.
 */
export type Stratum = { height: number; color: string };

/** Tierras: siena, ocre, oliva, pizarra, óxido, hueso, umbra, arcilla y azul de sondeo. */
export const EARTH: readonly string[] = [
  "#b5651d", "#c9a227", "#6b7f4e", "#7c8794", "#8c3b2a", "#d8cfb4", "#4c3d2e", "#a0764a", "#5d6f78",
];

/** FNV-1a de 32 bits. */
const hash = (text: string): number => {
  let value = 2166136261;
  for (const char of text) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
};

/** xorshift32: determinista, sin estado compartido. */
const random = (seed: number): (() => number) => {
  let x = seed || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
};

/** Cuatro o cinco estratos cuyas alturas suman exactamente `height`. */
export function strata(seed: string, height = 20): Stratum[] {
  const next = random(hash(seed));
  const count = 4 + Math.floor(next() * 2);
  const layers: Stratum[] = [];
  let left = height;
  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1;
    const room = left - 2 * (count - 1 - index);
    const wanted = Math.round(height / count + (next() - 0.5) * (height / 4));
    const layer = last ? left : Math.max(2, Math.min(room, wanted));
    layers.push({ height: layer, color: EARTH[Math.floor(next() * EARTH.length)] });
    left -= layer;
  }
  return layers;
}
