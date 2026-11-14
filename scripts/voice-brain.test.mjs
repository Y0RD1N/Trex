import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './ts-loader.mjs';
const {
  BRAIN_SCHEMA, brainPrompt, describeSessions, isGoodbye, matchProject, parseBrainReply, runBrainActions, spokenReply, summaryPrompt,
} = await load('voiceBrain');

const projects = [
  { id: 'p1', name: 'mangi', path: 'D:/projects/mangi' },
  { id: 'p2', name: 'trex', path: 'D:/projects/trex' },
  { id: 'p3', name: 'Trex Browser', path: 'D:/projects/trex-browser' },
];

const session = (id, patch = {}) => ({
  id, title: 'Arreglar el lector', project: { id: 'p1', name: 'mangi', path: 'D:/projects/mangi', order: 0 },
  provider: 'claude', agent: 'Claude Code', model: 'Opus', status: 'working', need: null, activity: 'Editando reader.ts', updatedAt: 1_000_000, ...patch,
});

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      projects,
      sessionIds: new Map([['s1', 'tab-1']]),
      selectProject: id => calls.push(['select', id]),
      openSession: id => { calls.push(['open', id]); return 'tab-new'; },
      sessionReady: async id => { calls.push(['ready', id]); return true; },
      send: async (id, text) => { calls.push(['send', id, text]); },
      interrupt: async id => { calls.push(['interrupt', id]); },
      ...overrides,
    },
  };
}

test('the schema names every tool the reply parser accepts', () => {
  const tools = JSON.parse(BRAIN_SCHEMA).properties.actions.items.properties.tool.enum;
  assert.deepEqual(tools, ['select_project', 'open_session', 'send_message', 'interrupt', 'summarize']);
});

test('a reply is validated and anything malformed is dropped', () => {
  const reply = parseBrainReply({
    say: '  Abro mangi.  ',
    actions: [
      { tool: 'select_project', project: 'mangi' },
      { tool: 'open_session', project: 'mangi', message: ' corre los tests ' },
      { tool: 'send_message', session: 's1' },
      { tool: 'delete_everything', project: 'mangi' },
      { tool: 'summarize', hours: 9999 },
      'basura',
    ],
  });
  assert.equal(reply.say, 'Abro mangi.');
  assert.deepEqual(reply.actions, [
    { tool: 'select_project', project: 'mangi' },
    { tool: 'open_session', project: 'mangi', message: 'corre los tests' },
    { tool: 'summarize', hours: 336, project: null },
  ]);
  assert.deepEqual(parseBrainReply(null), { say: '', actions: [] });
  assert.deepEqual(parseBrainReply({ say: 5, actions: 'no' }), { say: '', actions: [] });
});

test('projects match by name ignoring case and accents, never by a guess', () => {
  assert.equal(matchProject('Mangi', projects).id, 'p1');
  assert.equal(matchProject('TREX', projects).id, 'p2');
  assert.equal(matchProject('trex browser', projects).id, 'p3');
  assert.equal(matchProject('el proyecto mangi', projects).id, 'p1');
  // "browser" solo cabe en uno; "tre" cabe en dos y no se adivina.
  assert.equal(matchProject('browser', projects).id, 'p3');
  assert.equal(matchProject('tre', projects), null);
  assert.equal(matchProject('otro', projects), null);
  assert.equal(matchProject('', projects), null);
});

test('open a session and send its first message once it is ready', async () => {
  const { calls, deps: d } = deps();
  const outcome = await runBrainActions([{ tool: 'open_session', project: 'mangi', message: 'corre los tests' }], d);
  assert.deepEqual(calls, [['open', 'p1'], ['ready', 'tab-new'], ['send', 'tab-new', 'corre los tests']]);
  assert.deepEqual(outcome, { problems: [], summarize: null });
});

test('actions on unknown projects or sessions are reported, not guessed', async () => {
  const { calls, deps: d } = deps();
  const outcome = await runBrainActions([
    { tool: 'select_project', project: 'fantasma' },
    { tool: 'send_message', session: 's9', text: 'hola' },
    { tool: 'send_message', session: 'S1', text: 'sigue' },
    { tool: 'interrupt', session: 's1' },
  ], d);
  assert.deepEqual(calls, [['send', 'tab-1', 'sigue'], ['interrupt', 'tab-1']]);
  assert.deepEqual(outcome.problems, ['No encontré el proyecto fantasma.', 'No encontré esa sesión.']);
});

