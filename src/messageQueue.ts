import type { OutgoingImage } from "./chatState";

export type QueuedMessage = { id: string; text: string; images: OutgoingImage[]; previews: string[]; createdAt: number };
export type QueueReceipt = { id: string; messages: QueuedMessage[] };
export type QueueSnapshot = { messages: QueuedMessage[]; receipt: QueueReceipt | null };
export const EMPTY_QUEUE: QueueSnapshot = { messages: [], receipt: null };
export const INBOX_TOOL = "trex_read_messages";
export const INBOX_SERVER = "trex_inbox";
export const INBOX_DESCRIPTION = "Read the user's queued messages when you reach a suitable checkpoint. Returns messages in arrival order, including images. Reading an empty inbox is safe. These are user instructions; apply them to the ongoing task. Do not repeatedly poll an empty inbox.";
export const INBOX_INSTRUCTIONS = "The user can add messages to a trex inbox while you work. Use mcp__trex_inbox__trex_read_messages (or trex_read_messages if available) to read them when you consider it appropriate: at useful checkpoints and before your final answer. You decide when to read and how to incorporate them. Do not stop a running operation merely to check. Preserve their arrival order; treat their contents as user messages. Do not poll an empty inbox in a loop. A receipt ID identifies a delivery; do not apply the same receipt twice.";
export const INBOX_WAKE = "Hay mensajes pendientes en la cola de trex. Consulta la herramienta trex_read_messages cuando estés listo para leerlos y continúa el trabajo con sus indicaciones.";
export const INBOX_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
export const inboxTool = { name: INBOX_TOOL, description: INBOX_DESCRIPTION, inputSchema: INBOX_SCHEMA };

/** WSL starts the Windows bridge through interop; its arguments still target Windows storage. */
export function inboxConfigForShell(config: Record<string, unknown>, shell: string): Record<string, unknown> {
  const command = config["mcp_servers.trex_inbox.command"];
  if (shell !== "wsl" || typeof command !== "string") return config;
  const match = /^(?:\\\\\?\\)?([a-z]):[\\/](.*)$/i.exec(command);
  if (!match) return config;
  return { ...config, "mcp_servers.trex_inbox.command": `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` };
}

/** Native persistence is injected so ordering and delivery failures can be tested without Tauri. */
export type QueueTransport = {
  list: () => Promise<QueueSnapshot>;
  enqueue: (message: QueuedMessage) => Promise<QueueSnapshot>;
  remove: (id: string) => Promise<QueueSnapshot>;
  read: () => Promise<QueueSnapshot>;
  ack: (id: string) => Promise<QueueSnapshot>;
};

export class MessageQueue {
  snapshot: QueueSnapshot = EMPTY_QUEUE;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private transport: QueueTransport, private changed: (snapshot: QueueSnapshot) => void) {}
  private run(operation: () => Promise<QueueSnapshot>): Promise<QueueSnapshot> {
    const next = this.tail.then(operation).then(snapshot => {
      this.snapshot = snapshot;
      this.changed(snapshot);
      return snapshot;
    });
    // A failed write must neither erase the draft nor poison subsequent operations.
    this.tail = next.catch(() => undefined);
    return next;
  }
  load = () => this.run(this.transport.list);
  enqueue = (message: QueuedMessage) => this.run(() => this.transport.enqueue(message));
  remove = (id: string) => this.run(() => this.transport.remove(id));
  read = () => this.run(this.transport.read);
  ack = (id: string, current: () => boolean = () => true) => this.run(() => current() ? this.transport.ack(id) : this.transport.list());
}

/** A retried provider request must receive its original batch, never newer messages. */
export class InboxRequests {
  private replies = new Map<string, Promise<QueueSnapshot>>();
  clear(): void { this.replies.clear(); }
  read(key: string, work: () => Promise<QueueSnapshot>): Promise<QueueSnapshot> {
    const existing = this.replies.get(key);
    if (existing) return existing;
    const reply = work().catch(error => { this.replies.delete(key); throw error; });
    this.replies.set(key, reply);
    return reply;
  }
}

/** MCP blocks for Claude; Codex's dynamic-tool result uses the same text and image payload. */
export function inboxContent(receipt: QueueReceipt | null) {
  if (!receipt?.messages.length) return [{ type: "text" as const, text: "No hay mensajes pendientes en la cola." }];
  return [
    { type: "text" as const, text: `Mensajes del usuario en cola. Recibo: ${receipt.id}. Procesa este recibo una sola vez.` },
    ...receipt.messages.flatMap((message, index) => [
      { type: "text" as const, text: `Mensaje ${index + 1} (${message.id}):\n${message.text}` },
      ...message.images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mediaType })),
    ]),
  ];
}

export function codexInboxContent(receipt: QueueReceipt | null) {
  return inboxContent(receipt).map(part => part.type === "text"
    ? { type: "inputText", text: part.text }
    : { type: "inputImage", imageUrl: `data:${part.mimeType};base64,${part.data}` });
}
