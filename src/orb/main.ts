/**
 * Página de la esfera de voz (`orb.html`), en su propia ventana transparente.
 *
 * Rust la enseña con `orb://show` y le manda unos 30 `orb://frame` por segundo mientras
 * dura la conversación (ver `src-tauri/src/voice_orb.rs`). Solo se dibuja entre que
 * aparece y que termina de despedirse: oculta, no hay bucle de animación.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { OrbAnimation, type OrbFrame } from "./animation";
import { createRenderer } from "./renderer";

const canvas = document.getElementById("orb") as HTMLCanvasElement;
const renderer = createRenderer(canvas);
const systemReduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const animation = new OrbAnimation();
/** Con movimiento reducido, como mucho diez dibujos por segundo: no hay nada que mover. */
const REDUCED_FRAME_MS = 100;

let raf = 0;
let last = 0;
let lastDraw = 0;

function resize(): void {
  const side = Math.round(Math.min(window.innerWidth, window.innerHeight) * Math.min(window.devicePixelRatio || 1, 2));
  if (side > 0 && canvas.width !== side) {
    canvas.width = side;
    canvas.height = side;
  }
}

function tick(now: number): void {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
  last = now;
  if (!animation.step(dt)) {
    renderer?.clear();
    raf = 0;
    return;
  }
  raf = requestAnimationFrame(tick);
  if (animation.reduced && now - lastDraw < REDUCED_FRAME_MS) return;
  renderer?.draw(animation.uniforms());
  lastDraw = now;
}

function start(): void {
  if (raf) return;
  last = 0;
  lastDraw = 0;
  raf = requestAnimationFrame(tick);
}

window.addEventListener("resize", resize);
resize();

void Promise.all([
  listen<{ reduced: boolean }>("orb://show", event => {
    resize();
    animation.show(Boolean(event.payload?.reduced) || systemReduced.matches);
    start();
  }),
  listen<OrbFrame>("orb://frame", event => animation.frame(event.payload)),
]).then(() => invoke("voice_orb_ready")).catch(error => console.error(error));
