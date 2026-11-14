/**
 * Dictado por voz en el campo de texto de un chat.
 *
 * Solo se dicta en un chat a la vez: el destino actual es compartido, así el botón de
 * los demás chats se ve apagado y empezar en otro mueve el dictado allí. El audio se
 * transcribe en este equipo (`src-tauri/src/voice.rs`); aquí solo llega el texto.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatError } from "../api";
import type { VoiceDictated, VoicePhase } from "../voice";
import { VOICE_DICTATION_EVENT, VOICE_STATUS_EVENT, voiceDictationStart, voiceDictationStop } from "../voiceApi";

let target: string | null = null;
const listeners = new Set<() => void>();
function setTarget(next: string | null): void {
  if (target === next) return;
  target = next;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

let watching = false;
/** Si el motor de voz se apaga (error del micrófono, voz desactivada), el dictado termina. */
function watchEngine(): void {
  if (watching || !isTauri()) return;
  watching = true;
  void listen<{ phase?: VoicePhase }>(VOICE_STATUS_EVENT, event => { if (event.payload?.phase === "off") setTarget(null); }).catch(() => undefined);
}

export type Dictation = {
  /** Este chat es el que está recibiendo el dictado. */
  active: boolean;
  /** Arrancando el micrófono. */
  starting: boolean;
  error: string | null;
  toggle: () => void;
  stop: () => void;
};

export function useDictation(sessionId: string, onText: (text: string) => void): Dictation {
  const current = useSyncExternalStore(subscribe, () => target);
  const active = current === sessionId;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(onText);
  latest.current = onText;

  useEffect(() => {
    if (!isTauri()) return;
    watchEngine();
    const unlisten = listen<VoiceDictated>(VOICE_DICTATION_EVENT, event => {
      if (event.payload.target === sessionId && target === sessionId) latest.current(event.payload.text);
    });
    return () => { void unlisten.then(stop => stop()); };
  }, [sessionId]);

  const stop = useCallback(() => {
    if (target !== sessionId) return;
    setTarget(null);
    void voiceDictationStop().catch(() => undefined);
  }, [sessionId]);

  const toggle = useCallback(() => {
    if (target === sessionId) { stop(); return; }
    setError(null);
    setStarting(true);
    voiceDictationStart(sessionId)
      .then(() => setTarget(sessionId), failure => setError(formatError(failure)))
      .finally(() => setStarting(false));
  }, [sessionId, stop]);

  // Al cerrar el chat, su dictado termina con él.
  useEffect(() => stop, [stop]);

  // El aviso de un fallo se retira solo.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  return { active, starting, error, toggle, stop };
}
