/**
 * Reloj común de los indicadores de actividad (el loader de estratos y los iconos de agente).
 *
 * Rendimiento: cada indicador avanza a saltos (ver `--loader-motion` y `.agent-icon` en styles.css),
 * pero cada animación CSS empieza cuando aparece su elemento, así que dos loaders y dos iconos
 * desfasados pedían ~28 fotogramas por segundo; cada fotograma lo pinta el proceso web y lo presenta
 * la ventana. Aquí se ponen todos en fase sobre el reloj del documento (los pasos caen en la misma
 * rejilla de 100 ms) y, con la ventana sin foco, van a un cuarto de velocidad: siguen vivos para
 * quien mira de reojo, con la cuarta parte de fotogramas.
 *
 * Solo toca las animaciones con estos nombres; el resto de la interfaz no cambia.
 */
const INDICATORS = new Set(["trex-loader", "trex-agent-turn", "trex-agent-breathe"]);
const BLURRED_RATE = 0.25;

type Indicator = Animation & { animationName?: string };

const isIndicator = (animation: Animation): animation is Indicator =>
  INDICATORS.has((animation as Indicator).animationName ?? "");

function align(): void {
  const rate = document.hasFocus() ? 1 : BLURRED_RATE;
  for (const animation of document.getAnimations()) {
    if (!isIndicator(animation)) continue;
    // Mismo origen y misma velocidad: todas comparten fase y sus pasos caen a la vez.
    if (animation.playbackRate !== rate) animation.playbackRate = rate;
    if (animation.startTime !== 0) animation.startTime = 0;
  }
}

let installed = false;
export function installActivityMotion(): void {
  if (installed || typeof document === "undefined" || typeof document.getAnimations !== "function") return;
  installed = true;
  // Un indicador nuevo (o uno que reaparece) entra en fase con los demás.
  document.addEventListener("animationstart", event => {
    if (INDICATORS.has(event.animationName)) align();
  }, true);
  window.addEventListener("focus", align);
  window.addEventListener("blur", align);
}
