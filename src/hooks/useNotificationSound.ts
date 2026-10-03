import { useCallback, useEffect, useRef } from "react";

/** Un solo contexto de audio; se habilita con la primera interacción real. */
export function useNotificationSound(enabled: boolean) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const contextRef = useRef<AudioContext | null>(null);
  const lastSoundRef = useRef(-Infinity);
  const aliveRef = useRef(true);

  const prepare = useCallback(async (): Promise<AudioContext | null> => {
    try {
      if (!aliveRef.current) return null;
      const context = contextRef.current ?? (contextRef.current = new AudioContext());
      if (context.state === "suspended") await context.resume();
      return aliveRef.current && context.state === "running" ? context : null;
    } catch { return null; }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const unlock = (): void => { void prepare(); };
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });
    document.addEventListener("keydown", unlock, { once: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }, [enabled, prepare]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const context = contextRef.current;
      contextRef.current = null;
      void context?.close().catch(() => {});
    };
  }, []);

  return useCallback(async (): Promise<void> => {
    // Agrupa tareas que terminan a la vez en un solo aviso sonoro.
    if (!enabledRef.current || performance.now() - lastSoundRef.current < 1000) return;
    lastSoundRef.current = performance.now();
    const context = await prepare();
    if (!context || !enabledRef.current || !aliveRef.current) return;
    for (const [delay, frequency] of [[0, 660], [.14, 880]]) {
      const tone = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + delay;
      tone.type = "sine";
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.085, start + .015);
      gain.gain.exponentialRampToValueAtTime(.001, start + .23);
      gain.gain.linearRampToValueAtTime(0, start + .25);
      tone.connect(gain);
      gain.connect(context.destination);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      tone.start(start);
      tone.stop(start + .26);
    }
  }, [prepare]);
}
