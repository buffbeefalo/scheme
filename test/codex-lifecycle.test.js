'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexLifecycleReader, lifecycleEvent } = require('../lib/codex-lifecycle');

const event = (type, sec = '00', turn_id = 't1') => JSON.stringify({ type: 'event_msg',
  timestamp: `2026-09-17T00:00:${sec}.000Z`, payload: { type, turn_id } }) + '\n';
const filler = n => Array.from({ length: n }, () => JSON.stringify({ type: 'response_item',
  payload: { type: 'custom_tool_call_output', output: 'non-lifecycle output '.repeat(10) } }) + '\n').join('');

function fixture(t, text = '', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-life-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, text);
  let bytes = 0;
  const reader = createCodexLifecycleReader({ ...options, io: { ...fs, readSync: (...args) => {
    const n = fs.readSync(...args); bytes += n; return n;
  } } });
  return { file, reader, read(identity = 'session') { bytes = 0; const value = reader.read(file, identity); return { ...value, bytes }; } };
}

test('a cold reader finds the newest lifecycle boundary without treating tool text as events', t => {
  const f = fixture(t, event('task_started') + filler(5000) + event('task_complete', '01', 'done') + filler(20));
  const state = f.read();
  assert.equal(state.working, false);
  assert.equal(state.lastTurnId, 'done');
  assert.equal(state.stateSince, null, 'one boundary cannot prove a transition duration');
  assert.ok(state.bytes < 100000, 'cold recovery begins at the newest records');
  assert.equal(lifecycleEvent(JSON.stringify({ type: 'response_item', payload: { type: 'task_started' } })), null);
});

test('bounded recovery continues on unchanged files and observes appends before publishing old state', t => {
  const f = fixture(t, event('task_started') + filler(30), { budgetBytes: 1000, chunkBytes: 113 });
  let state = f.read();
  assert.equal(state.pending, true);
  assert.equal(state.working, null);
  fs.appendFileSync(f.file, event('task_complete', '02', 'finished-during-scan'));
  let attempts = 0;
  do {
    state = f.read();
    assert.ok(state.bytes <= 1512, 'fixed read budget plus bounded integrity probes');
    if (state.pending) assert.equal(state.working, null, 'an unread gap cannot retain an old start');
  } while (state.pending && ++attempts < 30);
  assert.equal(state.pending, false);
  assert.equal(state.working, false);
  assert.equal(state.lastTurnId, 'finished-during-scan');
  assert.equal(state.stateSince, '2026-09-17T00:00:02.000Z');
  assert.ok(f.read().bytes <= 512, 'unchanged reads do not rescan transcript contents');
});

test('warm appends keep a long turn active, then completion and abort clear it', t => {
  const f = fixture(t, event('task_started'));
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, filler(5000));
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, event('task_complete', '03', 't1'));
  let state = f.read();
  assert.equal(state.working, false);
  assert.equal(state.stateSince, '2026-09-17T00:00:03.000Z');
  fs.appendFileSync(f.file, event('task_started', '04', 't2'));
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, event('turn_aborted', '05', 't2'));
  state = f.read();
  assert.equal(state.working, false);
  assert.equal(state.lastTurnId, 't1', 'an aborted turn is not a completed turn');
});

test('partial JSONL writes do not flip state until the record is complete', t => {
  const f = fixture(t, event('task_started'), { chunkBytes: 17 });
  assert.equal(f.read().working, true);
  const done = event('task_complete', '06');
  fs.appendFileSync(f.file, done.slice(0, 65));
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, done.slice(65, -1));
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, '\n');
  assert.equal(f.read().working, false);
  const cold = createCodexLifecycleReader({ chunkBytes: 17 });
  fs.appendFileSync(f.file, event('task_started', '07').slice(0, -1));
  assert.equal(cold.read(f.file).working, false);
  fs.appendFileSync(f.file, '\n');
  assert.equal(cold.read(f.file).working, true);
});

test('replacement, truncation, rewrites, missing files, and generation changes cannot reuse stale work', t => {
  const f = fixture(t, event('task_started') + filler(2));
  assert.equal(f.read().working, true);
  fs.writeFileSync(f.file + '.new', event('task_complete', '08', 'replacement'));
  fs.renameSync(f.file + '.new', f.file);
  assert.equal(f.read().working, false);
  fs.writeFileSync(f.file, '');
  assert.equal(f.read().working, null);
  fs.writeFileSync(f.file, event('task_started') + filler(2));
  assert.equal(f.read().working, true);
  const bytes = fs.statSync(f.file).size;
  fs.writeFileSync(f.file, ' '.repeat(bytes - 1) + '\n');
  assert.equal(f.read().working, null);
  fs.unlinkSync(f.file);
  assert.throws(() => f.read(), { code: 'ENOENT' });
  fs.writeFileSync(f.file, event('task_complete', '09'));
  assert.equal(f.read('new-generation').working, false);
});

test('oversized valid tool output preserves an established native lifecycle state', t => {
  const f = fixture(t, event('task_started'), { maxLineBytes: 200 });
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, filler(1));
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, event('task_complete', '10'));
  assert.equal(f.read().working, false);
});

function settle(f, identity = 'session', budgetBytes = 4 * 1024 * 1024) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = f.read(identity);
    assert.ok(state.bytes <= budgetBytes + 512, 'recovery, replay and appends share one read budget');
    if (!state.pending) return state;
    assert.equal(state.working, null, 'unread records may contain a newer completion');
  }
  assert.fail('lifecycle recovery failed to make progress');
}

