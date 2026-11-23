/**
 * Esfera de voz: el dibujo, en WebGL2 y sin librerías.
 *
 * Unos 9.900 puntos con mezcla aditiva y un cuadro para el núcleo:
 * - una lente ahumada detrás, para que se lea sobre ventanas claras;
 * - el núcleo incandescente con su halo;
 * - la corteza (partículas sobre la esfera) y marcas de circuito que parpadean;
 * - siete anillos inclinados con trazos discontinuos y un remolino en el centro;
 * - arcos de instrumento en el plano de la pantalla;
 * - chispas en los picos de voz y el anillo del ecuador con la onda de la voz de trex.
 *
 * Todo el movimiento lo calcula la GPU a partir de los valores de `animation.ts`.
 */
import type { OrbUniforms } from "./animation";

/** Ámbar: el color propio de la esfera. */
const HOT: [number, number, number] = [1, 0.945, 0.839];
const MAIN: [number, number, number] = [1, 0.698, 0.247];
const DEEP: [number, number, number] = [1, 0.416, 0.075];
/** Radio de la esfera en coordenadas de recorte: deja sitio a los arcos exteriores. */
const SCALE = 1 / 1.9;

const POINTS_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aA;
layout(location = 1) in vec4 aSeed;
layout(location = 2) in float aKind;
uniform float uTime, uScale, uPx, uLevel, uRipple, uGather, uCollapse, uThink, uSpeak, uSpark, uAlpha;
uniform vec3 uPhase;
uniform float uWave[64];
uniform vec3 uHot, uMain, uDeep;
out vec3 vColor; out float vAlpha; out float vHard;
const float TAU = 6.2831853;
const float CAM = 4.2;
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1., 0., 0., 0., c, s, 0., -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0., -s, 0., 1., 0., s, 0., c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0., -s, c, 0., 0., 0., 1.); }
float easeOut(float x) { x = clamp(x, 0., 1.); return 1. - pow(1. - x, 3.); }
void place(vec3 p, float size, vec3 color, float alpha) {
  float k = CAM / (CAM - p.z);
  gl_Position = vec4(p.xy * k * uScale, 0., 1.);
  gl_PointSize = alpha > 0.002 ? max(1.25, size * k * uPx / 380.) : 0.;
  vColor = color;
  vAlpha = alpha * uAlpha;
}
void main() {
  float t = uTime;
  mat3 world = rotX(-0.42) * rotY(t * 0.09);
  int kind = int(aKind + 0.5);
  vColor = vec3(0.); vAlpha = 0.; vHard = 0.5;
  gl_Position = vec4(2., 2., 0., 1.); gl_PointSize = 0.;

  if (kind == 0) {
    // Corteza: partículas sobre la esfera.
    vec3 dir = aA.xyz;
    float side = aSeed.x > 0.5 ? 1. : -1.;
    dir = rotY(uPhase.y * (0.6 + 1.1 * (1. - abs(dir.y))) * side * 0.5) * dir;
    float n = sin(dir.x * 3.1 + t * 1.7) * sin(dir.y * 2.6 - t * 1.3) * sin(dir.z * 2.9 + t * 1.1)
            + 0.5 * sin(dir.x * 6.3 - t * 2.3 + dir.z * 4.1);
    float r = 1. + 0.014 * sin(t * 1.4 + aSeed.y * TAU) + uRipple * uLevel * (0.06 + 0.17 * n) + uSpeak * uLevel * 0.04;
    float g = easeOut((uGather - aSeed.w * 0.45) / 0.55);
    vec3 scatter = normalize(dir + (aSeed.xyz - 0.5) * 1.4) * (2.1 + aSeed.z * 1.6);
    vec3 p = mix(scatter, dir * r, g);
    float c = clamp((uCollapse - aSeed.w * 0.35) / 0.65, 0., 1.);
    p = world * (p * (1. - c * c));
    float depth = clamp((p.z + 1.2) / 2.4, 0., 1.);
    bool hot = aSeed.x > 0.9;
    float tw = 0.65 + 0.35 * sin(t * (1.5 + aSeed.z * 2.5) + aSeed.y * 40.);
    vec3 col = hot ? mix(uMain, uHot, 0.55) : mix(uDeep, uMain, depth);
    float a = (0.18 + 0.82 * depth * depth) * tw * (0.35 + 0.65 * g) * (1. - c) * (0.9 + 0.6 * uLevel);
    place(p, (hot ? 3.4 : 2.1) * (0.6 + 0.6 * depth), col, a);
    vHard = hot ? 0.2 : 0.55;
  } else if (kind == 1) {
    // Anillos inclinados: círculos máximos con trazos discontinuos.
    float th = aA.x; int id = int(aA.y + 0.5);
    float R, speed, count, duty, bright; mat3 tilt;
    if (id == 0) { R = 1.10; tilt = rotZ(0.25) * rotX(1.18); speed = 0.32; count = 3.; duty = 0.72; bright = 0.85; }
    else if (id == 1) { R = 1.19; tilt = rotZ(0.95) * rotX(-0.62); speed = -0.21; count = 26.; duty = 0.58; bright = 0.6; }
    else if (id == 2) { R = 1.28; tilt = rotX(0.32) * rotZ(1.45); speed = 0.13; count = 90.; duty = 0.22; bright = 0.8; }
    else if (id == 3) { R = 0.60; tilt = rotZ(-0.5) * rotX(0.45); speed = 0.55; count = 2.; duty = 0.82; bright = 1.0; }
    else if (id == 4) { R = 0.92; tilt = rotZ(-1.2) * rotX(0.9); speed = -0.4; count = 1.; duty = 0.55; bright = 0.95; }
    else if (id == 5) { R = 1.04; tilt = rotX(-1.35) * rotZ(0.6); speed = 0.26; count = 5.; duty = 0.3; bright = 0.8; }
    else { R = 0.80; tilt = rotZ(2.0) * rotX(-0.3); speed = 0.7; count = 1.; duty = 0.38; bright = 1.0; }
    float f = fract(th / TAU * count + float(id) * 0.37);
    float dash = smoothstep(0., 0.015, f) * smoothstep(duty, duty - 0.015, f);
    float g = easeOut((uGather - 0.15 - float(id) * 0.08) / 0.6);
    float rr = R * (0.2 + 0.8 * g) * (1. + uSpeak * uLevel * 0.06) * (1. - uCollapse * 0.85);
    float a = th + uPhase.x * speed;
    vec3 p = vec3(cos(a), 0., sin(a)) * rr;
    p = world * (rotY(t * 0.05 * float(id + 1)) * tilt * p);
    float depth = clamp((p.z + 1.3) / 2.6, 0., 1.);
    vec3 col = mix(uMain, uHot, 0.25 + 0.35 * uThink);
    float al = dash * bright * (0.25 + 0.75 * depth) * g * (1. - uCollapse) * (0.8 + 0.5 * uThink + 0.6 * uSpeak * uLevel);
    place(p, 2.4 * (0.7 + 0.5 * depth), col, al * 0.75);
  } else if (kind == 2) {
    // Arcos de instrumento en el plano de la pantalla.
    float th = aA.x; int id = int(aA.y + 0.5); float tick = aA.z;
    float R, span, speed, phase, bright;
    if (id == 0) { R = 1.50; span = 0.95 + 0.9 * uThink; speed = 0.22; phase = 0.4; bright = 0.7; }
    else if (id == 1) { R = 1.58; span = 2.3; speed = -0.11; phase = 2.2; bright = 0.45; }
    else if (id == 2) { R = 1.66; span = 0.42 + 0.35 * uThink; speed = 0.55; phase = 4.1; bright = 0.9 + 0.5 * uThink; }
    else { R = 1.73; span = TAU; speed = 0.; phase = 0.; bright = 0.24; }
    float g = easeOut((uGather - 0.35) / 0.65);
    float s = span * g;
    float rel = mod(th - phase - uPhase.x * speed, TAU);
    float vis = id == 3 ? 1. : step(rel, s) * smoothstep(0., 0.06, rel) * smoothstep(s, s - 0.12, rel);
    float rr = (R + tick * 0.045) * (0.85 + 0.15 * g) * (1. - 0.4 * uCollapse);
    vec3 p = vec3(cos(th), sin(th), 0.) * rr;
    float al = vis * bright * g * (1. - uCollapse) * (0.85 + 0.3 * uThink);
    place(p, id == 3 ? 1.6 : 1.9, mix(uMain, uHot, 0.2 + 0.3 * tick), al * 0.7);
    vHard = 0.7;
  } else if (kind == 3) {
    // Chispas que salen en los picos de voz y al despertar.
    vec3 dir = aA.xyz;
    float life = fract(t * (0.28 + aSeed.x * 0.5) + aSeed.y);
    float r = 1.03 + life * (0.55 + aSeed.z * 0.9);
    vec3 p = world * (rotY(life * 0.7 * (aSeed.w - 0.5)) * dir * r) * (1. - uCollapse);
    float al = pow(1. - life, 2.) * smoothstep(0., 0.06, life) * uSpark;
    place(p, 1.8 + aSeed.w * 1.2, mix(uMain, uHot, 0.5), al);
    vHard = 0.3;
  } else if (kind == 4) {
    // Remolino del núcleo: dos brazos en espiral.
    float u = aA.x; float arm = aA.y;
    float ang = u * 3.4 * 3.14159 + arm * 3.14159 + uPhase.z;
    float rad = (0.07 + u * 0.52) * (1. + uLevel * 0.22);
    float g = easeOut((uGather - 0.05) / 0.5);
    vec3 p = vec3(cos(ang) * rad, (aSeed.x - 0.5) * 0.04, sin(ang) * rad) + (aSeed.yzw - 0.5) * 0.035 * (0.4 + u);
    p = world * (rotZ(0.35) * rotX(1.02) * p) * g * (1. - uCollapse);
    float depth = clamp((p.z + 1.) / 2., 0., 1.);
    float al = pow(1. - u, 1.3) * (0.4 + 0.6 * depth) * g * (1. - uCollapse) * (0.7 + 0.6 * uLevel + 0.4 * uThink);
    place(p, 2.4 * (1.2 - u * 0.6), mix(uHot, uMain, smoothstep(0., 0.8, u)), al * 0.7);
    vHard = 0.35;
  } else if (kind == 6) {
    // Marcas de circuito: trazos cortos sobre la corteza que se encienden y apagan.
    vec3 dir = aA.xyz; float k = aA.w;
    float h = fract(sin(dot(dir, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    vec3 east = normalize(cross(vec3(0., 1., 0.), dir) + vec3(1e-4));
    vec3 q = normalize(dir + east * (k - 2.) * (0.014 + h * 0.01));
    float r = 1.02 + h * 0.05 + uRipple * uLevel * 0.08;
    float g = easeOut((uGather - h * 0.4) / 0.6);
    vec3 p = mix(q * (2.4 + h * 1.4), q * r, g);
    float c = clamp((uCollapse - h * 0.3) / 0.7, 0., 1.);
    p = world * (p * (1. - c * c));
    float depth = clamp((p.z + 1.2) / 2.4, 0., 1.);
    float blink = step(0.28, fract(t * (0.25 + h * 0.6) + h * 7.));
    float al = blink * (0.1 + 0.9 * depth * depth) * g * (1. - c) * (0.8 + 0.5 * uThink + 0.5 * uLevel);
    place(p, 1.9, mix(uMain, uHot, 0.35 + 0.3 * h), al * 0.8);
    vHard = 0.6;
  } else {
    // Anillo del ecuador: la onda reciente de la voz de trex.
    float th = aA.x;
    float fi = th / TAU * 64.;
    int i0 = int(floor(fi)) & 63;
    int i1 = (i0 + 1) & 63;
    float w = mix(uWave[i0], uWave[i1], fract(fi));
    float rr = 1.38 + aA.y * w * 0.30;
    vec3 p = world * (vec3(cos(th), 0., sin(th)) * rr * (1. - uCollapse));
    float depth = clamp((p.z + 1.4) / 2.8, 0., 1.);
    float al = uSpeak * (0.12 + w * 1.4) * (0.35 + 0.65 * depth);
    place(p, 1.9, mix(uMain, uHot, w), al * 0.55);
    vHard = 0.6;
  }
}`;

const POINTS_FS = `#version 300 es
precision mediump float;
in vec3 vColor; in float vAlpha; in float vHard;
out vec4 frag;
void main() {
  vec2 q = gl_PointCoord * 2. - 1.;
  float d = dot(q, q);
  if (d > 1.) discard;
  float a = mix(exp(-d * 3.2), exp(-d * 14.), vHard) * vAlpha;
  vec3 c = vColor * a * 1.5 + vec3(1.) * exp(-d * 14.) * vAlpha * 0.3;
  frag = vec4(c, a * 0.55);
}`;

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 aQ;
uniform float uScale;
out vec2 vUv;
void main() { vUv = aQ / uScale; gl_Position = vec4(aQ, 0., 1.); }`;

const QUAD_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 frag;
uniform int uPass;
uniform float uEnergy, uAlpha, uLevel, uThink;
uniform vec3 uHot, uMain, uDeep;
void main() {
  float d = length(vUv);
  if (uPass == 0) {
    // Lente ahumada: oscurece lo que hay detrás para que la esfera se lea sobre cualquier fondo.
    float a = (1. - smoothstep(0.45, 1.75, d)) * 0.5 * uAlpha;
    frag = vec4(mix(vec3(0.02), uDeep * 0.07, 0.5) * a, a);
    return;
  }
  float e = uEnergy;
  float core = exp(-d * d * 55.) * 1.4 * e;
  float body = exp(-d * d * 7.) * 0.42 * e;
  float halo = exp(-d * 2.1) * 0.2 * e;
  float rim = exp(-pow((d - 1.02) * 9., 2.)) * (0.05 + 0.1 * uLevel + 0.05 * uThink);
  vec3 col = uHot * core + mix(uMain, uHot, 0.2) * body + uDeep * halo + uMain * rim;
  float a = clamp(core * 0.5 + body * 0.35 + halo * 0.5 + rim * 0.4, 0., 1.);
  frag = vec4(col * uAlpha, a * uAlpha);
}`;

/** Generador fijo: la esfera es la misma en cada arranque. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cada punto: cuatro datos que dependen de su tipo, cuatro semillas y el tipo. */
function geometry(): Float32Array {
  const rand = random(20261120);
  const data: number[] = [];
  const push = (a: number, b: number, c: number, d: number, kind: number) => data.push(a, b, c, d, rand(), rand(), rand(), rand(), kind);
  const TAU = Math.PI * 2;
  const shell = 1300, golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < shell; i++) {
    const y = 1 - ((i + 0.5) * 2) / shell, r = Math.sqrt(1 - y * y), th = i * golden;
    push(Math.cos(th) * r, y, Math.sin(th) * r, 0, 0);
  }
  for (let id = 0; id < 7; id++) {
    const n = id === 3 || id === 6 ? 480 : 720;
    for (let k = 0; k < n; k++) push((k / n) * TAU, id, 0, 0, 1);
  }
  for (let m = 0; m < 200; m++) {
    const z = rand() * 1.8 - 0.9, phi = rand() * TAU, r = Math.sqrt(1 - z * z);
    for (let k = 0; k < 5; k++) push(Math.cos(phi) * r, z, Math.sin(phi) * r, k, 6);
  }
  for (let id = 0; id < 3; id++) for (let k = 0; k < 360; k++) push((k / 360) * TAU, id, 0, 0, 2);
  for (let k = 0; k < 120; k++) push((k / 120) * TAU, 0, 1, 0, 2);
  for (let k = 0; k < 180; k++) push((k / 180) * TAU, 3, 0, 0, 2);
  for (let k = 0; k < 160; k++) {
    const z = rand() * 2 - 1, phi = rand() * TAU, r = Math.sqrt(1 - z * z);
    push(Math.cos(phi) * r, z, Math.sin(phi) * r, 0, 3);
  }
  for (let arm = 0; arm < 2; arm++) for (let k = 0; k < 280; k++) push(k / 280, arm, 0, 0, 4);
  for (const side of [1, -1]) for (let k = 0; k < 480; k++) push((k / 480) * TAU, side, 0, 0, 5);
  return new Float32Array(data);
}

export type OrbRenderer = { draw: (uniforms: OrbUniforms) => void; clear: () => void };

/** Prepara el dibujo en `canvas`, o devuelve `null` si no hay WebGL2. */
export function createRenderer(canvas: HTMLCanvasElement): OrbRenderer | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
  if (!gl) return null;

  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("No se pudo crear un shader de la esfera.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
    return shader;
  };
  const link = (vs: string, fs: string): WebGLProgram => {
    const program = gl.createProgram();
    if (!program) throw new Error("No se pudo crear el programa de la esfera.");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "programa");
    return program;
  };

  let points: WebGLProgram, quad: WebGLProgram;
  try {
    points = link(POINTS_VS, POINTS_FS);
    quad = link(QUAD_VS, QUAD_FS);
  } catch (error) {
    console.error(error);
    return null;
  }

  const data = geometry();
  const count = data.length / 9;
  const pointsVao = gl.createVertexArray();
  gl.bindVertexArray(pointsVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 36, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 16);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 36, 32);
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const locate = (program: WebGLProgram, names: string[]) =>
    Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)])) as Record<string, WebGLUniformLocation | null>;
  const pu = locate(points, ["uTime", "uScale", "uPx", "uLevel", "uRipple", "uGather", "uCollapse", "uThink", "uSpeak", "uSpark", "uAlpha", "uPhase", "uWave", "uHot", "uMain", "uDeep"]);
  const qu = locate(quad, ["uScale", "uPass", "uEnergy", "uAlpha", "uLevel", "uThink", "uHot", "uMain", "uDeep"]);

  const clear = (): void => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const draw = (u: OrbUniforms): void => {
    clear();
    gl.enable(gl.BLEND);

    gl.useProgram(quad);
    gl.bindVertexArray(quadVao);
    gl.uniform1f(qu.uScale, SCALE);
    gl.uniform1f(qu.uEnergy, u.energy);
    gl.uniform1f(qu.uAlpha, u.alpha * (1 - u.collapse * u.collapse));
    gl.uniform1f(qu.uLevel, u.level);
    gl.uniform1f(qu.uThink, u.think);
    gl.uniform3fv(qu.uHot, HOT); gl.uniform3fv(qu.uMain, MAIN); gl.uniform3fv(qu.uDeep, DEEP);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(qu.uPass, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Luz que se suma: el color se acumula y el alfa se compone como siempre.
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(qu.uPass, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(points);
    gl.bindVertexArray(pointsVao);
    gl.uniform1f(pu.uTime, u.time);
    gl.uniform1f(pu.uScale, SCALE);
    gl.uniform1f(pu.uPx, canvas.width);
    gl.uniform1f(pu.uLevel, u.level);
    gl.uniform1f(pu.uRipple, u.ripple);
    gl.uniform1f(pu.uGather, u.gather);
    gl.uniform1f(pu.uCollapse, u.collapse);
    gl.uniform1f(pu.uThink, u.think);
    gl.uniform1f(pu.uSpeak, u.speak);
    gl.uniform1f(pu.uSpark, u.spark);
    gl.uniform1f(pu.uAlpha, u.alpha);
    gl.uniform3f(pu.uPhase, u.phase[0], u.phase[1], u.phase[2]);
    gl.uniform1fv(pu.uWave, u.wave);
    gl.uniform3fv(pu.uHot, HOT); gl.uniform3fv(pu.uMain, MAIN); gl.uniform3fv(pu.uDeep, DEEP);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.bindVertexArray(null);
  };

  return { draw, clear };
}
