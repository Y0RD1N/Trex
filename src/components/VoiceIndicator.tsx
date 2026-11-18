/**
 * Micrófono del modo llamada en la barra superior: solo el icono, que cambia según lo
 * que hace trex. En espera respira despacio; cuando te oye, la cápsula se llena con el
 * volumen real de tu voz; mientras entiende o piensa, un trazo recorre el soporte; y
 * cuando habla salen ondas. No se pinta nada si la voz está apagada (su estado por defecto).
 */
import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { levelPercent, voiceIndicator, voiceListening, type VoiceLevel, type VoicePhase, type VoiceStatus } from "../voice";
import { voiceLiveHangup, voiceStatus, VOICE_LEVEL_EVENT, VOICE_STATUS_EVENT } from "../voiceApi";
import { useVoiceCallState } from "../hooks/useVoiceCall";
import "./Voice.css";

/** Alto interior de la cápsula del micrófono, en unidades del dibujo. */
const CAPSULE = 11;

export default function VoiceIndicator() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [level, setLevel] = useState<VoiceLevel | null>(null);
  const call = useVoiceCallState();
  const clip = useId();

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
      listen<VoiceLevel>(VOICE_LEVEL_EVENT, event => setLevel(event.payload)),
    ]);
    return () => { alive = false; void unlisten.then(list => list.forEach(stop => stop())); };
  }, []);

  if (!status || !voiceListening(status)) return null;

  const { kind, label } = voiceIndicator(status.phase, call);
  // La cápsula se llena con tu voz: solo cuando hay alguien hablando o la llamada está abierta.
  const heard = kind === "live" || kind === "dictating" || (kind === "hearing" && level?.voice);
  const fill = heard && level && !level.deaf ? levelPercent(level.peak) / 100 : 0;
  const onClick = kind === "live" ? () => void voiceLiveHangup().catch(() => undefined)
    : kind === "speaking" ? () => void invoke("voice_hush").catch(() => undefined)
    : undefined;

  return <button type="button" className={`window-btn voice-mic tip tip-below is-${kind}`} data-tip={label} aria-label={`Voz de trex: ${label}`}
    aria-disabled={!onClick || undefined} onClick={onClick}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <defs><clipPath id={clip}><rect x="9" y="3" width="6" height={CAPSULE} rx="3" /></clipPath></defs>
      <g clipPath={`url(#${clip})`}><rect className="voice-mic-level" x="9" y="3" width="6" height={CAPSULE} stroke="none" fill="currentColor" style={{ transform: `scaleY(${fill})` }} /></g>
      <rect className="voice-mic-capsule" x="9" y="3" width="6" height={CAPSULE} rx="3" />
      <path className="voice-mic-cradle" d="M5.5 11.5a6.5 6.5 0 0 0 13 0" pathLength={100} />
      <path className="voice-mic-stand" d="M12 18v3M8.5 21h7" />
      <path className="voice-mic-wave voice-mic-wave-1" d="M18.4 6.2a4 4 0 0 1 0 4.6" />
      <path className="voice-mic-wave voice-mic-wave-2" d="M20.8 4.4a7 7 0 0 1 0 8.2" />
    </svg>
  </button>;
}