const giant = (type, size, payloadType = 'item_completed') => JSON.stringify({
  type, payload: { output: 'x'.repeat(size), type: payloadType },
}) + '\n';

test('cold recovery finds an active turn behind 3 MiB and 9 MiB records of both envelopes', t => {
  const f = fixture(t, event('task_started') + giant('response_item', 9 * 1024 * 1024)
    + giant('event_msg', 3 * 1024 * 1024));
  assert.equal(settle(f).working, true);
  assert.ok(f.read().bytes <= 512, 'settled unchanged files do not rescan giant records');
});

test('warm giant records preserve work and giant native completion and abort end it', t => {
  const f = fixture(t, event('task_started'));
  assert.equal(f.read().working, true);
  for (const envelope of ['response_item', 'event_msg']) {
    fs.appendFileSync(f.file, giant(envelope, 3 * 1024 * 1024));
    assert.equal(settle(f).working, true);
  }
  fs.appendFileSync(f.file, giant('event_msg', 9 * 1024 * 1024, 'task_complete'));
  assert.equal(settle(f).working, false);
  fs.appendFileSync(f.file, event('task_started'));
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, giant('event_msg', 3 * 1024 * 1024, 'turn_aborted'));
  assert.equal(settle(f).working, false);
  assert.equal(settle(f, 'cold').working, false, 'cold recovery also classifies a giant native abort');
});

test('giant partial and malformed records do not commit state until a valid newline', t => {
  const f = fixture(t, event('task_started'), { maxLineBytes: 200, budgetBytes: 1000, chunkBytes: 113 });
  assert.equal(f.read().working, true);
  const complete = giant('event_msg', 3000, 'task_complete');
  fs.appendFileSync(f.file, complete.slice(0, -1));
  assert.equal(settle(f, 'session', 1000).working, true);
  assert.equal(settle(f, 'cold', 1000).working, true);
  fs.appendFileSync(f.file, 'garbage\n');
  assert.equal(settle(f, 'session', 1000).working, true, 'malformed giant records match small-record behavior');
  assert.equal(settle(f, 'cold', 1000).working, true);
  fs.appendFileSync(f.file, complete);
  assert.equal(settle(f, 'session', 1000).working, false);
});

test('completion arriving during giant reverse recovery is observed before publishing state', t => {
  const f = fixture(t, event('task_started') + giant('event_msg', 8000),
    { maxLineBytes: 200, budgetBytes: 1000, chunkBytes: 113 });
  assert.equal(f.read().pending, true);
  fs.appendFileSync(f.file, event('task_complete', '12', 'during-recovery'));
  const state = settle(f, 'session', 1000);
  assert.equal(state.working, false);
  assert.equal(state.lastTurnId, 'during-recovery');
});

test('unclassifiable nesting is an unknown barrier until the next native boundary', t => {
  const f = fixture(t, event('task_started'), { maxLineBytes: 200 });
  assert.equal(f.read().working, true);
  fs.appendFileSync(f.file, '{"nested":' + '['.repeat(1000) + '0' + ']'.repeat(1000) + '}\n');
  assert.equal(settle(f).working, null);
  assert.equal(settle(f, 'cold').working, null, 'a cold scan cannot publish a start behind an uncertain record');
  fs.appendFileSync(f.file, event('task_complete', '13'));
  assert.equal(settle(f).working, false);
});

test('replacement and generation reset also discard a partially inspected giant record', t => {
  const f = fixture(t, event('task_started') + giant('event_msg', 8000),
    { maxLineBytes: 200, budgetBytes: 1000, chunkBytes: 113 });
  for (let i = 0; i < 10; i++) assert.equal(f.read().pending, true);
  fs.writeFileSync(f.file + '.new', event('task_complete', '14', 'replaced-during-inspection'));
  fs.renameSync(f.file + '.new', f.file);
  assert.equal(settle(f, 'session', 1000).lastTurnId, 'replaced-during-inspection');
  fs.writeFileSync(f.file, event('task_started') + giant('event_msg', 8000));
  assert.equal(f.read().pending, true);
  fs.writeFileSync(f.file, event('turn_aborted'));
  assert.equal(settle(f, 'new-generation', 1000).working, false);
});

test('telemetry cannot replace pending or uncertain lifecycle evidence with an older detail-window start', t => {
  const { loadCodexTelemetry } = require('../lib/codex-telemetry-source');
  const f = fixture(t, event('task_started') + giant('event_msg', 8000, 'task_complete'),
    { maxLineBytes: 200, budgetBytes: 1000, chunkBytes: 113 });
  const session = { id: 'fixture', codexUuid: 'fixture' };
  const load = () => loadCodexTelemetry(session, event('task_started'), {
    rollout: { path: f.file }, lifecycleReader: f.reader,
  });
  let value = load();
  assert.equal(value.telemetryMeta.lifecyclePending, true);
  assert.equal(value.working, null);
  for (let n = 0; n < 30 && value.telemetryMeta.lifecyclePending; n++) value = load();
  assert.equal(value.working, false);
  fs.appendFileSync(f.file, '{"nested":' + '['.repeat(1000) + '0' + ']'.repeat(1000) + '}\n');
  do { value = load(); } while (value.telemetryMeta.lifecyclePending);
  assert.equal(value.working, null);
  assert.equal(value.telemetryMeta.fields.working.completeness, 'unavailable');
});
