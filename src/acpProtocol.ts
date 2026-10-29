/** ACP v1 over stdio. No provider credentials or HTTP requests enter this module. */
import { record, text, type Json, type OutgoingImage } from "./chatState";

export type AcpTransport = { write: (line: string) => Promise<void> };
export class AcpError extends Error {
  constructor(message: string, public code: number, public data?: unknown) { super(message); }
}
type Pending = { resolve: (result: Json) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
export class AcpConnection {
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  constructor(private transport: AcpTransport,
    private notification: (method: string, params: Json) => void,
    private request: (id: string | number, method: string, params: Json) => void) {}
  call(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<Json> {
    return this.issue(method, params, timeoutMs).result;
  }
  issue(method: string, params: unknown = {}, timeoutMs = 60_000): { result: Promise<Json>; written: Promise<void> } {
    const id = ++this.sequence;
    let fail!: (error: Error) => void;
    const result = new Promise<Json>((resolve, reject) => {
      fail = (error: Error): void => { const entry = this.pending.get(id); if (!entry) return; clearTimeout(entry.timer); this.pending.delete(id); reject(error); };
      const timer = timeoutMs ? setTimeout(() => fail(new Error(`Antigravity no respondió a ${method}.`)), timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
    });
    const written = Promise.resolve().then(() => {
      if (this.closed) throw new Error("La conexión con Antigravity está cerrada.");
      return this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    }).catch(error => { fail(error instanceof Error ? error : new Error(String(error))); throw error; });
    void written.catch(() => undefined);
    return { result, written };
  }
  notify(method: string, params: unknown): Promise<void> {
    return this.closed ? Promise.reject(new Error("La conexión está cerrada.")) : this.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
  reply(id: string | number, result: unknown): Promise<void> {
    return this.closed ? Promise.reject(new Error("La conexión está cerrada.")) : this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  reject(id: string | number, message = "Unsupported client method"): Promise<void> {
    return this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }));
  }
  accept(line: string): void {
    if (this.closed) return;
    let message: Json | null;
    try { message = record(JSON.parse(line)); } catch { return; }
    if (!message || message.jsonrpc !== "2.0") return;
    if (typeof message.method === "string") {
      const params = record(message.params) ?? {};
      if (typeof message.id === "number" || typeof message.id === "string") this.request(message.id, message.method, params);
      else this.notification(message.method, params);
      return;
    }
    if (typeof message.id !== "number" || !("result" in message || "error" in message)) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id); clearTimeout(entry.timer);
    const error = record(message.error);
    if (error) entry.reject(new AcpError(text(error.message) || "Antigravity rechazó la petición.", typeof error.code === "number" ? error.code : -32603, error.data));
    else entry.resolve(record(message.result) ?? {});
  }
  close(reason = "La sesión de Antigravity se cerró."): void {
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    this.pending.clear();
  }
}

export const validAcpSessionId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id);
export function sameAcpCwd(left: string, right: string): boolean {
  const normalize = (value: string): string => /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(value)
    ? value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : value.replace(/\/+$/, "") || "/";
  return normalize(left) === normalize(right);
}
export function acpPrompt(value: string, images: OutgoingImage[], imageSupported: boolean): unknown[] {
  if (images.length && !imageSupported) throw new Error("Esta versión de Antigravity no admite imágenes. Tus adjuntos se conservan.");
  return [...(value ? [{ type: "text", text: value }] : []), ...images.map(image => {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mediaType) || !/^[a-z0-9+/]*={0,2}$/i.test(image.data) || image.data.length > 32 * 1024 * 1024)
      throw new Error("Una imagen no tiene un formato válido para Antigravity.");
    return { type: "image", mimeType: image.mediaType, data: image.data };
  })];
}
export type AcpMcpServer = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
export function acpMcpServer(name: string, config: { command: string; args: string[] }): AcpMcpServer {
  if (!/^[a-z][a-z0-9_]*$/.test(name) || !config.command || !Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string")) throw new Error("Configuración MCP no válida.");
  return { name, command: config.command, args: config.args, env: [] };
}
