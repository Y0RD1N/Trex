import { record, text, type ContextUsage, type Json } from "./chatState";
import { AcpConnection } from "./acpProtocol";
import { readApiUsage, tokenCount, type ApiUsage } from "./tokenUsage";
import type { PlanUsage, PlanWindow } from "./planUsage";

export function acpContext(raw: Json): ContextUsage | null {
  const used = tokenCount(raw.used), size = tokenCount(raw.size);
  return used !== null && size !== null && size > 0 ? { used, window: size, parts: [], reserve: null, total: null } : null;
}
export function antigravityTier(raw: unknown): string | null {
  const tier = record(record(record(raw)?._meta)?.antigravity)?.tier;
  const name = text(record(tier)?.name).trim();
  return name && name.length <= 100 && !/[\x00-\x1f\x7f]/.test(name) ? name : null;
}
const count = (value: string | undefined): number | null => value && /^\d{1,3}(?:,\d{3})*$|^\d+$/.test(value) ? tokenCount(Number(value.replace(/,/g, ""))) : null;
const utcReset = (raw: string | undefined): number | null => {
  const parts = raw?.match(/^([A-Z][a-z]{2}) (\d{2}), (\d{4}), (\d{2}):(\d{2}) UTC$/);
  if (!parts) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(parts[1]);
  const day = Number(parts[2]), year = Number(parts[3]), hour = Number(parts[4]), minute = Number(parts[5]);
  if (month < 0 || year < 2000 || hour > 23 || minute > 59) return null;
  const result = Date.UTC(year, month, day, hour, minute);
  return new Date(result).getUTCDate() === day ? result : null;
};
/** ACP 1.4.x reports /usage as English Markdown, not a quota RPC. Fail closed on other formats. */
export function parseAntigravityUsage(report: string, tier: string | null = null): { plan: PlanUsage | null; apiUsage: ApiUsage | null } {
  if (report.length > 128_000) throw new Error("Antigravity devolvió un informe de uso demasiado grande.");
  const summary = report.match(/^- \*\*Session total:\*\* ([\d,]+) tokens \(prompt: ([\d,]+), completion: ([\d,]+), thinking: ([\d,]+)\)/m);
  if (summary && summary.slice(1).some(value => count(value) === null)) throw new Error("Antigravity informó contadores de uso inválidos.");
  const apiUsage = summary ? readApiUsage({ totalTokens: count(summary[1]), inputTokens: count(summary[2]), outputTokens: count(summary[3]), thoughtTokens: count(summary[4]) }) : null;
  const windows: PlanWindow[] = [], seen = new Set<string>();
  const quota = report.split(/^### Quota Limits\s*$/m)[1];
  let group = "";
  if (quota) for (const line of quota.split("\n")) {
    const heading = line.match(/^- \*\*([^*\r\n]{1,100})\*\*\s*$/);
    if (heading) { group = heading[1].trim(); continue; }
    const row = line.match(/^\s+- \*\*([^*\r\n]{1,100}) Remaining:\*\* (\d+(?:\.\d+)?)% remaining(?: \(resets ([^)]+)\))?\s*$/);
    if (!row || !group) continue;
    const remaining = Number(row[2]); if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue;
    const period = /weekly/i.test(row[1]) ? "Semana" : /(?:5[ -]?hour|five[ -]?hour)/i.test(row[1]) ? "Sesión (5 h)" : row[1];
    const id = `antigravity:${group}:${row[1]}`; if (seen.has(id)) continue; seen.add(id);
    // The official display explicitly supplies UTC. Never interpret a missing zone as local time.
    const reset = utcReset(row[3]);
    const percent = Math.round((100 - remaining) * 100) / 100;
    windows.push({ id, label: `${period} · ${group}`, percent, resetsAt: reset,
      severity: percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal", headline: false,
      durationMs: period === "Semana" ? 7 * 24 * 3_600_000 : period === "Sesión (5 h)" ? 5 * 3_600_000 : null });
  }
  if (windows.length) windows.reduce((a, b) => b.percent > a.percent ? b : a).headline = true;
  if (quota?.trim() && !windows.length && !/not available|no quota|unavailable|does not apply/i.test(quota))
    throw new Error("No se reconocieron las cuotas de Antigravity. Se conserva la última lectura.");
  if (!apiUsage && !windows.length && !/^- \*\*Session total:\*\* data not available yet\s*$/m.test(report))
    throw new Error("El formato del informe de uso de Antigravity no es compatible. Se conserva la última lectura.");
  return { apiUsage, plan: windows.length || tier ? { plan: tier, windows, extra: null, resetCredits: 0 } : null };
}

/** One known native command at a time. Its output never becomes a chat/model message. */
export class AntigravityUsageReader {
  private commands = new Set<string>();
  private capture: { sessionId: string; text: string; invalid: boolean } | null = null;
  get supported(): boolean { return this.commands.has("usage"); }
  observe(sessionId: string, update: Json): boolean {
    if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands))
      this.commands = new Set(update.availableCommands.flatMap(c => typeof record(c)?.name === "string" ? [text(record(c)?.name)] : []));
    if (!this.capture || this.capture.sessionId !== sessionId || ["usage_update", "available_commands_update", "current_mode_update", "config_option_update"].includes(text(update.sessionUpdate))) return false;
    const content = record(update.content);
    if (update.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string" && this.capture.text.length + content.text.length <= 128_000)
      this.capture.text += content.text;
    else this.capture.invalid = true;
    return true;
  }
  async read(rpc: AcpConnection, sessionId: string, tier: string | null): Promise<ReturnType<typeof parseAntigravityUsage>> {
    if (!this.supported) throw new Error("Esta versión de Antigravity no anuncia el comando de uso.");
    if (this.capture) throw new Error("La lectura de uso ya está en curso.");
    const capture = { sessionId, text: "", invalid: false }; this.capture = capture;
    try {
      const result = await rpc.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "/usage" }] }, 30_000);
      if (result.stopReason !== "end_turn" || capture.invalid) throw new Error("Antigravity no confirmó una consulta de uso válida.");
      return parseAntigravityUsage(capture.text, tier);
    } finally { this.capture = null; }
  }
}
