/**
 * Esfera de voz: cómo se mueve según lo que cuenta el motor (ver `src-tauri/src/voice_orb.rs`).
 *
 * Rust manda unos 30 fotogramas de datos por segundo: qué hace trex (escucha, piensa,
 * habla o se despide) y los picos del micrófono y de su voz. Aquí se suavizan a la
 * frecuencia de la pantalla y se convierten en los valores que dibuja `renderer.ts`.
 * Sin DOM ni WebGL, para poder probarlo.
 *
 * Con movimiento reducido no gira ni ondula nada: la esfera aparece y se va con un
 * fundido y la voz solo cambia el brillo del núcleo.
 */

export type OrbMood = "listening" | "thinking" | "speaking" | "closing";
export type OrbFrame = { mood: OrbMood; mic: number; voice: number };

export type OrbUniforms = {
  time: number;
  /** 0 → partículas dispersas, 1 → esfera formada. */
  gather: number;
  /** 0 → formada, 1 → colapsada en el núcleo. */
  collapse: number;
  think: number;
  speak: number;
  level: number;
  /** Destello del despertar. */
  flash: number;
  alpha: number;
  spark: number;
  /** 0 con movimiento reducido: la corteza no ondula. */
  ripple: number;
  energy: number;
  phase: [number, number, number];
  wave: Float32Array;
};

const TAU = Math.PI * 2;
/** Lo que dura cada transición, en segundos. */
export const WAKE_SECONDS = 0.95;
export const CLOSE_SECONDS = 0.6;
const FADE_SECONDS = 0.25;

/** Pico de 0 a 1 → nivel visual. La voz normal ronda picos de 0,05–0,4; la raíz los reparte mejor. */
export const levelOf = (peak: number): number => Math.min(1, Math.sqrt(Math.max(0, peak)) * 0.85);

const follow = (current: number, target: number, dt: number, rise: number, fall: number): number =>
  current + (target - current) * (1 - Math.exp(-dt / (target > current ? rise : fall)));

export class OrbAnimation {
  /** Hay algo que dibujar: desde que aparece hasta que termina de despedirse. */
  visible = false;
  reduced = false;
  private mood: OrbMood = "listening";
  private time = 0;
  private wakeT = 0;
  private gather = 1;
  private collapse = 0;
  private think = 0;
  private speak = 0;
  private flash = 0;
  private alpha = 1;
  private mic = 0;
  private voice = 0;
  private micTarget = 0;
  private voiceTarget = 0;
  private waveT = 0;
  private readonly phase: [number, number, number] = [0, 0, 0];
  private readonly wave = new Float32Array(64);

  /** Aparece: con el despertar entero, o con un fundido si hay que reducir el movimiento. */
  show(reduced: boolean): void {
    this.visible = true;
    this.reduced = reduced;
    this.mood = "listening";
    this.wakeT = 0;
    this.collapse = 0;
    this.gather = reduced ? 1 : 0;
    this.alpha = reduced ? 0 : 1;
    this.flash = reduced ? 0 : 1;
    this.think = this.speak = this.mic = this.voice = this.micTarget = this.voiceTarget = 0;
    this.wave.fill(0);
  }

  frame(frame: OrbFrame): void {
    if (!this.visible) return;
    this.mood = frame.mood;
    this.micTarget = levelOf(frame.mic);
    this.voiceTarget = levelOf(frame.voice);
  }

  /** Avanza `dt` segundos. Devuelve `false` cuando ya no queda nada que dibujar. */
  step(dt: number): boolean {
    if (!this.visible) return false;
    const reduced = this.reduced;
    if (!reduced) this.time += dt;
    const mood = this.mood;
    this.think = follow(this.think, mood === "thinking" ? 1 : 0, dt, 0.28, 0.28);
    this.speak = follow(this.speak, mood === "speaking" ? 1 : 0, dt, 0.22, 0.22);
    // Escuchando sigue tu micrófono; hablando, la voz de trex; pensando, nada.
    this.mic = follow(this.mic, mood === "listening" ? this.micTarget : 0, dt, 0.045, 0.16);
    this.voice = follow(this.voice, mood === "speaking" ? this.voiceTarget : 0, dt, 0.045, 0.16);
    this.waveT += dt;
    while (this.waveT >= 1 / 30) {
      this.waveT -= 1 / 30;
      this.wave.copyWithin(1, 0, 63);
      this.wave[0] = this.voice;
    }
    if (reduced) this.wave.fill(this.voice * 0.3);
    else {
      const level = Math.max(this.mic, this.voice);
      this.phase[0] += dt * (1 + 2.6 * this.think);
      this.phase[1] += dt * this.think;
      this.phase[2] += dt * (1.1 + 2.6 * this.think + 1.4 * level);
    }
    this.flash *= Math.exp(-dt / 0.35);
    this.wakeT += dt;
    if (reduced) {
      this.gather = 1;
      this.alpha = mood === "closing" ? Math.max(0, this.alpha - dt / FADE_SECONDS) : Math.min(1, this.alpha + dt / FADE_SECONDS);
      if (mood === "closing" && this.alpha <= 0) this.visible = false;
    } else {
      this.gather = Math.min(1, this.gather + dt / WAKE_SECONDS);
      if (mood === "closing") {
        this.collapse = Math.min(1, this.collapse + dt / CLOSE_SECONDS);
        if (this.collapse >= 1) this.visible = false;
      }
    }
    return this.visible;
  }

  uniforms(): OrbUniforms {
    const level = Math.max(this.mic, this.voice);
    const reduced = this.reduced;
    const energy = reduced
      ? 0.82 + level * 0.7
      : 0.78 + level * 0.9 + this.think * 0.22 * (0.5 + 0.5 * Math.sin(this.time * TAU * 1.15)) + this.flash * 1.4;
    return {
      time: this.time,
      gather: this.gather,
      collapse: this.collapse,
      think: this.think,
      speak: this.speak,
      level,
      flash: this.flash,
      alpha: this.alpha,
      spark: reduced ? 0 : this.speak * this.voice * 1.8 + this.flash * 1.5 + this.think * 0.12,
      ripple: reduced ? 0 : 1,
      energy,
      phase: [...this.phase] as [number, number, number],
      wave: this.wave,
    };
  }
}
