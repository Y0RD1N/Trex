import { CloseIcon, ListIcon } from "../Icons";
import type { ChatMessageQueue } from "../../hooks/useMessageQueue";

export default function QueuedMessages({ queue, running, busy, onRemove, onContinue }: {
  queue: ChatMessageQueue; running: boolean; busy: boolean; onRemove: (id: string) => void; onContinue: () => void;
}) {
  const { messages, receipt } = queue.snapshot;
  const claimed = receipt?.messages ?? [];
  if (!messages.length && !claimed.length && !queue.error) return null;
  return <section className="chat-queue" aria-label="Mensajes en cola">
    <div className="chat-queue-head">
      <ListIcon size={14} /><strong>En cola · {messages.length + claimed.length}</strong>
      <span>{running ? "El agente decide cuándo leerlos" : "Pendientes de lectura"}</span>
      {!running && (messages.length > 0 || claimed.length > 0) && <button type="button" className="chat-queue-continue" disabled={busy || !queue.ready}
        onClick={onContinue}>Continuar con la cola</button>}
    </div>
    {queue.error && <p role="alert">No se pudo cargar la cola: {queue.error} <button type="button" className="chat-queue-continue"
      onClick={() => { void queue.reload().catch(() => undefined); }}>Reintentar</button></p>}
    <ol className="chat-queue-list">
      {[...claimed, ...messages].map((message, index) => <li key={message.id}>
        <span className="chat-queue-number" aria-hidden="true">{index + 1}</span>
        <div className="chat-queue-message">
          <p title={message.text}>{message.text || "Imágenes adjuntas"}</p>
          {message.previews.length > 0 && <span className="chat-queue-images">{message.previews.map((preview, position) =>
            <img key={position} src={preview} alt={`Imagen ${position + 1} del mensaje ${index + 1}`} />)}</span>}
        </div>
        {index < claimed.length ? <small>Entregando…</small> : <button type="button" className="chat-copy tip"
          disabled={busy} aria-label={`Cancelar mensaje en cola ${index + 1}`} data-tip="Cancelar mensaje en cola" onClick={() => onRemove(message.id)}>
          <CloseIcon size={13} /></button>}
      </li>)}
    </ol>
  </section>;
}
