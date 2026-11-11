import { dateFormat, formatDate } from "./intl";
export type TimeFormat = "24h" | "12h";
export const normalizeTimeFormat = (value: unknown): TimeFormat => value === "12h" ? "12h" : "24h";
let current: TimeFormat = "24h";
const listeners = new Set<() => void>();
export const getTimeFormat = (): TimeFormat => current;
export const subscribeTimeFormat = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function applyTimeFormat(value: unknown): void {
  const next = normalizeTimeFormat(value);
  if (next === current) return;
  current = next;
  listeners.forEach(listener => listener());
}
/** Los cuatro formatos de hora posibles, creados una vez (ver `intl.ts`). */
const clockFormat = (format: TimeFormat, seconds: boolean): Intl.DateTimeFormat =>
  dateFormat({ hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: format === "12h" ? "h12" : "h23" });
export function formatClock(value: number | Date, format: TimeFormat = current, seconds = false): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return clockFormat(format, seconds).format(date);
}
/**
 * Intervalo «inicio → fin» compacto: en 12 h, si ambas horas comparten «a. m.»
 * o «p. m.», solo lo lleva la segunda (03:47 → 04:02 p. m.). Los espacios son
 * duros para que una hora nunca se parta entre líneas.
 */
export function formatClockRange(start: number | Date, end: number | Date, format: TimeFormat = current): string {
  const parts = (value: number | Date) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const pieces = clockFormat(format, false).formatToParts(date);
    const period = pieces.filter(part => part.type === "dayPeriod").map(part => part.value).join("").trim();
    const clock = pieces.filter(part => part.type !== "dayPeriod").map(part => part.value).join("").trim();
    return { clock, period };
  };
  const from = parts(start), to = parts(end);
  if (!from || !to) return "—";
  const hard = (text: string) => text.replace(/\s+/g, " ");
  const tail = to.period ? ` ${hard(to.period)}` : "";
  const head = from.period && from.period !== to.period ? `${from.clock} ${hard(from.period)}` : from.clock;
  return `${head} → ${to.clock}${tail}`;
}
export function formatDateTime(value: number, format: TimeFormat = current): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${formatDate(date, { dateStyle: "medium" })}, ${formatClock(date, format, true)}` : "—";
}
