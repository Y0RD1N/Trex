/** Live terminal ownership belongs to a process generation, never to transcript history. */
import type { AgentProvider } from "./types";

type Json = Record<string, unknown>;
const object = (v: unknown): Json | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Json : null;
const string = (v: unknown): string => typeof v === "string" ? v : "";
const bytes = (v: string): Uint8Array => new TextEncoder().encode(v);
const tail = (v: string): string => { const encoded = bytes(v); if (encoded.length <= 65_536) return v; let start = encoded.length - 65_536; while ((encoded[start] & 0xc0) === 0x80) start++; return new TextDecoder().decode(encoded.subarray(start)); };
const finished = new Set(["completed", "failed", "stopped", "killed", "exited"]);
let serial = 0;

export type AgentTerminal = {
  id: string; command: string; cwd: string; startedAt: number | null;
  state: "running" | "stopping" | "completed" | "failed" | "stopped" | "unknown";
  output: string; truncated: boolean; exitCode?: number | null; canStop: boolean;
};
export type TerminalSnapshot = { status: "disconnected" | "loading" | "ready" | "unsupported" | "error"; entries: AgentTerminal[]; error: string | null };
export type TerminalSession = {
  snapshot: TerminalSnapshot;
  refresh: () => Promise<void>;
  read: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
};
type Entry = AgentTerminal & { nativeId: string; thread: string; itemId: string; outputFile: boolean };
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type NativeLog = (processId: string, taskId: string) => Promise<{ text: string; truncated: boolean; available?: boolean }>;

