import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './ts-loader.mjs';
const { chatTasks } = await load('chatTasks');
const { withChatTimes, stampItems } = await load('chatTimes');
const { claudeApiUsage, codexApiUsage, subtractApiUsage, addApiUsage } = await load('tokenUsage');
const { chatReducer } = await load('claudeChat');
const { initialChatState } = await load('chatState');

const todo = (id, at, todos) => ({ kind: 'tool', id, name: 'TodoWrite', status: 'done', input: { todos }, output: null, patch: null, at });

test('task durations follow status changes across whole-list updates', () => {
  const tasks = chatTasks([
    todo('a', 1000, [{ content: 'Leer', status: 'in_progress' }, { content: 'Escribir', status: 'pending' }, { content: 'Probar', status: 'pending' }]),
    todo('b', 61000, [{ content: 'Leer', status: 'completed' }, { content: 'Escribir', status: 'in_progress' }, { content: 'Probar', status: 'pending' }]),
    todo('c', 181000, [{ content: 'Leer', status: 'completed' }, { content: 'Escribir', status: 'completed' }, { content: 'Probar', status: 'completed' }]),
  ], 'Claude');
  assert.deepEqual(tasks.map(t => [t.startedAt, t.completedAt, !!t.approximate]), [[1000, 61000, false], [61000, 181000, false], [61000, 181000, true]]);
  // Reopened work restarts its clock; untimed history keeps tasks without times.
  const reopened = chatTasks([todo('a', 1000, [{ content: 'Leer', status: 'completed' }]), todo('b', 5000, [{ content: 'Leer', status: 'in_progress' }])], 'Codex');
  assert.equal(reopened[0].startedAt, 5000); assert.equal(reopened[0].completedAt, undefined);
  assert.equal(chatTasks([todo('a', undefined, [{ content: 'Leer', status: 'completed' }])], 'Codex')[0].startedAt, undefined);
});

test('only new tool and user items are stamped, never earlier ones', () => {
  const before = [{ kind: 'user', id: 'u1', text: 'hola', images: 0, previews: [] }];
  const after = [...before, { kind: 'tool', id: 't1', name: 'Bash', status: 'running', input: {}, output: null, patch: null }, { kind: 'text', id: 'x', messageId: 'm', text: '', final: false }];
  const stamped = stampItems(before, after, 42);
  assert.equal(stamped[0].at, undefined); assert.equal(stamped[1].at, 42); assert.equal(stamped[2].at, undefined);
  assert.equal(stampItems(stamped, stamped.map(i => i.id === 't1' ? { ...i, status: 'done' } : i), 99)[1].at, 42);
});

test('provider usage maps to one consistent breakdown', () => {
  assert.deepEqual(claudeApiUsage({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300 }),
    { inputTokens: 10, outputTokens: 20, reasoningTokens: null, cachedReadTokens: 1000, cachedWriteTokens: 300, totalTokens: 1330, requests: null, costUsd: null, partial: false, costPartial: false });
  const codex = codexApiUsage({ inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 300, reasoningOutputTokens: 100, totalTokens: 5300 });
  assert.equal(codex.inputTokens, 1000); assert.equal(codex.cachedReadTokens, 4000); assert.equal(codex.totalTokens, 5300);
  const turn = subtractApiUsage(codexApiUsage({ inputTokens: 8000, cachedInputTokens: 6000, outputTokens: 500, totalTokens: 8500 }), codex);
  assert.equal(turn.totalTokens, 3200); assert.equal(subtractApiUsage(codex, codex), null);
  assert.equal(addApiUsage(null, codex), codex);
});

test('a Claude response records its start, end and tokens; the chat total accumulates', () => {
  let clock = 1_000_000;
  const reduce = withChatTimes(chatReducer, () => clock);
  let state = { ...initialChatState('default'), process: 'ready' };
  state = reduce(state, { type: 'send', id: 'm1', text: 'hola', now: clock });
  clock += 5000;
  const result = { type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 5000, session_id: 's',
    usage: { input_tokens: 12, output_tokens: 300, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } };
  state = reduce(state, { type: 'line', event: result, now: clock });
  const turn = state.items.find(i => i.kind === 'turn');
  assert.ok(turn, 'turn marker');
  assert.equal(turn.startedAt, 1_000_000); assert.equal(turn.endedAt, 1_005_000); assert.equal(turn.usage.totalTokens, 2312);
  assert.equal(state.apiUsage.totalTokens, 2312);
  assert.equal(state.items.find(i => i.kind === 'user').at, 1_000_000);
});

test('Claude history restores per-response times and tokens without double counting blocks', () => {
  const user = { type: 'user', uuid: 'u', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'hola' } };
  const usage = { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
  const block = (uuid, ts, content, stop) => ({ type: 'assistant', uuid, timestamp: ts, message: { id: 'msg1', role: 'assistant', content, usage, stop_reason: stop } });
  const state = chatReducer(initialChatState(), { type: 'history', entries: [user,
    block('a1', '2026-11-01T10:00:05.000Z', [{ type: 'text', text: 'Pienso' }], null),
    block('a2', '2026-11-01T10:00:09.000Z', [{ type: 'text', text: 'Listo' }], 'end_turn')] });
  const turn = state.items.find(i => i.kind === 'turn');
  assert.equal(turn.startedAt, Date.parse('2026-11-01T10:00:00.000Z'));
  assert.equal(turn.endedAt, Date.parse('2026-11-01T10:00:09.000Z'));
  assert.equal(turn.usage.totalTokens, 155); assert.equal(state.apiUsage.totalTokens, 155);
});
