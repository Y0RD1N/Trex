/**
 * Formateadores de números y fechas en español, creados una sola vez.
 *
 * Rendimiento: `n.toLocaleString("es", …)`, `date.toLocaleDateString(…)` y `new Intl.*` construyen
 * un formateador nuevo en cada llamada, y en WebKit eso cuesta decenas de microsegundos (carga los
 * datos de ICU). Con el chat recibiendo texto, los contadores y las horas se repintan varias veces por
 * segundo y esas construcciones eran lo que más CPU gastaba en JavaScript. Aquí se guardan por opciones.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const collators = new Map<string, Intl.Collator>();

const keyOf = (options: object | undefined): string => options ? JSON.stringify(options) : "";

function cached<T>(table: Map<string, T>, options: object | undefined, create: () => T): T {
  const key = keyOf(options);
  let format = table.get(key);
  if (!format) {
    format = create();
    table.set(key, format);
  }
  return format;
}

/** Igual que `value.toLocaleString("es", options)`. */
export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
  cached(numberFormats, options, () => new Intl.NumberFormat("es", options)).format(value);

/** Formateador de fechas en español (como `new Intl.DateTimeFormat("es", options)`), reutilizado. */
export const dateFormat = (options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  cached(dateFormats, options, () => new Intl.DateTimeFormat("es", options));

/** Igual que `date.toLocaleDateString("es", options)` / `toLocaleTimeString` con campos explícitos. */
export const formatDate = (value: number | Date, options: Intl.DateTimeFormatOptions): string =>
  dateFormat(options).format(value);

/** Igual que `a.localeCompare(b, "es", options)`. */
export const compareText = (a: string, b: string, options?: Intl.CollatorOptions): number =>
  cached(collators, options, () => new Intl.Collator("es", options)).compare(a, b);
