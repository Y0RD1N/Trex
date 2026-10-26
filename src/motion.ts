/** Espera la salida real de una capa, sin sincronizar los componentes con el CSS. */
type MotionStyle = Pick<CSSStyleDeclaration,
  "transitionDuration" | "transitionDelay" | "animationDuration" | "animationDelay" | "animationIterationCount">;

/** WebKit can throttle a second frame even while a native window is visible. */
export function enterAfterPaint(complete: () => void, fallbackMs = 100): () => void {
  let active = true;
  let frame: number | undefined;
  const finish = (): void => {
    if (!active) return;
    active = false;
    window.clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    complete();
  };
  const timer = window.setTimeout(finish, fallbackMs);
  frame = requestAnimationFrame(() => {
    if (active) frame = requestAnimationFrame(finish);
  });
  return () => {
    active = false;
    window.clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}

const times = (value: string): number[] => value.split(",").map(part => {
  const time = Number.parseFloat(part);
  return Number.isFinite(time) ? time * (part.trim().endsWith("ms") ? 1 : 1000) : 0;
});

/** Respaldo para motores que no exponen sus transiciones a Web Animations. */
export function motionDuration(style: MotionStyle): number {
  const duration = times(style.transitionDuration);
  const delay = times(style.transitionDelay);
  let longest = Math.max(0, ...duration.map((time, index) => time + (delay[index % delay.length] ?? 0)));
  const animationDuration = times(style.animationDuration);
  const animationDelay = times(style.animationDelay);
  const iterations = style.animationIterationCount.split(",").map(value => value.trim() === "infinite" ? Infinity : Number(value));
  animationDuration.forEach((time, index) => {
    const count = iterations[index % iterations.length] ?? 1;
    if (Number.isFinite(count)) longest = Math.max(longest, time * count + (animationDelay[index % animationDelay.length] ?? 0));
  });
  return longest;
}

/**
 * Solo espera el contenedor y las láminas marcadas data-motion-surface: un
 * indicador, cursor o control animado dentro de una capa no debe retenerla.
 * La cancelación deja las animaciones intactas para poder invertir la salida.
 */
export function waitForMotion(element: HTMLElement | null, complete: () => void, fallbackMs = 160): () => void {
  let active = true;
  let timer: number | undefined;
  const finish = (): void => {
    if (!active) return;
    active = false;
    window.clearTimeout(timer);
    complete();
  };
  const cancel = (): void => { active = false; window.clearTimeout(timer); };
  if (!element) {
    timer = window.setTimeout(finish, fallbackMs);
    return cancel;
  }

  const surfaces = [element, ...Array.from(element.querySelectorAll<HTMLElement>("[data-motion-surface]"))];
  try {
    // getAnimations fuerza el cálculo del estilo tras aplicar la clase leaving.
    const animations = element.getAnimations({ subtree: true }).filter(animation => {
      const effect = animation.effect as KeyframeEffect | null;
      if (!effect || !surfaces.includes(effect.target as HTMLElement)
        || animation.playState === "finished" || animation.playState === "idle" || animation.playState === "paused") return false;
      return Number.isFinite(effect.getComputedTiming().endTime);
    });
    if (!animations.length) { finish(); return cancel; }
    let longest = 0;
    for (const animation of animations) {
      const end = Number(animation.effect!.getComputedTiming().endTime);
      const current = typeof animation.currentTime === "number" ? animation.currentTime : 0;
      const remaining = animation.playbackRate < 0 ? current : end - current;
      longest = Math.max(longest, remaining / (Math.abs(animation.playbackRate) || 1));
    }
    // Respaldo para WebViews que pierden finished al cambiar de ventana.
    timer = window.setTimeout(finish, Math.max(0, longest) + 64);
    void Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
  } catch {
    const duration = Math.max(0, ...surfaces.map(surface => motionDuration(getComputedStyle(surface))));
    if (duration === 0) finish();
    else timer = window.setTimeout(finish, duration + 64);
  }
  return cancel;
}
