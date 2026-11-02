import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './ts-loader.mjs';
const time = await load('timeFormat');
const { normalizeConfig } = await load('api');
const { gitDiffRows, gitFileLabel } = await load('gitPanel');
test('12/24-hour setting migrates old configurations and preserves the saved choice', () => {
  assert.equal(normalizeConfig({}).settings.timeFormat, '24h');
  assert.equal(normalizeConfig({ settings: { timeFormat: 'invalid' } }).settings.timeFormat, '24h');
  assert.equal(normalizeConfig({ settings: { timeFormat: '12h' } }).settings.timeFormat, '12h');
  for (const [hour, expected24, expected12] of [[0,'00:05','12:05'],[12,'12:05','12:05'],[17,'17:05','05:05'],[23,'23:05','11:05']]) {
    const date = new Date(2026, 0, 1, hour, 5);
    assert.equal(time.formatClock(date, '24h'), expected24);
    assert.ok(time.formatClock(date, '12h').startsWith(expected12));
    assert.match(time.formatClock(date, '12h'), hour < 12 ? /a.*m/i : /p.*m/i);
  }
});
test('saved time changes notify mounted views and keep duration data untouched', () => {
  let calls = 0; const unsubscribe = time.subscribeTimeFormat(() => calls++);
  time.applyTimeFormat('12h'); time.applyTimeFormat('12h'); assert.equal(calls, 1);
  assert.match(time.formatClock(new Date(2026, 0, 1, 17, 40)), /p.*m/i);
  unsubscribe(); time.applyTimeFormat('24h'); assert.equal(calls, 1);
  assert.equal(time.formatClock(Number.NaN), '—');
});
test('Git differences retain signs, context and hunk boundaries without headers', () => {
  const rows = gitDiffRows('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n unchanged\n');
  assert.deepEqual(rows.map(row=>row.kind), ['gap','del','add','ctx']);
  assert.equal(rows[1].text, 'old'); assert.equal(rows[2].text, 'new');
  assert.deepEqual(gitDiffRows('+new file\n').map(row=>row.text), ['new file']);
  assert.equal(gitFileLabel({status:'UU', conflicted:true}), 'Conflicto');
});
