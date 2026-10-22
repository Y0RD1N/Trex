import { useCallback, useEffect, useRef, useState } from "react";
import { formatError, loadHandoff } from "../api";
import { buildHandoffPrompt, handoffAlreadySent, type HandoffReference, type PreparedHandoff } from "../handoff";
import type { ChatSession } from "./chatSession";

/** La entrega pendiente sobrevive al reinicio; una conversación restaurada nunca se reenvía a ciegas. */
export function useHandoffDelivery({ reference, session, visible, conversationId, requireReview = false, onConsumed }: {
  reference?: HandoffReference | null;
  session: ChatSession;
  visible: boolean;
  conversationId: string | null;
  requireReview?: boolean;
  onConsumed: (id: string) => void;
}) {
  const [prepared, setPrepared] = useState<PreparedHandoff | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const restored = useRef(requireReview || conversationId !== null);
  const attempted = useRef<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ reference, session, onConsumed });
  latest.current = { reference, session, onConsumed };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!reference?.pending || !visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadHandoff(reference.id).then(value => {
      if (!cancelled) setPrepared(value);
    }).catch(reason => {
      if (!cancelled) setError(`No se pudo recuperar el contexto: ${formatError(reason)}`);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reference?.id, reference?.pending, visible, revision]);

  const deliver = useCallback(async (): Promise<void> => {
    const current = latest.current;
    if (!current.reference?.pending || !prepared || prepared.id !== current.reference.id
      || inFlight.current || current.session.state.pendingTurns > 0) return;
    inFlight.current = true;
    attempted.current = current.reference.id;
    setSending(true);
    setError(null);
    try {
      const accepted = await current.session.send(buildHandoffPrompt(prepared, current.reference.instruction ?? ""), [], []);
      if (accepted === false) throw new Error("El asistente no recibió el contexto. Puedes reintentar cuando esté disponible.");
      current.onConsumed(current.reference.id);
    } catch (reason) {
      if (mounted.current) setError(formatError(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  }, [prepared]);

  useEffect(() => {
    if (!reference?.pending || !visible || inFlight.current) return;
    const history = session.state.items.slice(0, session.state.historyCount);
    if (handoffAlreadySent(history, reference.id)) {
      onConsumed(reference.id);
      return;
    }
    // Al restaurar una sesión el historial puede fallar o estar recortado: se
    // ofrece un envío manual en vez de arriesgar una segunda ejecución.
    if (!restored.current && prepared?.id === reference.id && !loading && !error
      && session.state.process === "ready" && session.state.pendingTurns === 0 && attempted.current !== reference.id) {
      void deliver();
    }
  }, [reference, visible, prepared, loading, error, session.state.process,
    session.state.pendingTurns, session.state.items, session.state.historyCount, onConsumed, deliver]);

  return {
    prepared, loading, sending, error, requiresReview: restored.current,
    retry: (): void => { if (prepared?.id === reference?.id) void deliver(); else setRevision(value => value + 1); },
  };
}
