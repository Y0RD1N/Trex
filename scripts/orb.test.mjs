import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './ts-loader.mjs';
const { OrbAnimation, levelOf, WAKE_SECONDS, CLOSE_SECONDS } = await load('orb/animation');

/** Avanza la animación a 60 fps durante `seconds`; devuelve si sigue a la vista. */
function run(animation, seconds) {
  let visible = true;
  for (let t = 0; t < seconds; t += 1 / 60) visible = animation.step(1 / 60);
  return visible;
}

test('a hidden orb draws nothing until it is shown', () => {
  const orb = new OrbAnimation();
  assert.equal(orb.step(1 / 60), false);
  orb.frame({ mood: 'listening', mic: 0.5, voice: 0 });
  assert.equal(orb.step(1 / 60), false, 'los fotogramas no la enseñan: solo orb://show');
});

test('waking gathers the particles with a flash, then the orb listens', () => {
  const orb = new OrbAnimation();
  orb.show(false);
  const first = orb.uniforms();
  assert.equal(first.gather, 0);
  assert.equal(first.flash, 1);
  assert.equal(run(orb, WAKE_SECONDS + 0.1), true);
  const formed = orb.uniforms();
  assert.equal(formed.gather, 1);
  assert.ok(formed.flash < 0.1);
  assert.ok(formed.time > WAKE_SECONDS);
});

test('listening follows the microphone and speaking follows the voice of trex', () => {
  const orb = new OrbAnimation();
  orb.show(false);
  orb.frame({ mood: 'listening', mic: 0.25, voice: 0.9 });
  run(orb, 0.5);
  assert.ok(Math.abs(orb.uniforms().level - levelOf(0.25)) < 0.02, 'escuchando: el micrófono');
  assert.equal(orb.uniforms().speak < 0.01, true);
  orb.frame({ mood: 'speaking', mic: 0.9, voice: 0.36 });
  run(orb, 1);
  const speaking = orb.uniforms();
  assert.ok(Math.abs(speaking.level - levelOf(0.36)) < 0.02, 'hablando: la voz de trex');
  assert.ok(speaking.speak > 0.95);
  assert.ok(speaking.wave[0] > 0.4, 'el anillo del ecuador recoge la onda');
  orb.frame({ mood: 'thinking', mic: 0.9, voice: 0.9 });
  run(orb, 1.5);
  const thinking = orb.uniforms();
  assert.ok(thinking.level < 0.02, 'pensando no reacciona al sonido');
  assert.ok(thinking.think > 0.95);
});

test('closing collapses into the core and then stops drawing', () => {
  const orb = new OrbAnimation();
  orb.show(false);
  run(orb, 1);
  orb.frame({ mood: 'closing', mic: 0, voice: 0 });
  assert.equal(run(orb, CLOSE_SECONDS / 2), true);
  assert.ok(orb.uniforms().collapse > 0.4);
  assert.equal(run(orb, CLOSE_SECONDS), false);
  assert.equal(orb.visible, false);
});

test('reduced motion fades in and out and never moves', () => {
  const orb = new OrbAnimation();
  orb.show(true);
  const start = orb.uniforms();
  assert.equal(start.gather, 1, 'sin partículas que vuelan');
  assert.equal(start.alpha, 0);
  orb.frame({ mood: 'speaking', mic: 0, voice: 0.5 });
  run(orb, 2);
  const shown = orb.uniforms();
  assert.equal(shown.alpha, 1);
  assert.equal(shown.time, 0, 'el tiempo no avanza: nada gira');
  assert.deepEqual(shown.phase, [0, 0, 0]);
  assert.equal(shown.ripple, 0);
  assert.equal(shown.spark, 0);
  assert.ok(shown.energy > 0.82, 'la voz solo cambia el brillo del núcleo');
  orb.frame({ mood: 'closing', mic: 0, voice: 0 });
  assert.equal(run(orb, 0.4), false);
  assert.equal(orb.uniforms().collapse, 0, 'se va con un fundido, sin colapsar');
});

test('levels grow with the square root and stay between 0 and 1', () => {
  assert.equal(levelOf(0), 0);
  assert.equal(levelOf(-1), 0);
  assert.equal(levelOf(5), 1);
  assert.ok(levelOf(0.04) > 0.15 && levelOf(0.04) < levelOf(0.25));
});
