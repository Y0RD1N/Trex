/**
 * Geometría del panel «Uso» en forma de cuaderno de campo: la regla de 0 a
 * 100 con una banderita por cuenta y las barras de celdas de cada ventana.
 * Sin DOM ni React: lo prueban los tests de `scripts/`.
 */

/** Cada barra tiene 25 celdas: una celda son 4 puntos. */
export const USAGE_CELLS = 25;

/**
 * Celdas llenas y celda que marca el tiempo transcurrido.
 * Cualquier uso por encima de 0 enciende al menos una celda (un 1 % no es «nada»).
 */
export function usageCells(percent: number, elapsed: number | null): { filled: number; time: number | null } {
  const used = Math.min(100, Math.max(0, percent));
  const filled = used <= 0 ? 0 : Math.min(USAGE_CELLS, Math.max(1, Math.round(used / (100 / USAGE_CELLS))));
  const time = elapsed === null ? null : Math.min(USAGE_CELLS - 1, Math.max(0, Math.floor(elapsed / (100 / USAGE_CELLS))));
  return { filled, time };
}

export type FlagInput = { percent: number; width: number };
export type FlagPlace = { /** Borde izquierdo de la etiqueta, en px. */ left: number; /** Centro del mástil, en px. */ stem: number; /** Fila: 0 es la más alta. */ level: number };

/** Hueco mínimo entre dos etiquetas de la misma fila, y entre una etiqueta y un mástil ajeno. */
const GAP = 4;
/** Cuánto entra el mástil en una etiqueta colgada a un lado (px). */
const ANCHOR = 6;

/**
 * Coloca las banderitas sobre una regla de `track` px. El mástil cae siempre en
 * el valor exacto; la etiqueta se centra encima y se recorta contra los bordes.
 * Si choca con otra etiqueta de su fila, o un mástil atraviesa una etiqueta,
 * baja una fila. Devuelve los sitios en el mismo orden que la entrada.
 */
export function layoutFlags(flags: FlagInput[], track: number): FlagPlace[] {
  const placed: (FlagPlace & { width: number })[] = new Array(flags.length);
  const order = flags.map((flag, index) => ({ flag, index })).sort((a, b) => a.flag.percent - b.flag.percent);
  const done: (FlagPlace & { width: number })[] = [];
  for (const { flag, index } of order) {
    const stem = Math.min(100, Math.max(0, flag.percent)) / 100 * track;
    const width = Math.min(flag.width, track);
    const clamp = (left: number) => Math.min(Math.max(0, left), Math.max(0, track - width));
    // Centrada sobre el mástil; si no cabe, colgada a su derecha o a su izquierda.
    const lefts = [...new Set([stem - width / 2, stem - ANCHOR, stem + ANCHOR - width].map(clamp))];
    const crosses = (x: number, from: number, to: number) => x > from - GAP && x < to + GAP;
    const sameRow = (level: number, left: number) => done.some(other =>
      other.level === level && left < other.left + other.width + GAP && left + width + GAP > other.left);
    const stemThrough = (level: number, left: number) => done.some(other =>
      other.level < level && crosses(other.stem, left, left + width)
      || other.level > level && crosses(stem, other.left, other.left + other.width));
    // Con `done.length` filas siempre queda una libre; si dos valores casi
    // coinciden, un mástil puede tener que pasar por detrás de una etiqueta.
    let best: { level: number; left: number } | null = null;
    for (let level = 0; level <= done.length && !best; level += 1) {
      const left = lefts.find(candidate => !sameRow(level, candidate) && !stemThrough(level, candidate));
      if (left !== undefined) best = { level, left };
    }
    if (!best) {
      let level = 0;
      while (sameRow(level, lefts[0])) level += 1;
      best = { level, left: lefts[0] };
    }
    const place = { left: best.left, stem, level: best.level, width };
    done.push(place);
    placed[index] = place;
  }
  return placed.map(({ left, stem, level }) => ({ left, stem, level }));
}
