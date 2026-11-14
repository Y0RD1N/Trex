/** Modo llamada: tipos y textos del estado de la voz (ver `src-tauri/src/voice.rs`). Sin Tauri, para poder probarlo. */

export type VoicePhase = "off" | "loading" | "idle" | "hearing" | "transcribing" | "speaking" | "live";

/** Quién conversa: lo local (Whisper + Claude, sin costo) o Gemini Live (de pago). */
export type VoiceMode = "local" | "live";
/** Voz de las respuestas en el modo local. */
export type VoiceSpeech = "local" | "elevenlabs";
export type VoiceKeyProvider = "gemini" | "elevenlabs";
export type VoiceCloudVoice = { id: string; name: string; detail: string };

export type VoiceStatus = {
  /** `false` en los sistemas donde el modo llamada aún no existe. */
  supported: boolean;
  enabled: boolean;
  rawCapture: boolean;
  /** Micrófono elegido (su id en el sistema); vacío = el predeterminado. */
  device: string;
  mode: VoiceMode;
  liveVoice: string;
  /** Voces de Gemini que se pueden elegir. */
  liveVoices: string[];
  /** En tiempo real, dejar que la persona interrumpa a trex (requiere auriculares). */
  bargeIn: boolean;
  speech: VoiceSpeech;
  cloudVoice: string;
  /** Hay clave guardada; su valor nunca llega aquí. */
  hasGeminiKey: boolean;
  hasCloudKey: boolean;
  /** Por qué la voz de nube no sonó la última vez (se usó la local). */
  speechError: string | null;
  phase: VoicePhase;
  error: string | null;
  modelsInstalled: boolean;
  /** La voz neuronal de trex está instalada; si no, habla con la de Windows. */
  speechInstalled: boolean;
  downloading: boolean;
  downloadedBytes: number;
  totalBytes: number;
};

export type VoiceMicrophone = { id: string; name: string; isDefault: boolean };

/** Lo que capta el micrófono ahora mismo, unas cuatro veces por segundo. */
export type VoiceLevel = { peak: number; voice: boolean; deaf: boolean };

/** Opciones del selector de micrófono: primero «el del sistema», luego los conectados. */
export function microphoneOptions(list: VoiceMicrophone[], chosen: string): { value: string; label: string; description?: string }[] {
  const system = list.find(mic => mic.isDefault);
  const options = [
    { value: "", label: "Predeterminado del sistema", description: system ? system.name : undefined },
    ...list.map(mic => ({ value: mic.id, label: mic.name })),
  ];
  // Un micrófono elegido que ya no está conectado sigue a la vista: trex usa el del sistema mientras tanto.
  if (chosen && !list.some(mic => mic.id === chosen)) options.push({ value: chosen, label: "Micrófono no conectado", description: "Se usa el predeterminado hasta que vuelva" });
  return options;
}

/** Opciones del selector de voz de ElevenLabs; la voz elegida sigue a la vista aunque no se haya cargado la lista. */
export function cloudVoiceOptions(list: VoiceCloudVoice[], chosen: string): { value: string; label: string; description?: string }[] {
  const options = list.map(voice => ({ value: voice.id, label: voice.name, description: voice.detail || undefined }));
  if (chosen && !list.some(voice => voice.id === chosen)) options.unshift({ value: chosen, label: "Voz elegida", description: "Carga las voces para ver su nombre" });
  return options;
}

/** Altura del medidor, de 0 a 100. La escala no es lineal: la voz normal ronda el 10–30 % del máximo. */
export const levelPercent = (peak: number): number => Math.round(Math.sqrt(Math.max(0, Math.min(1, peak))) * 100);

/** Una frase dirigida a trex: llegó con "oye trex" o dentro de la ventana de conversación. */
export type VoiceUtterance = { text: string; command: string; wake: boolean; at: number };

export const VOICE_PHASE_LABEL: Record<VoicePhase, string> = {
  off: "Apagado",
  loading: "Preparando…",
  idle: "En espera",
  hearing: "Te oigo…",
  transcribing: "Entendiendo…",
  speaking: "Hablando",
  live: "En llamada",
};

/** Lo que se guarda al aplicar un cambio en Ajustes: todo menos el estado. */
export type VoiceSettingsPatch = Pick<VoiceStatus, "enabled" | "rawCapture" | "device" | "mode" | "liveVoice" | "bargeIn" | "speech" | "cloudVoice">;

export const voiceSettingsOf = (status: VoiceStatus): VoiceSettingsPatch => ({
  enabled: status.enabled, rawCapture: status.rawCapture, device: status.device, mode: status.mode,
  liveVoice: status.liveVoice, bargeIn: status.bargeIn, speech: status.speech, cloudVoice: status.cloudVoice,
});

/** Qué le falta a cada opción de pago para funcionar, en una frase; null si está lista. */
export function voiceModeBlocker(status: Pick<VoiceStatus, "mode" | "hasGeminiKey">): string | null {
  return status.mode === "live" && !status.hasGeminiKey ? "Falta tu clave de Gemini: hasta que la guardes, trex responde en modo local." : null;
}

export function voiceSpeechBlocker(status: Pick<VoiceStatus, "speech" | "hasCloudKey" | "cloudVoice" | "speechError">): string | null {
  if (status.speech !== "elevenlabs") return null;
  if (!status.hasCloudKey) return "Falta tu clave de ElevenLabs: hasta que la guardes, trex usa la voz local.";
  if (!status.cloudVoice) return "Elige una voz de ElevenLabs; mientras tanto trex usa la voz local.";
  return status.speechError ? `${status.speechError} Se usó la voz local.` : null;
}

/** El estado en una palabra para la cabecera de Ajustes. */
export function voiceStateLabel(status: VoiceStatus): string {
  if (!status.supported) return "No disponible";
  if (!status.enabled) return "Apagado";
  if (status.downloading) return "Descargando";
  if (!status.modelsInstalled) return "Faltan modelos";
  if (status.phase === "off") return status.error ? "Con error" : "Arrancando…";
  return status.phase === "loading" ? "Preparando…" : "Escuchando";
}

/** `true` cuando el micrófono está abierto y trex atiende. */
export const voiceListening = (status: VoiceStatus): boolean =>
  status.enabled && status.phase !== "off" && status.phase !== "loading";

export function downloadPercent(status: Pick<VoiceStatus, "downloadedBytes" | "totalBytes">): number {
  if (status.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100)));
}

/** Qué ofrece la tarjeta de modelos de Ajustes: nada, todo, o solo la voz de trex. */
export function voiceDownloadOffer(status: Pick<VoiceStatus, "modelsInstalled" | "speechInstalled">): "none" | "all" | "speech" {
  if (!status.modelsInstalled) return "all";
  return status.speechInstalled ? "none" : "speech";
}

export const megabytes =(bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Lo que se muestra de una frase: la orden, o un aviso si solo se dijo el nombre. */
export const heardLabel = (utterance: VoiceUtterance): string => utterance.command.trim() || "(solo te llamó)";

/** Añade una frase al historial corto que se enseña en Ajustes, la más reciente primero. */
export function pushHeard(list: VoiceUtterance[], utterance: VoiceUtterance, max = 6): VoiceUtterance[] {
  return [utterance, ...list].slice(0, max);
}
