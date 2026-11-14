/** Comandos del modo llamada (ver `src-tauri/src/voice.rs`). */
import { invoke } from "@tauri-apps/api/core";
import type { VoiceCloudVoice, VoiceKeyProvider, VoiceMicrophone, VoiceSettingsPatch, VoiceStatus } from "./voice";

export const voiceStatus = (): Promise<VoiceStatus> => invoke("voice_status");
export const voiceConfigure = (settings: VoiceSettingsPatch): Promise<VoiceStatus> => invoke("voice_configure", { settings });
export const voiceMicrophones = (): Promise<VoiceMicrophone[]> => invoke("voice_microphones");
/** Descarga los modelos (~150 MB). Solo tras un clic explícito. */
export const voiceDownloadModels = (): Promise<VoiceStatus> => invoke("voice_download_models");

/** Guarda cifrada una clave de API. El valor no se puede volver a leer desde la interfaz. */
export const voiceKeySet = (provider: VoiceKeyProvider, key: string): Promise<void> => invoke("voice_key_set", { provider, key });
export const voiceKeyClear = (provider: VoiceKeyProvider): Promise<void> => invoke("voice_key_clear", { provider });
/** Voces de la cuenta de ElevenLabs de la persona. */
export const voiceCloudVoices = (): Promise<VoiceCloudVoice[]> => invoke("voice_cloud_voices");

/** Devuelve a Gemini el resultado de una herramienta que pidió. */
export const voiceLiveToolResult = (id: string, result: unknown): Promise<void> => invoke("voice_live_tool_result", { id, result });
/** Cuelga la llamada en tiempo real. */
export const voiceLiveHangup = (): Promise<void> => invoke("voice_live_hangup");

export const VOICE_STATUS_EVENT = "voice://status";
export const VOICE_UTTERANCE_EVENT = "voice://utterance";
export const VOICE_LEVEL_EVENT = "voice://level";
export const VOICE_LIVE_EVENT = "voice://live";
export const VOICE_TOOL_EVENT = "voice://tool";