test('a failed action does not stop the rest and is said out loud', async () => {
  const { calls, deps: d } = deps({ send: async () => { throw new Error('El agente está bloqueado por un workflow.'); } });
  const outcome = await runBrainActions([
    { tool: 'send_message', session: 's1', text: 'sigue' },
    { tool: 'select_project', project: 'trex' },
    { tool: 'summarize', hours: 12, project: 'mangi' },
  ], d);
  assert.deepEqual(calls, [['select', 'p2']]);
  assert.deepEqual(outcome.problems, ['El agente está bloqueado por un workflow.']);
  assert.equal(outcome.summarize.hours, 12);
  assert.equal(outcome.summarize.project.id, 'p1');
  assert.equal(spokenReply('Listo.', outcome.problems), 'Listo. El agente está bloqueado por un workflow.');
});

test('a session that never becomes ready does not receive the message', async () => {
  const { calls, deps: d } = deps({ sessionReady: async () => false });
  const outcome = await runBrainActions([{ tool: 'open_session', project: 'trex', message: 'hola' }], d);
  assert.deepEqual(calls, [['open', 'p2']]);
  assert.equal(outcome.problems.length, 1);
});

test('sessions are described with short refs, newest first', () => {
  const detail = { tasks: { done: 2, total: 5, current: 'Escribir tests' }, items: [{ kind: 'text', id: 'a', text: 'Ya casi termino el lector.', final: true }] };
  const { sessions, ids } = describeSessions(
    [session('tab-old', { updatedAt: 400_000, status: 'idle', activity: null }), session('tab-new', { need: { kind: 'permission', item: 'x', label: 'Permiso para ejecutar npm test' }, status: 'needs' })],
    id => (id === 'tab-new' ? detail : null),
    1_600_000,
  );
  assert.deepEqual([...ids], [['s1', 'tab-new'], ['s2', 'tab-old']]);
  assert.deepEqual(sessions[0], {
    ref: 's1', project: 'mangi', title: 'Arreglar el lector', agent: 'Claude Code · Opus', status: 'esperando tu respuesta',
    needs: 'Permiso para ejecutar npm test', doing: 'Editando reader.ts', tasks: '2 de 5 tareas; ahora: Escribir tests',
    lastReply: 'Ya casi termino el lector.', minutesAgo: 10,
  });
  assert.equal(sessions[1].status, 'en reposo');
  assert.equal(sessions[1].tasks, null);
});

test('the prompt carries the state, the recent turns and the spoken command', () => {
  const prompt = brainPrompt({
    now: new Date(2026, 10, 14, 9, 30), projects, activeProject: 'trex', sessions: [],
    history: [{ you: 'hola', trex: 'Dime.' }], command: '¿cómo va Claude en mangi?',
  });
  assert.match(prompt, /"proyectos": \[\n\s+"mangi",\n\s+"trex",\n\s+"Trex Browser"/);
  assert.match(prompt, /"proyecto_a_la_vista": "trex"/);
  assert.match(prompt, /- Persona: hola\n {2}trex: Dime\./);
  assert.ok(prompt.endsWith('La persona acaba de decir: «¿cómo va Claude en mangi?»'));
  // Las rutas del disco no se le cuentan a Claude.
  assert.ok(!prompt.includes('D:/projects'));
});

test('the summary prompt only lists projects with activity', () => {
  assert.match(summaryPrompt(12, [{ name: 'mangi', commits: [], sessions: [] }]), /No hay commits ni sesiones/);
  const prompt = summaryPrompt(72, [
    { name: 'mangi', commits: ['fix: lector (hace 3 horas)'], sessions: [] },
    { name: 'trex', commits: [], sessions: [] },
  ]);
  assert.match(prompt, /los últimos 3 días/);
  assert.match(prompt, /"proyecto": "mangi"/);
  assert.ok(!prompt.includes('"trex"'));
});

test('goodbyes end the exchange without calling the brain', () => {
  for (const phrase of ['Gracias', 'gracias, trex', 'Eso es todo.', 'nada más', 'Adiós']) assert.equal(isGoodbye(phrase), true, phrase);
  for (const phrase of ['gracias por abrir mangi, ahora corre los tests', 'abre mangi']) assert.equal(isGoodbye(phrase), false, phrase);
});
