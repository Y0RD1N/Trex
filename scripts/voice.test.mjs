import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './ts-loader.mjs';
const {
  voiceStateLabel, voiceListening, voiceDownloadOffer, microphoneOptions, levelPercent, voiceModeBlocker, voiceSpeechBlocker, voiceSettingsOf,
  cloudVoiceOptions, insertDictated, downloadPercent, megabytes, heardLabel, pushHeard,
} = await load('voice');

const status = patch => ({
  supported: true, enabled: true, rawCapture: true, phase: 'idle', error: null,
  modelsInstalled: true, downloading: false, downloadedBytes: 0, totalBytes: 161253144, ...patch,
});

test('the voice state label follows what blocks listening first', () => {
  assert.equal(voiceStateLabel(status({ supported: false })), 'No disponible');
  assert.equal(voiceStateLabel(status({ enabled: false })), 'Apagado');
  assert.equal(voiceStateLabel(status({ downloading: true, modelsInstalled: false })), 'Descargando');
  assert.equal(voiceStateLabel(status({ modelsInstalled: false, phase: 'off' })), 'Faltan modelos');
  assert.equal(voiceStateLabel(status({ phase: 'off', error: 'El micrófono dejó de responder.' })), 'Con error');
  assert.equal(voiceStateLabel(status({ phase: 'loading' })), 'Preparando…');
  assert.equal(voiceStateLabel(status({ phase: 'hearing' })), 'Escuchando');
});

test('voice only counts as listening once the microphone is open', () => {
  assert.equal(voiceListening(status({ phase: 'idle' })), true);
  assert.equal(voiceListening(status({ phase: 'transcribing' })), true);
  assert.equal(voiceListening(status({ phase: 'loading' })), false);
  assert.equal(voiceListening(status({ phase: 'off' })), false);
  assert.equal(voiceListening(status({ enabled: false, phase: 'idle' })), false);
});

test('download progress stays between 0 and 100', () => {
  assert.equal(downloadPercent({ downloadedBytes: 0, totalBytes: 0 }), 0);
  assert.equal(downloadPercent({ downloadedBytes: 80626572, totalBytes: 161253144 }), 50);
  assert.equal(downloadPercent({ downloadedBytes: 999999999, totalBytes: 161253144 }), 100);
  assert.equal(megabytes(161253144), '154 MB');
});

test('settings offer only the download that is still missing', () => {
  assert.equal(voiceDownloadOffer({ modelsInstalled: false, speechInstalled: false }), 'all');
  assert.equal(voiceDownloadOffer({ modelsInstalled: false, speechInstalled: true }), 'all');
  assert.equal(voiceDownloadOffer({ modelsInstalled: true, speechInstalled: false }), 'speech');
  assert.equal(voiceDownloadOffer({ modelsInstalled: true, speechInstalled: true }), 'none');
});

test('the microphone picker lists the system default first and keeps a missing choice visible', () => {
  const list = [{ id: 'a', name: 'Varios micrófonos', isDefault: true }, { id: 'b', name: 'Auriculares AZ09', isDefault: false }];
  assert.deepEqual(microphoneOptions(list, ''), [
    { value: '', label: 'Predeterminado del sistema', description: 'Varios micrófonos' },
    { value: 'a', label: 'Varios micrófonos' },
    { value: 'b', label: 'Auriculares AZ09' },
  ]);
  assert.equal(microphoneOptions(list, 'b').length, 3);
  assert.deepEqual(microphoneOptions(list, 'gone').at(-1), { value: 'gone', label: 'Micrófono no conectado', description: 'Se usa el predeterminado hasta que vuelva' });
  assert.equal(microphoneOptions([], '')[0].description, undefined);
});

test('the level meter is readable at normal speaking volume', () => {
  assert.equal(levelPercent(0), 0);
  assert.equal(levelPercent(0.04), 20);
  assert.equal(levelPercent(0.25), 50);
  assert.equal(levelPercent(5), 100);
  assert.equal(levelPercent(-1), 0);
});

