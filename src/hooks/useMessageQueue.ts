import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
      update: (messageId, text, expectedText) => call("update", { messageId, text, expectedText }),
      claimDirect: (messageId, expected) => call("claim_direct", { messageId, expected }),
      ackDirect: dispatchId => call("ack_direct", { dispatchId }),
      restoreDirect: dispatchId => call("restore_direct", { dispatchId }),
    }, value => { if (mounted.current) { setSnapshot(value); setReady(true); setError(null); } });
  }
  const client = queueRef.current;
  useEffect(() => {
    mounted.current = true;
    void client.load().catch(reason => { if (mounted.current) setError(String(reason)); });
    return () => { mounted.current = false; };
  }, [client]);
  const reload = useCallback(() => client.load().catch(reason => { if (mounted.current) setError(String(reason)); throw reason; }), [client]);
  const enqueue = useCallback((text: string, images: QueuedMessage["images"], previews: string[]) =>
    client.enqueue({ id: crypto.randomUUID(), text, images, previews, createdAt: Date.now() }), [client]);
  // Misma identidad mientras la cola no cambie: el panel de la cola está memorizado.
  return useMemo(() => ({ snapshot, ready, error, client, reload, enqueue }), [snapshot, ready, error, client, reload, enqueue]);
}

export type ChatMessageQueue = ReturnType<typeof useMessageQueue>;
