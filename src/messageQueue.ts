import type { OutgoingImage } from "./chatState";
import { imageReference } from "./imageReferences";

export type QueuedMessage = { id: string; text: string; images: OutgoingImage[]; previews: string[]; createdAt: number };
export type QueueReceipt = { id: string; messages: QueuedMessage[] };
export type QueueDispatch = { id: string; message: QueuedMessage; predecessors: string[] };
export type QueueSnapshot = { messages: QueuedMessage[]; receipt: QueueReceipt | null; outbox?: QueueDispatch[] };
export const EMPTY_QUEUE: QueueSnapshot = { messages: [], receipt: null };
/** Room and team runtime IDs also need the durable native inbox namespace. */
export const messageQueueId = (id: string): string => id.startsWith("t-") ? id : `t-${id}`;
export const INBOX_TOOL = "trex_read_messages";
export const INBOX_SERVER = "trex_inbox";
export const INBOX_DESCRIPTION = "Read user messages queued during this turn, in arrival order with images. Trex delivers them automatically when the turn ends, so call this only after a major step of long work; never poll. Apply each receipt once.";
/** Stable text (no per-turn data) so providers can cache the prompt prefix. */
export const INBOX_INSTRUCTIONS = "User messages sent while you work are queued; trex delivers them automatically as the next user turn when yours ends. In long multi-step work you may read them earlier with trex_read_messages (trex_inbox) after a major step; never poll, re-read an empty inbox or interrupt an operation to check. Treat them as user messages in arrival order; apply each receipt ID only once.";
/**
 * Sentinel passed to `ChatSession.send` to continue with the queue. Providers
 * replace it with the claimed messages themselves (one request, no tool call);
 * the text is only a fallback for a session that cannot do so.
 */
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
  update: (id: string, text: string, expectedText: string) => Promise<QueueSnapshot>;
  claimDirect: (id: string, expected: QueuedMessage) => Promise<QueueSnapshot>;
  ackDirect: (id: string) => Promise<QueueSnapshot>;
  restoreDirect: (id: string) => Promise<QueueSnapshot>;
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
  update = (id: string, text: string, expectedText: string) => this.run(() => this.transport.update(id, text, expectedText));
  claimDirect = (id: string, expected: QueuedMessage) => this.run(() => this.transport.claimDirect(id, expected));
  ackDirect = (id: string) => this.run(() => this.transport.ackDirect(id));
  restoreDirect = (id: string) => this.run(() => this.transport.restoreDirect(id));
}

/** Reserve before sending so an inbox read cannot deliver the same message.
 * Uncertain writes remain durable for explicit review; never automatically replay.
 */
export async function dispatchQueuedMessage(queue: MessageQueue, message: QueuedMessage,
  send: (message: QueuedMessage) => void | Promise<boolean>, current: () => boolean = () => true): Promise<void> {
  if (!current()) throw new Error("La conversación ya no está disponible.");
  const claimed = await queue.claimDirect(message.id, message);
  const dispatch = claimed.outbox?.find(entry => entry.message.id === message.id);
  if (!dispatch) throw new Error("El mensaje ya no está disponible para enviarlo directamente.");
  if (!current()) throw new Error("El envío quedó pendiente de revisión al cerrar la conversación.");
  const accepted = await send(dispatch.message);
  if (accepted !== true) throw new Error("No se confirmó el envío directo. Revisa el historial antes de devolver el mensaje a la cola.");
  if (!current()) throw new Error("El envío aceptado quedó pendiente de confirmación al cerrar la conversación.");
  await queue.ackDirect(dispatch.id);
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

export const inboxReceiptHeader = (id: string): string => `Mensajes del usuario en cola. Recibo: ${id}. Procesa este recibo una sola vez.`;

/** MCP blocks for Claude; Codex's dynamic-tool result uses the same text and image payload. */
export function inboxContent(receipt: QueueReceipt | null) {
  if (!receipt?.messages.length) return [{ type: "text" as const, text: "No hay mensajes pendientes en la cola." }];
  return [
    { type: "text" as const, text: inboxReceiptHeader(receipt.id) },
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

export type InboxPart = { type: "text"; text: string } | { type: "image"; image: OutgoingImage };
/**
 * A claimed receipt sent as the next user turn instead of a wake prompt plus a
 * tool call. `parts` keeps each message's images (with their own labels) next
 * to its text; `text`/`images` is the flat form for providers that take a single
 * text, with image references renumbered across the batch.
 */
export type InboxDelivery = { receiptId: string; parts: InboxPart[]; text: string; images: OutgoingImage[]; display: string; previews: string[] };
export function inboxDelivery(receipt: QueueReceipt): InboxDelivery {
  const header = inboxReceiptHeader(receipt.id), parts: InboxPart[] = [{ type: "text", text: header }], flat = [header];
  const images: OutgoingImage[] = [];
  receipt.messages.forEach((message, index) => {
    const label = `Mensaje ${index + 1} (${message.id}):`, offset = images.length;
    parts.push({ type: "text", text: label });
    message.images.forEach((image, at) => parts.push({ type: "text", text: imageReference(at) }, { type: "image", image }));
    if (message.text) parts.push({ type: "text", text: message.text });
    // In the flat form "[Imagen 1]" of the second message is a later image of the batch.
    const renumbered = offset ? message.text.replace(/\[Imagen (\d{1,3})\]/g, (match, value: string) =>
      Number(value) >= 1 && Number(value) <= message.images.length ? imageReference(offset + Number(value) - 1) : match) : message.text;
    flat.push(`${label}\n${renumbered}`);
    images.push(...message.images);
  });
  return { receiptId: receipt.id, parts, text: flat.join("\n\n"), images,
    display: receipt.messages.map(message => message.text).filter(Boolean).join("\n\n") || "Mensajes en cola",
    previews: receipt.messages.flatMap(message => message.previews) };
}

/**
 * Inline delivery of the pending queue: the batch is claimed app-side and sent
 * as one user turn. The receipt stays durable until the provider accepts that
 * turn, so a failure or crash replays the same receipt ID instead of losing it;
 * a stale process cannot acknowledge it.
 */
export async function deliverInbox(queue: { read: () => Promise<QueueSnapshot>; ack: (id: string, current?: () => boolean) => Promise<QueueSnapshot> },
  send: (delivery: InboxDelivery) => Promise<boolean>, current: () => boolean, warn: (message: string) => void): Promise<boolean> {
  const receipt = (await queue.read()).receipt;
  if (!receipt?.messages.length) return true;
  if (!current()) return false;
  if (await send(inboxDelivery(receipt)) !== true) return false;
  try { await queue.ack(receipt.id, current); }
  catch (error) { warn(`Los mensajes se entregaron, pero la confirmación de la cola sigue pendiente: ${error instanceof Error ? error.message : String(error)}`); }
  return true;
}