test('paid options say what they still need, and fall back to local meanwhile', () => {
  assert.equal(voiceModeBlocker({ mode: 'local', hasGeminiKey: false }), null);
  assert.equal(voiceModeBlocker({ mode: 'live', hasGeminiKey: true }), null);
  assert.match(voiceModeBlocker({ mode: 'live', hasGeminiKey: false }), /clave de Gemini/);
  const speech = patch => ({ speech: 'elevenlabs', hasCloudKey: true, cloudVoice: '21m00Tcm4TlvDq8ikWAM', speechError: null, ...patch });
  assert.equal(voiceSpeechBlocker(speech({ speech: 'local', hasCloudKey: false })), null);
  assert.equal(voiceSpeechBlocker(speech({})), null);
  assert.match(voiceSpeechBlocker(speech({ hasCloudKey: false })), /clave de ElevenLabs/);
  assert.match(voiceSpeechBlocker(speech({ cloudVoice: '' })), /Elige una voz/);
  assert.equal(voiceSpeechBlocker(speech({ speechError: 'La cuenta de ElevenLabs se quedó sin saldo.' })), 'La cuenta de ElevenLabs se quedó sin saldo. Se usó la voz local.');
});

test('saving a change sends every setting and never the state', () => {
  const full = status({ device: 'mic-1', mode: 'live', liveVoice: 'Puck', bargeIn: false, speech: 'elevenlabs', cloudVoice: 'abc12345', hasGeminiKey: true });
  assert.deepEqual(voiceSettingsOf(full), {
    enabled: true, rawCapture: true, device: 'mic-1', mode: 'live', liveVoice: 'Puck', bargeIn: false, speech: 'elevenlabs', cloudVoice: 'abc12345',
  });
});

test('the cloud voice picker keeps the chosen voice visible before the list loads', () => {
  const list = [{ id: 'a1', name: 'Valentina', detail: 'es · mexican' }, { id: 'b2', name: 'Mateo', detail: '' }];
  assert.deepEqual(cloudVoiceOptions(list, 'a1'), [{ value: 'a1', label: 'Valentina', description: 'es · mexican' }, { value: 'b2', label: 'Mateo', description: undefined }]);
  assert.deepEqual(cloudVoiceOptions([], 'zz9')[0], { value: 'zz9', label: 'Voz elegida', description: 'Carga las voces para ver su nombre' });
  assert.deepEqual(cloudVoiceOptions([], ''), []);
});

test('dictated phrases land at the cursor with the spacing they need', () => {
  const at = n => ({ start: n, end: n });
  assert.deepEqual(insertDictated('', at(0), ' Corre los tests. '), { text: 'Corre los tests.', selection: at(16) });
  // Tras texto pegado se añade un espacio; tras un espacio o un salto de línea, no.
  assert.equal(insertDictated('Hola.', at(5), 'Corre los tests.').text, 'Hola. Corre los tests.');
  assert.equal(insertDictated('Hola. ', at(6), 'Sigue.').text, 'Hola. Sigue.');
  assert.equal(insertDictated('Lista:\n', at(7), 'primero').text, 'Lista:\nprimero');
  // En medio de una frase se separa por los dos lados y el cursor queda tras lo dictado.
  assert.deepEqual(insertDictated('abre archivo', at(4), 'el'), { text: 'abre el archivo', selection: at(7) });
  assert.equal(insertDictated('revisa esto.', at(11), 'bien').text, 'revisa esto bien.');
  // Una selección se sustituye.
  assert.deepEqual(insertDictated('borra ESTO ya', { start: 6, end: 10 }, 'eso'), { text: 'borra eso ya', selection: at(9) });
  // Nada que escribir, o un cursor fuera de rango, no rompe el texto.
  assert.deepEqual(insertDictated('igual', at(2), '   '), { text: 'igual', selection: at(2) });
  assert.equal(insertDictated('corto', at(99), 'fin').text, 'corto fin');
});

test('heard utterances show the command and keep a short history', () => {
  const only = { text: 'Hola Tricks', command: '', wake: true, at: 1 };
  const order = { text: 'Oye Trex, abre el proyecto', command: 'abre el proyecto', wake: true, at: 2 };
  assert.equal(heardLabel(only), '(solo te llamó)');
  assert.equal(heardLabel(order), 'abre el proyecto');
  const list = pushHeard(pushHeard([], only), order, 1);
  assert.deepEqual(list, [order]);
});
