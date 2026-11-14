import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './ts-loader.mjs';
const { SessionRefs, liveSessions, runLiveTool, liveCaption, liveEndMessage } = await load('voiceLive');

const projects = [
  { id: 'p1', name: 'mangi', path: 'D:/projects/mangi' },
  { id: 'p2', name: 'trex', path: 'D:/projects/trex' },
];

const session = (id, patch = {}) => ({
  id, title: 'Arreglar el lector', project: { id: 'p1', name: 'mangi', path: 'D:/projects/mangi', order: 0 },
  provider: 'claude', agent: 'Claude Code', model: 'Opus', status: 'working', need: null, activity: 'Editando reader.ts', updatedAt: 1_000_000, ...patch,
});

function setup(overrides = {}) {
  const calls = [];
  const refs = new SessionRefs();
  let open = [session('tab-1')];
  const deps = {
    projects, activeProject: 'trex', refs,
    sessions: () => liveSessions(open, () => null, refs, 1_600_000),
    selectProject: id => calls.push(['select', id]),
    openSession: id => { calls.push(['open', id]); open = [...open, session('tab-new', { updatedAt: 2_000_000 })]; return 'tab-new'; },
    sessionReady: async () => true,
    send: async (id, text) => { calls.push(['send', id, text]); },
    interrupt: async id => { calls.push(['interrupt', id]); },
    commits: async (project, hours) => { calls.push(['commits', project.id, hours]); return project.id === 'p1' ? ['fix: lector (hace 3 horas)'] : []; },
    ...overrides,
  };
  return { calls, refs, deps, setOpen: next => { open = next; } };
}

test('session refs stay put while the list is reordered', () => {
  const refs = new SessionRefs();
  const first = liveSessions([session('tab-a', { updatedAt: 10 }), session('tab-b', { updatedAt: 20 })], () => null, refs, 100);
  assert.deepEqual(first.map(s => s.ref), ['s1', 's2']);
  // tab-a pasa a ser la más reciente y aparece una nueva: los alias anteriores no cambian.
  const later = liveSessions([session('tab-a', { updatedAt: 99 }), session('tab-b', { updatedAt: 20 }), session('tab-c', { updatedAt: 50 })], () => null, refs, 100);
  assert.deepEqual(later.map(s => s.ref), ['s2', 's3', 's1']);
  assert.deepEqual([...refs.ids()], [['s1', 'tab-b'], ['s2', 'tab-a'], ['s3', 'tab-c']]);
});

test('get_status reports projects, the visible one and open sessions', async () => {
  const { deps } = setup();
  const result = await runLiveTool('get_status', {}, deps);
  assert.deepEqual(result.proyectos, ['mangi', 'trex']);
  assert.equal(result.proyecto_a_la_vista, 'trex');
  assert.equal(result.sesiones_abiertas[0].ref, 's1');
  assert.equal(result.sesiones_abiertas[0].status, 'trabajando');
});

test('actions run through the same validation as the local brain', async () => {
  const { calls, deps } = setup();
  assert.deepEqual(await runLiveTool('select_project', { project: 'Mangi' }, deps), { ok: true });
  assert.deepEqual(await runLiveTool('send_message', { session: 's1', text: 'corre los tests' }, deps), { ok: true });
  assert.deepEqual(await runLiveTool('interrupt', { session: 's1' }, deps), { ok: true });
  assert.deepEqual(calls, [['select', 'p1'], ['send', 'tab-1', 'corre los tests'], ['interrupt', 'tab-1']]);
});

test('a message to a session works even if the model never asked for the status', async () => {
  const { calls, deps } = setup();
  assert.deepEqual(await runLiveTool('interrupt', { session: 's1' }, deps), { ok: true });
  assert.deepEqual(calls, [['interrupt', 'tab-1']]);
});

test('problems come back as an error for the model to say, never as an exception', async () => {
  const { calls, deps } = setup({ send: async () => { throw new Error('El agente está bloqueado.'); } });
  assert.deepEqual(await runLiveTool('select_project', { project: 'fantasma' }, deps), { error: 'No encontré el proyecto fantasma.' });
  assert.deepEqual(await runLiveTool('send_message', { session: 's9', text: 'hola' }, deps), { error: 'No encontré esa sesión.' });
  assert.deepEqual(await runLiveTool('send_message', { session: 's1', text: 'hola' }, deps), { error: 'El agente está bloqueado.' });
  assert.deepEqual(await runLiveTool('send_message', { session: 's1' }, deps), { error: 'Esa acción no existe o le faltan datos.' });
  assert.deepEqual(await runLiveTool('borrar_todo', {}, deps), { error: 'Esa acción no existe o le faltan datos.' });
  assert.deepEqual(await runLiveTool('select_project', null, deps), { error: 'Esa acción no existe o le faltan datos.' });
  assert.deepEqual(calls, []);
});

test('opening a session can carry its first instruction', async () => {
  const { calls, deps } = setup();
  assert.deepEqual(await runLiveTool('open_session', { project: 'trex', message: 'revisa el README' }, deps), { ok: true });
  assert.deepEqual(calls, [['open', 'p2'], ['send', 'tab-new', 'revisa el README']]);
});

test('recent_work gathers commits and sessions only for projects with activity', async () => {
  const { calls, deps } = setup();
  const all = await runLiveTool('recent_work', { hours: 12 }, deps);
  assert.equal(all.horas, 12);
  assert.deepEqual(all.proyectos.map(p => p.name), ['mangi']);
  assert.deepEqual(all.proyectos[0].commits, ['fix: lector (hace 3 horas)']);
  assert.deepEqual(calls, [['commits', 'p1', 12], ['commits', 'p2', 12]]);
  const one = await runLiveTool('recent_work', { hours: 9999, project: 'trex' }, deps);
  assert.equal(one.horas, 336);
  assert.deepEqual(one.proyectos, []);
  assert.deepEqual(await runLiveTool('recent_work', { hours: 5, project: 'fantasma' }, deps), { error: 'No encontré el proyecto fantasma.' });
});

test('captions keep the tail of what is being said', () => {
  assert.equal(liveCaption('', '  Hola, '), 'Hola, ');
  assert.equal(liveCaption('Hola, ', 'dime.'), 'Hola, dime.');
  const long = liveCaption('a'.repeat(200), 'fin', 20);
  assert.equal(long.length, 20);
  assert.ok(long.startsWith('…') && long.endsWith('fin'));
});

test('only unusual endings are explained', () => {
  assert.equal(liveEndMessage({ kind: 'state', state: 'ended', reason: 'goodbye' }), '');
  assert.equal(liveEndMessage({ kind: 'state', state: 'ended', reason: 'hangup' }), '');
  assert.equal(liveEndMessage({ kind: 'state', state: 'ended', reason: 'idle' }), 'La llamada se cerró por silencio.');
  assert.equal(liveEndMessage({ kind: 'state', state: 'ended', error: 'Gemini rechazó la conexión.' }), 'Gemini rechazó la conexión.');
});
