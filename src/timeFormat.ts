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
export function formatClock(value: number | Date, format: TimeFormat = current, seconds = false): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: format === "12h" ? "h12" : "h23" }).format(date);
}
export function formatDateTime(value: number, format: TimeFormat = current): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toLocaleDateString("es", { dateStyle: "medium" })}, ${formatClock(date, format, true)}` : "—";
}
