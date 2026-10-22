import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EMPTY_QUEUE, MessageQueue, type QueuedMessage, type QueueSnapshot } from "../messageQueue";

export function useMessageQueue(queueId: string) {
  const [snapshot, setSnapshot] = useState(EMPTY_QUEUE);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const queueRef = useRef<MessageQueue | null>(null);
  if (!queueRef.current) {
    const call = (command: string, args = {}) => invoke<QueueSnapshot>(`message_queue_${command}`, { queueId, ...args });
    queueRef.current = new MessageQueue({
      list: () => call("list"), enqueue: message => call("enqueue", { message }),
      remove: messageId => call("remove", { messageId }), read: () => call("read"),
      ack: receiptId => call("ack", { receiptId }),
    }, value => { if (mounted.current) { setSnapshot(value); setReady(true); setError(null); } });
  }
  const client = queueRef.current;
  useEffect(() => {
    mounted.current = true;
    void client.load().catch(reason => { if (mounted.current) setError(String(reason)); });
    return () => { mounted.current = false; };
  }, [client]);
  return { snapshot, ready, error, client,
    reload: () => client.load().catch(reason => { if (mounted.current) setError(String(reason)); throw reason; }),
    enqueue: (text: string, images: QueuedMessage["images"], previews: string[]) => client.enqueue({ id: crypto.randomUUID(), text, images, previews, createdAt: Date.now() }) };
}

export type ChatMessageQueue = ReturnType<typeof useMessageQueue>;
