/**
 * Indicador del modo llamada: una etiqueta en la esquina mientras trex escucha.
 * No se pinta nada si la voz está apagada (su estado por defecto).
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { heardLabel, voiceListening, VOICE_PHASE_LABEL, type VoicePhase, type VoiceStatus, type VoiceUtterance } from "../voice";
import { voiceLiveHangup, voiceStatus, VOICE_STATUS_EVENT, VOICE_UTTERANCE_EVENT } from "../voiceApi";
import { useVoiceCallState } from "../hooks/useVoiceCall";
import { MicIcon } from "./Icons";
import "./Voice.css";

/** Cuánto se queda a la vista lo último que entendió. */
const HEARD_MS = 6000;

export default function VoiceIndicator() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [heard, setHeard] = useState<VoiceUtterance | null>(null);
  const call = useVoiceCallState();

  useEffect(() => {
    let alive = true;
    const refresh = () => void voiceStatus().then(next => { if (alive) setStatus(next); }, () => undefined);
    refresh();
    const unlisten = Promise.all([
      // El evento trae la fase: se aplica al momento y se confirma el resto con una consulta.
      listen<{ phase?: VoicePhase }>(VOICE_STATUS_EVENT, event => {
        const phase = event.payload?.phase;
        if (phase) setStatus(current => current ? { ...current, phase } : current);
        if (phase === "off" || phase === "loading" || phase === "idle") refresh();
      }),
      listen<VoiceUtterance>(VOICE_UTTERANCE_EVENT, event => setHeard(event.payload)),
    ]);
    return () => { alive = false; void unlisten.then(list => list.forEach(stop => stop())); };
  }, []);

  useEffect(() => {
    if (!heard) return;
    const timer = window.setTimeout(() => setHeard(null), HEARD_MS);
    return () => window.clearTimeout(timer);
  }, [heard]);

  if (!status || !voiceListening(status)) return null;

  // Llamada en tiempo real: lo que se va diciendo y un botón para colgar.
  if (call.live) {
    const caption = call.live.said || call.live.heard;
    return <div className="voice-indicator is-live" role="status" aria-live="off">
      <MicIcon size={14} />
      <span className="voice-indicator-bars" aria-hidden="true"><i /><i /><i /></span>
      <span className="voice-indicator-label">{call.live.state === "connecting" ? "Conectando…" : "En llamada"}</span>
      {caption && <span className="voice-indicator-heard">{caption}</span>}
      <button type="button" className="voice-indicator-hangup" onClick={() => void voiceLiveHangup().catch(() => undefined)}>Colgar</button>
    </div>;
  }

  // Mientras Claude prepara la respuesta el micrófono sigue en espera: se dice que está pensando.
  const thinking = call.thinking && status.phase === "idle";
  const detail = call.thinking ? (heard ? heardLabel(heard) : null) : call.reply ?? (heard ? heardLabel(heard) : null);

  return <div className={`voice-indicator is-${thinking ? "thinking" : status.phase}`} role="status" aria-live="polite">
    <MicIcon size={14} />
    <span className="voice-indicator-bars" aria-hidden="true"><i /><i /><i /></span>
    <span className="voice-indicator-label">{thinking ? "Pensando…" : VOICE_PHASE_LABEL[status.phase]}</span>
    {detail && <span className="voice-indicator-heard">{detail}</span>}
  </div>;
}
