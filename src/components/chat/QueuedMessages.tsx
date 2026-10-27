import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpIcon, CloseIcon, ListIcon, PencilIcon } from "../Icons";
import type { ChatMessageQueue } from "../../hooks/useMessageQueue";
import type { QueuedMessage } from "../../messageQueue";
import ComposerPanel from "./ComposerPanel";

export type QueuedMessagesProps = {
  queue: ChatMessageQueue;
  running: boolean;
  busy: boolean;
  onRemove: (id: string) => void;
  onContinue: () => void;
  onEdit: (id: string, text: string, expectedText: string) => Promise<void>;
  onSendNow: (message: QueuedMessage) => Promise<void>;
  onRestoreDirect: (dispatchId: string) => Promise<void>;
  directDisabledReason?: (message: QueuedMessage) => string | null;
  compact?: boolean;
  onFocusComposer?: () => void;
};

type EditDraft = { message: QueuedMessage; text: string; expectedText: string; conflict?: string };
type QueueRow = { message: QueuedMessage; state: "pending" | "claimed" | "outbox" | "retained"; dispatchId?: string };

export default function QueuedMessages({ queue, running, busy, onRemove, onContinue, onEdit, onSendNow, onRestoreDirect,
  directDisabledReason, compact = false, onFocusComposer }: QueuedMessagesProps) {
  const { messages, receipt, outbox = [] } = queue.snapshot;
  const claimed = receipt?.messages ?? [];
  const [edits, setEdits] = useState<Record<string, EditDraft>>({});
  const [operations, setOperations] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const operationLocks = useRef(new Set<string>());
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const editFields = useRef(new Map<string, HTMLTextAreaElement>());
  const sectionRef = useRef<HTMLElement>(null);
  const id = useId();

  function conflictFor(messageId: string, draft: EditDraft): string | undefined {
    if (draft.conflict) return draft.conflict;
    if (claimed.some(message => message.id === messageId)) return "El agente ya está leyendo este mensaje.";
    if (outbox.some(dispatch => dispatch.message.id === messageId)) return "Este mensaje pasó a un envío pendiente de confirmar.";
    const current = messages.find(message => message.id === messageId);
    if (!current) return "Este mensaje ya no está en la cola: pudo haberse leído o eliminado.";
    if (current.text !== draft.expectedText) return "El texto del mensaje cambió mientras lo editabas.";
    return undefined;
  }

  // A consumed or changed message must never silently become editable again after a refresh.
  useEffect(() => {
    setEdits(current => {
      let next = current;
      for (const [messageId, draft] of Object.entries(current)) {
        const conflict = conflictFor(messageId, draft);
        if (conflict && !draft.conflict) {
          if (next === current) next = { ...current };
          next[messageId] = { ...draft, conflict };
        }
      }
      return next;
    });
  }, [messages, receipt, queue.snapshot.outbox]);

  async function perform(key: string, label: string, action: () => void | Promise<unknown>, success?: () => void,
    mutation = true) {
    if ((mutation && (busy || !queue.ready)) || operationLocks.current.has(key)) return;
    operationLocks.current.add(key);
    setOperations(current => ({ ...current, [key]: label }));
    setErrors(current => { const next = { ...current }; delete next[key]; return next; });
    try {
      await action();
      success?.();
    } catch (error) {
      setErrors(current => ({ ...current, [key]: String(error instanceof Error ? error.message : error) }));
    } finally {
      operationLocks.current.delete(key);
      setOperations(current => { const next = { ...current }; delete next[key]; return next; });
    }
  }

  function restoreFocus(messageId: string) {
    const composer = sectionRef.current?.closest(".chat-dock")?.querySelector<HTMLTextAreaElement>(".chat-composer:not([hidden]) textarea:not(:disabled)");
    // Capture the composer before a final retained draft removes the queue from the DOM.
    requestAnimationFrame(() => {
      const target = editButtons.current.get(messageId) ?? sectionRef.current ?? composer;
      if (target?.getClientRects().length) target.focus({ preventScroll: true });
      else onFocusComposer?.();
    });
  }

  function closeEdit(messageId: string) {
    if (operationLocks.current.has(`message:${messageId}`)) return;
    setEdits(current => { const next = { ...current }; delete next[messageId]; return next; });
    setErrors(current => { const next = { ...current }; delete next[`message:${messageId}`]; delete next[`copy:${messageId}`]; return next; });
    restoreFocus(messageId);
  }

  const rows: QueueRow[] = [
    ...claimed.map(message => ({ message, state: "claimed" as const })),
    ...messages.map(message => ({ message, state: "pending" as const })),
    ...outbox.map(dispatch => ({ message: dispatch.message, state: "outbox" as const, dispatchId: dispatch.id })),
  ];
  const visibleIds = new Set(rows.map(row => row.message.id));
  for (const draft of Object.values(edits)) {
    if (!visibleIds.has(draft.message.id)) rows.push({ message: draft.message, state: "retained" });
  }
  const available = !!rows.length || !!queue.error || !!Object.keys(errors).length;

  const content = <section ref={sectionRef} tabIndex={-1} className="chat-queue" aria-label="Cola de mensajes pendientes">
    <div className="chat-queue-head">
      <ListIcon size={15} /><strong>Pendientes de lectura · {messages.length}</strong>
      <span>{messages.length > 0
        ? `${claimed.length ? `${claimed.length} en lectura · ` : ""}${running ? "El agente los leerá cuando esté listo" : "Listos para continuar"}`
        : claimed.length ? `${claimed.length} en lectura · esperando confirmación`
          : outbox.length ? "Seguimiento del envío directo" : "Ediciones conservadas"}</span>
      {!running && (messages.length > 0 || claimed.length > 0) && <button type="button" className="chat-queue-continue"
        disabled={busy || !queue.ready || !!operations.continue} title="Continuar el trabajo con los mensajes de la cola"
        onClick={() => { void perform("continue", "Continuando…", onContinue); }}>
        {operations.continue ?? "Continuar con la cola"}</button>}
    </div>
    {queue.error && <p className="chat-queue-error" role="alert">No se pudo cargar la cola: {queue.error}{" "}
      <button type="button" className="chat-queue-continue" disabled={busy || !!operations.reload} title="Volver a cargar la cola"
        onClick={() => { void perform("reload", "Cargando…", queue.reload, undefined, false); }}>
        {operations.reload ?? "Reintentar"}</button></p>}
    {(errors.continue || errors.reload) && <p className="chat-queue-error" role="alert">{errors.continue || errors.reload}</p>}
    <ol className="chat-queue-list">
      {rows.map(({ message, state, dispatchId }, index) => {
        const draft = edits[message.id];
        const conflict = draft ? conflictFor(message.id, draft) : undefined;
        const key = dispatchId ? `dispatch:${dispatchId}` : `message:${message.id}`;
        const messageOperation = operations[`message:${message.id}`];
        const pending = operations[key] ?? messageOperation;
        const sendingDirect = state === "outbox" && messageOperation === "Enviando…";
        const disabled = busy || !queue.ready || !!pending;
        const directReason = state === "pending" ? directDisabledReason?.(message) : null;
        const rowId = `${id}-${message.id}`;
        return <li key={message.id} className={`chat-queue-item is-${state}${draft ? " is-editing" : ""}`} aria-busy={!!pending}>
          <span className="chat-queue-number" aria-hidden="true">{index + 1}</span>
          <div className="chat-queue-message">
            {state === "claimed" && <span className="chat-queue-status">En lectura · esperando confirmación</span>}
            {state === "outbox" && <span className={`chat-queue-status${sendingDirect ? "" : " is-uncertain"}`}>
              {sendingDirect ? "Enviando…" : "Revisa si se envió"}</span>}
            {!draft && <p title={message.text}>{message.text || "Imágenes adjuntas"}</p>}
            {draft && <div className="chat-queue-editor">
              <label htmlFor={`${rowId}-edit`}>{conflict ? "Tu edición conservada" : `Editar mensaje ${index + 1}`}</label>
              <textarea id={`${rowId}-edit`} ref={field => { if (field) editFields.current.set(message.id, field); else editFields.current.delete(message.id); }}
                rows={3} value={draft.text} readOnly={!!conflict || !!pending} aria-describedby={`${rowId}-edit-help`}
                onChange={event => { const text = event.currentTarget.value; setEdits(current => ({ ...current, [message.id]: { ...current[message.id], text } })); }}
                onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); closeEdit(message.id); } }} />
              <div id={`${rowId}-edit-help`} className={`chat-queue-edit-help${conflict ? " is-conflict" : ""}`} role={conflict ? "status" : undefined}>
                {conflict ? `${conflict} Conservamos tu texto en modo de solo lectura. Puedes copiarlo al compositor; no se guardará ni enviará automáticamente.`
                  : "Solo cambia el texto de este mensaje; las imágenes y el borrador del compositor se conservan. Esc cancela."}
              </div>
              <div className="chat-queue-actions">
                {!conflict && <button type="button" className="chat-queue-action is-primary" disabled={disabled || (!draft.text.trim() && message.images.length === 0)}
                  title="Guardar los cambios en la cola" aria-label={`Guardar cambios del mensaje ${index + 1}`}
                  onClick={() => { void perform(key, "Guardando…", () => onEdit(message.id, draft.text, draft.expectedText), () => {
                    setEdits(current => { const next = { ...current }; delete next[message.id]; return next; });
                    setNotice("Mensaje actualizado en la cola.");
                    restoreFocus(message.id);
                  }); }}>{pending ?? "Guardar"}</button>}
                {conflict && <button type="button" className="chat-queue-action" disabled={!!operations[`copy:${message.id}`]}
                  title="Copiar tu edición para pegarla en el compositor" aria-label={`Copiar edición conservada del mensaje ${index + 1}`}
                  onClick={() => { void perform(`copy:${message.id}`, "Copiando…", async () => {
                    try { await navigator.clipboard.writeText(draft.text); setNotice("Edición copiada. Puedes pegarla en el compositor."); }
                    catch { editFields.current.get(message.id)?.select(); throw new Error("No se pudo copiar. El texto está seleccionado; cópialo con el teclado."); }
                  }, undefined, false); }}>Copiar texto</button>}
                <button type="button" className="chat-queue-action" disabled={!!pending} title="Cerrar la edición y volver a la cola (Esc)"
                  aria-label={`Cancelar edición del mensaje ${index + 1}`} onClick={() => closeEdit(message.id)}>
                  {conflict ? "Cerrar edición" : "Cancelar"}</button>
              </div>
            </div>}
            {message.previews.length > 0 && <span className="chat-queue-images" role="group" aria-label={`Imágenes adjuntas al mensaje ${index + 1}`}>
              {message.previews.map((preview, position) => <img key={position} src={preview} alt={`Imagen ${position + 1} del mensaje ${index + 1}`} />)}
            </span>}
            {state === "pending" && !draft && <div className="chat-queue-actions">
              <button type="button" className="chat-queue-action" disabled={disabled} title="Editar este mensaje sin cambiar el borrador del compositor"
                aria-label={`Editar mensaje en cola ${index + 1}`} ref={button => { if (button) editButtons.current.set(message.id, button); else editButtons.current.delete(message.id); }}
                onClick={() => {
                  if (busy || !queue.ready || operationLocks.current.has(key)) return;
                  setEdits(current => ({ ...current, [message.id]: { message, text: message.text, expectedText: message.text } }));
                  requestAnimationFrame(() => editFields.current.get(message.id)?.focus());
                }}><PencilIcon size={12} />Editar</button>
              <button type="button" className="chat-queue-action is-primary" disabled={disabled || !!directReason}
                title={directReason || "Enviar este mensaje ahora sin esperar a que el agente lea la cola"} aria-label={`Enviar ahora mensaje en cola ${index + 1}`}
                aria-describedby={directReason ? `${rowId}-direct-help` : undefined}
                onClick={() => { if (!directReason) void perform(key, "Enviando…", () => onSendNow(message)); }}>
                <ArrowUpIcon size={12} />{pending === "Enviando…" ? pending : "Enviar ahora"}</button>
              <button type="button" className="chat-queue-action chat-queue-remove" disabled={disabled} title="Quitar este mensaje de la cola"
                aria-label={`Quitar mensaje en cola ${index + 1}`} onClick={() => { void perform(key, "Quitando…", () => onRemove(message.id)); }}>
                <CloseIcon size={13} /></button>
            </div>}
            {directReason && <div id={`${rowId}-direct-help`} className="chat-queue-edit-help">{directReason}</div>}
            {state === "outbox" && !sendingDirect && <div className="chat-queue-dispatch">
              <div id={`${rowId}-restore-help`} className="chat-queue-edit-help">El proveedor puede haberlo aceptado. Revisa el historial antes de devolverlo a la cola: podría enviarse dos veces.</div>
              <button type="button" className="chat-queue-action" disabled={disabled} title="Devolver a la cola; existe riesgo de duplicar un mensaje ya aceptado"
                aria-label={`Devolver a la cola mensaje ${index + 1}`} aria-describedby={`${rowId}-restore-help`}
                onClick={() => { if (dispatchId) void perform(key, "Devolviendo…", () => onRestoreDirect(dispatchId), () => {
                  setErrors(current => { const next = { ...current }; delete next[`message:${message.id}`]; return next; });
                }); }}>
                {pending ?? "Devolver a la cola"}</button>
            </div>}
            {(errors[key] || errors[`message:${message.id}`] || errors[`copy:${message.id}`]) && <div className="chat-queue-error" role="alert">{errors[key] || errors[`message:${message.id}`] || errors[`copy:${message.id}`]}</div>}
          </div>
        </li>;
      })}
    </ol>
    <div className="chat-queue-announcement" role="status" aria-live="polite">{notice}</div>
  </section>;
  return compact ? <ComposerPanel label="Cola" title="Mensajes pendientes" icon={<ListIcon size={13} />}
    count={rows.length || "!"} visible={available} attention={!!queue.error || !!Object.keys(errors).length}>{content}</ComposerPanel>
    : available ? content : null;
}