/** Uses only provider-owned IDs. In particular, Codex processId is NOT an OS PID. */
export class AgentTerminals {
  snapshot: TerminalSnapshot = { status: "disconnected", entries: [], error: null };
  private process: string | null = null;
  private cwd = "";
  private root = "";
  private scopes = new Set<string>();
  private entries = new Map<string, Entry>();
  private ended = new Set<string>();
  private tools = new Map<string, { command: string; output: string; truncated?: boolean }>();
  private pending = new Map<string, Pending>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private confirmations = new Set<ReturnType<typeof setTimeout>>();
  private polling: Promise<void> | null = null;
  private epoch = 0;
  private sequence = 0;
  private prefix = `trex-terminals-${++serial}-`;
  constructor(private provider: AgentProvider | undefined, private write: (process: string, line: string) => Promise<void>, private nativeLog?: NativeLog) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(status = this.snapshot.status, error: string | null = null): void {
    this.snapshot = { status, entries: [...this.entries.values()].map(({ nativeId: _id, thread: _thread, itemId: _item, outputFile: _file, ...entry }) => entry), error };
    for (const listener of this.listeners) listener();
  }
  attach(process: string, cwd: string): void {
    this.detach(); this.process = process; this.cwd = cwd; this.entries.clear(); this.ended.clear(); this.tools.clear(); this.scopes.clear(); this.root = "";
    this.publish("loading");
  }
  detach(): void {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.polling = null; this.process = null;
    for (const timer of this.confirmations) clearTimeout(timer); this.confirmations.clear();
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("La sesión de la terminal se cerró.")); }
    this.pending.clear();
    for (const entry of this.entries.values()) if (entry.state === "running" || entry.state === "stopping") { entry.state = "unknown"; entry.canStop = false; }
    this.publish("disconnected");
  }
  bind = (id: string): void => {
    if (!this.process || !id || this.root === id) return;
    this.root = id; this.scopes.add(id);
    if (this.provider === "claude") this.publish("ready");
    else void this.refresh();
  };
  private request(method: string, params: Json): Promise<Json> {
    const process = this.process;
    if (!process) return Promise.reject(new Error("La sesión ya no está conectada."));
    const id = this.prefix + (++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("El proveedor no respondió a la consulta de terminales.")); }, /terminate|stop/.test(method) || params.subtype === "stop_task" ? 12_000 : 7000);
      this.pending.set(id, { resolve, reject, timer });
      const line = this.provider === "claude" ? { type: "control_request", request_id: id, request: params }
        : { jsonrpc: "2.0", id, method, params };
      void this.write(process, JSON.stringify(line)).catch(error => {
        const waiter = this.pending.get(id); if (!waiter) return;
        clearTimeout(waiter.timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.process && this.root && this.provider !== "claude" && this.snapshot.status !== "unsupported") this.timer = setTimeout(() => { void this.refresh(); }, 2500);
  }
  refresh = (): Promise<void> => {
    if (this.polling) return this.polling;
    if (!this.process || !this.root || !this.provider || this.provider === "claude") return Promise.resolve();
    const epoch = this.epoch;
    const work = (async () => {
      try {
        const live = new Set<string>();
        for (const thread of [...this.scopes]) {
          let cursor: string | null = null;
          const cursors = new Set<string>(); let pages = 0;
          do {
            const result = await this.request(this.provider === "codex" ? "thread/backgroundTerminals/list" : "process/list",
              this.provider === "codex" ? { threadId: thread, cursor, limit: 100 } : { sessionId: thread });
            if (epoch !== this.epoch) return;
            const rows = this.provider === "codex" ? result.data : result.processes;
            if (!Array.isArray(rows)) throw new Error("El proveedor devolvió una lista de terminales no válida.");
            for (const raw of rows) {
              const row = object(raw), nativeId = string(row?.processId ?? row?.id);
              if (!row || !nativeId || nativeId.length > 256 || typeof row.command !== "string" || typeof row.cwd !== "string") throw new Error("El proveedor devolvió una terminal no válida.");
              const itemId = string(row.itemId), id = JSON.stringify([this.process, thread, nativeId, itemId]); live.add(id);
              const previous = this.entries.get(id);
              const state = finished.has(string(row.status)) ? (row.status === "stopped" ? "stopped" : row.status === "failed" ? "failed" : "completed") : row.status === "stopping" || previous?.state === "stopping" ? "stopping" : "running";
              this.entries.set(id, { id, nativeId, thread, itemId, outputFile: false, command: string(row.command) || "Terminal", cwd: string(row.cwd) || this.cwd,
                startedAt: typeof row.startedAt === "number" ? row.startedAt : previous?.startedAt ?? null, state,
                output: previous?.output || this.tools.get(JSON.stringify([thread, itemId]))?.output || "", truncated: previous?.truncated || this.tools.get(JSON.stringify([thread, itemId]))?.truncated || false,
                canStop: state === "running" || state === "stopping", exitCode: typeof row.exitCode === "number" ? row.exitCode : null });
            }
            cursor = string(result.nextCursor) || null;
            if (cursor && (cursors.has(cursor) || ++pages >= 10)) throw new Error("La lista de terminales excede el límite de consulta.");
            if (cursor) cursors.add(cursor);
          } while (cursor);
        }
        if (epoch !== this.epoch) return;
        for (const [id, entry] of this.entries) if (!live.has(id) && (entry.state === "running" || entry.state === "stopping")) {
          entry.state = entry.state === "stopping" ? "stopped" : "completed"; entry.canStop = false;
        }
        this.prune(); this.publish("ready");
      } catch (error) {
        if (epoch !== this.epoch) return;
        const message = error instanceof Error ? error.message : String(error);
        this.publish(/method not found|unknown method|not supported|experimental.*not enabled/i.test(message) ? "unsupported" : "error", message);
      }
    })();
    this.polling = work;
    void work.finally(() => { if (epoch === this.epoch) { this.polling = null; this.schedule(); } });
    return work;
  };
  read = async (id: string): Promise<void> => {
    const entry = this.entries.get(id), epoch = this.epoch;
    if (!entry || !this.process) return;
    if (this.provider === "codex") return;
    const data = this.provider === "trex" ? await this.request("process/read", { sessionId: entry.thread, processId: entry.nativeId })
      : this.nativeLog ? await this.nativeLog(this.process, entry.nativeId) : null;
    const current = this.entries.get(id);
    if (data && data.available !== false && epoch === this.epoch && current) {
      current.output = tail(string(data.text)); current.truncated = data.truncated === true; this.publish();
    }
  };
  stop = async (id: string): Promise<void> => {
    const entry = this.entries.get(id), epoch = this.epoch;
    if (!entry || entry.state !== "running" || !entry.canStop || !this.process) return;
    entry.state = "stopping"; this.publish();
    try {
      const result = await this.request(this.provider === "codex" ? "thread/backgroundTerminals/terminate" : "process/stop",
        this.provider === "claude" ? { subtype: "stop_task", task_id: entry.nativeId }
          : this.provider === "codex" ? { threadId: entry.thread, processId: entry.nativeId } : { sessionId: entry.thread, processId: entry.nativeId });
      if (epoch !== this.epoch) return;
      if (this.provider === "claude") { // Native terminal lifecycle, rather than an optimistic acknowledgement, clears it.
        const confirmation = setTimeout(() => { const current = this.entries.get(id); if (epoch === this.epoch && current?.state === "stopping") { current.state = "running"; this.publish("error", "Claude aún no confirmó el cierre. Puedes volver a consultar la terminal."); } }, 7000);
        // A detached runtime must not retain a timer (including in offline tests).
        this.confirmations.add(confirmation);
      } else {
        if (result.terminated !== true && result.terminated !== false) throw new Error("El proveedor no confirmó el cierre de la terminal.");
        await this.refresh();
      }
    } catch (error) {
      if (epoch === this.epoch) { const current = this.entries.get(id); if (current?.state === "stopping") current.state = "running"; this.publish("error", error instanceof Error ? error.message : String(error)); }
      throw error;
    }
  };
  /** Return true only for our own responses; other protocol consumers still receive every event. */
  observe(line: string, process: string): boolean {
    if (process !== this.process) return false;
    let event: Json | null; try { event = object(JSON.parse(line)); } catch { return false; }
    if (!event) return false;
    const response = object(event.response), id = string(event.id ?? response?.request_id);
    if (id.startsWith(this.prefix)) {
      const waiter = this.pending.get(id); if (!waiter) return true;
      clearTimeout(waiter.timer); this.pending.delete(id);
      const error = object(event.error);
      if (error || response?.subtype === "error") waiter.reject(new Error((error?.code === -32601 ? "method not found: " : "") + (string(error?.message ?? response?.error) || "No se pudo gestionar la terminal.")));
      else waiter.resolve(object(event.result ?? response?.response) ?? {});
      return true;
    }
    if (this.provider === "claude") this.observeClaude(event);
    if (this.provider === "codex") this.observeCodex(event);
    return false;
  }
  private observeCodex(event: Json): void {
    const params = object(event.params), thread = string(params?.threadId), item = object(params?.item);
    if (!this.scopes.has(thread)) return;
    if (item?.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)) {
      for (const id of item.receiverThreadIds) if (typeof id === "string" && this.scopes.size < 64) this.scopes.add(id);
    }
    const itemId = string(item?.id ?? params?.itemId), key = JSON.stringify([thread, itemId]);
    if (!itemId) return;
    if (item?.type === "commandExecution") {
      const old = this.tools.get(key);
      this.tools.set(key, { command: string(item.command), output: typeof item.aggregatedOutput === "string" ? tail(item.aggregatedOutput) : old?.output ?? "", truncated: old?.truncated || bytes(string(item.aggregatedOutput)).length > 65_536 });
    } else if (event.method === "item/commandExecution/outputDelta") {
      const old = this.tools.get(key) ?? { command: "", output: "" }; const combined = old.output + string(params?.delta); this.tools.set(key, { ...old, output: tail(combined), truncated: old.truncated || bytes(combined).length > 65_536 });
    } else return;
    for (const entry of this.entries.values()) if (entry.thread === thread && entry.itemId === itemId) { entry.output = this.tools.get(key)?.output ?? entry.output; entry.truncated ||= this.tools.get(key)?.truncated ?? false; }
    while (this.tools.size > 200) this.tools.delete(this.tools.keys().next().value!);
    this.publish();
  }
  private observeClaude(event: Json): void {
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") this.bind(event.session_id);
    if (!this.root || (event.session_id && event.session_id !== this.root)) return;
    const message = object(event.message);
    if (Array.isArray(message?.content)) for (const raw of message.content) {
      const block = object(raw); if (!block) continue;
      if (block.type === "tool_use" && block.name === "Bash") this.tools.set(string(block.id), { command: string(object(block.input)?.command), output: "" });
      if (block.type === "tool_result" && this.tools.has(string(block.tool_use_id))) {
        const tool = this.tools.get(string(block.tool_use_id))!;
        const output = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map(c => string(object(c)?.text)).join("\n") : "";
        tool.output = tail(output); tool.truncated = bytes(output).length > 65_536;
        for (const entry of this.entries.values()) if (entry.itemId === block.tool_use_id) { entry.output = tool.output; entry.truncated = tool.truncated; }
        this.publish();
      }
    }
    if (event.type !== "system") return;
    const subtype = string(event.subtype);
    if (subtype === "background_tasks_changed" && Array.isArray(event.tasks)) {
      const live = new Set<string>();
      for (const task of event.tasks) { const data = object(task); if (data) { const nativeId = string(data.task_id ?? data.taskId ?? data.id); live.add(nativeId); this.claudeTask(data, nativeId); } }
      for (const entry of this.entries.values()) if (!live.has(entry.nativeId) && ["running", "stopping"].includes(entry.state)) { this.ended.add(entry.nativeId); entry.state = entry.state === "stopping" ? "stopped" : "completed"; entry.canStop = false; }
      this.prune(); this.publish("ready"); return;
    }
    const nativeId = string(event.task_id); if (!nativeId) return;
    const terminalStatus = string(object(event.patch)?.status ?? event.status);
    if (["task_notification", "task_updated"].includes(subtype) && finished.has(terminalStatus)) this.ended.add(nativeId);
    if (subtype === "task_started") this.claudeTask(event, nativeId);
    const entry = [...this.entries.values()].find(e => e.nativeId === nativeId);
    if (!entry) return;
    if (typeof event.output_file === "string") entry.outputFile = true;
    const patch = object(event.patch), status = string(patch?.status ?? event.status);
    if (["task_notification", "task_updated"].includes(subtype) && finished.has(status)) { entry.state = ["killed", "stopped"].includes(status) ? "stopped" : status === "failed" ? "failed" : "completed"; entry.canStop = false; }
    if (typeof event.summary === "string" && !entry.output) entry.output = tail(event.summary);
    this.prune(); this.publish("ready");
  }
  private claudeTask(data: Json, nativeId: string): void {
    const itemId = string(data.tool_use_id ?? data.toolUseId), tool = this.tools.get(itemId), type = string(data.task_type ?? data.taskType ?? (data.type === "system" ? "" : data.type));
    if (!nativeId || nativeId.length > 256 || this.ended.has(nativeId) || (type ? type !== "local_bash" : !tool)) return;
    const id = JSON.stringify([this.process, this.root, nativeId]), previous = this.entries.get(id);
    this.entries.set(id, { id, nativeId, thread: this.root, itemId: itemId || previous?.itemId || "", command: tool?.command || previous?.command || string(data.description) || "Terminal de Claude",
      cwd: this.cwd, state: previous?.state === "stopping" ? "stopping" : "running", startedAt: previous?.startedAt ?? Date.now(), output: previous?.output || tool?.output || "", truncated: previous?.truncated || tool?.truncated || false,
      canStop: true, outputFile: !!data.output_file || previous?.outputFile || false });
  }
  private prune(): void {
    const ended = [...this.entries.values()].filter(e => !["running", "stopping", "unknown"].includes(e.state));
    for (const entry of ended.slice(0, Math.max(0, ended.length - 20))) this.entries.delete(entry.id);
    while (this.tools.size > 200) this.tools.delete(this.tools.keys().next().value!);
  }
}

export type TerminalOwner = { id: string; label: string; provider: AgentProvider; session: TerminalSession };
