'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLightsCollector, summarize, TAIL_LINES, TAIL_BYTES } = require('../lib/lights');
const { analyzeTranscript } = require('../lib/telemetry');
const { analyzeCodexRollout } = require('../lib/codex-telemetry');

const ASK_LINE = JSON.stringify({ type: 'assistant', timestamp: '2026-07-17T01:00:00.000Z', uuid: 'ask-uuid', message: {
  role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'pick one?', header: 'Q', multiSelect: false, options: [{ label: 'a', description: 'A' }] }] } }],
} });
const DONE_LINE = JSON.stringify({ type: 'assistant', timestamp: '2026-07-17T02:00:00.000Z', uuid: 'turn-2', message: {
  role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }],
} });
const CODEX_BUSY = [
  JSON.stringify({ type: 'event_msg', timestamp: '2026-07-17T01:00:00.000Z', payload: { type: 'task_started', model_context_window: 258400 } }),
].join('\n');
const CODEX_DONE = [
  CODEX_BUSY,
  JSON.stringify({ type: 'event_msg', timestamp: '2026-07-17T01:00:01.000Z', payload: { type: 'task_complete', turn_id: 'codex-turn-1' } }),
].join('\n');

function fakeDeps(overrides = {}) {
  return {
    statFile: () => ({ mtimeMs: 1, size: 100 }),
    readTail: async () => DONE_LINE,
    transcriptPath: (cwd, uuid) => (uuid ? `/t/${uuid}.jsonl` : null),
    resolveCodexRollout: () => ({ path: '/c/r.jsonl', stat: { mtimeMs: 1, size: 50 } }),
    analyzeTranscript,
    analyzeCodexRollout,
    backfillCodexUuid: async () => null,
    warn: () => {},
    ...overrides,
  };
}
const S = (o) => ({ id: 'cd1', cwd: '/w', uuid: '11111111-2222-3333-4444-555555555555', ...o });
// Compact switcher metadata rides the same tuple (council a6363f19 §c); truthfulness of each
// field is owned by test/session-metadata.test.js — here it only has to travel intact.
const NO_META = { stateSince: null, lastActivity: null, contextTokens: null, contextWindow: null, modelShort: null };

test('summarize preserves unknown instead of coercing it false', () => {
  assert.deepEqual(summarize({}), {
    working: null, needsInput: null, needsInputKind: null,
    waitingOnBackground: null, lastTurnId: null, ...NO_META,
  });
});

test('claude tuple + attention/asks parity from one analysis', async () => {
  const c = createLightsCollector(fakeDeps({ readTail: async () => ASK_LINE }));
  const out = await c.collect([S({})]);
  assert.deepEqual(out.termLights.cd1, { working: true, needsInput: true, needsInputKind: 'question', waitingOnBackground: false, lastTurnId: null, ...NO_META, lastActivity: '2026-07-17T01:00:00.000Z', modelShort: 'opus-4-8' });
  assert.deepEqual(out.attention, { cd1: 'question' });
  assert.deepEqual(out.asks, { cd1: { kind: 'question' } });
  assert.equal(out.pendingById.cd1.kind, 'question');
});

test('local ask raises visible attention but cannot enter the cloud auto-answer lane', async () => {
  const c = createLightsCollector(fakeDeps({ readTail: async () => ASK_LINE }));
  const out = await c.collect([S({ local: true })]);
  assert.equal(out.termLights.cd1.needsInput, true);
  assert.deepEqual(out.attention, { cd1: 'question' });
  assert.deepEqual(out.asks, {});
  assert.deepEqual(out.pendingById, {});
});

test('done turn: tuple carries lastTurnId, no attention', async () => {
  const c = createLightsCollector(fakeDeps());
  const out = await c.collect([S({})]);
  assert.deepEqual(out.termLights.cd1, { working: false, needsInput: false, needsInputKind: null, waitingOnBackground: false, lastTurnId: 'turn-2', ...NO_META, lastActivity: '2026-07-17T02:00:00.000Z', modelShort: 'opus-4-8' });
  assert.deepEqual(out.attention, {});
});

test('codex: working-only tuple with explicit constants', async () => {
  const c = createLightsCollector(fakeDeps({ readTail: async () => CODEX_BUSY }));
  const out = await c.collect([S({ codex: true, codexUuid: '99999999-9999-9999-9999-999999999999' })]);
  assert.deepEqual(out.termLights.cd1, { working: true, needsInput: null, needsInputKind: null, waitingOnBackground: null, lastTurnId: null, ...NO_META, lastActivity: '2026-07-17T01:00:00.000Z', contextWindow: 258400 });
});

test('codex light tuple carries rollout completion identity and hook-only unknowns', async () => {
  const c = createLightsCollector(fakeDeps({ readTail: async () => CODEX_DONE }));
  const out = await c.collect([S({ codex: true, codexUuid: '99999999-9999-9999-9999-999999999999' })]);
  assert.deepEqual(out.termLights.cd1, {
    working: false, needsInput: null, needsInputKind: null,
    waitingOnBackground: null, lastTurnId: 'codex-turn-1',
    ...NO_META, stateSince: '2026-07-17T01:00:01.000Z', lastActivity: '2026-07-17T01:00:01.000Z', contextWindow: 258400,
  });
  assert.deepEqual(out.attention, {});
  assert.deepEqual(out.asks, {}, 'Codex never enters Claude auto-answer');
});

test('codex lights share the merged loader and invalidate on journal changes', async () => {
  let loads = 0, journalKey = 'missing';
  const c = createLightsCollector(fakeDeps({
    readTail: async () => CODEX_DONE,
    loadCodexTelemetry: (_session, text) => { loads++; return analyzeCodexRollout(text); },
    codexJournalStatKey: () => journalKey,
  }));
  const session = S({ codex: true, codexUuid: '99999999-9999-4999-8999-999999999999' });
  await c.collect([session]);
  await c.collect([session]);
  assert.equal(loads, 1);
  journalKey = '2:200';
  await c.collect([session]);
  assert.equal(loads, 2);
});

test('codex without uuid: backfill attempted, absent this tick', async () => {
  let backfilled = 0;
  const c = createLightsCollector(fakeDeps({ backfillCodexUuid: async () => { backfilled++; } }));
  const out = await c.collect([S({ codex: true })]);
  assert.equal(backfilled, 1);
  assert.ok(!Object.hasOwn(out.termLights, 'cd1'));
});

test('shell and conflict: authoritatively absent, before any I/O', async () => {
  let stats = 0;
  const c = createLightsCollector(fakeDeps({ statFile: () => { stats++; return { mtimeMs: 1, size: 1 }; } }));
  const out = await c.collect([S({ shell: true }), S({ id: 'cd2', local: true, codex: true })]);
  assert.deepEqual(out.termLights, {});
  assert.equal(stats, 0);
});

test('missing transcript (null path / stat ENOENT): the all-unknown tuple, not absent', async () => {
  const enoent = () => { const e = new Error('gone'); e.code = 'ENOENT'; throw e; };
  for (const deps of [fakeDeps({ transcriptPath: () => null }), fakeDeps({ statFile: enoent })]) {
    const out = await createLightsCollector(deps).collect([S({})]);
    assert.deepEqual(out.termLights.cd1, { working: null, needsInput: null, needsInputKind: null, waitingOnBackground: null, lastTurnId: null, ...NO_META });
  }
});

test('stat gate: unchanged (mtimeMs,size) skips the read; change re-reads; pendingAsk survives the gate', async () => {
  let reads = 0, key = { mtimeMs: 1, size: 100 };
  const c = createLightsCollector(fakeDeps({ statFile: () => key, readTail: async () => { reads++; return ASK_LINE; } }));
  const first = await c.collect([S({})]);
  assert.equal(reads, 1);
  const second = await c.collect([S({})]);
  assert.equal(reads, 1);
  assert.deepEqual(second.termLights.cd1, first.termLights.cd1);
  assert.equal(second.pendingById.cd1.kind, 'question');
  key = { mtimeMs: 2, size: 150 };
  await c.collect([S({})]);
  assert.equal(reads, 2);
});

test('memo pruned when a session vanishes', async () => {
  let reads = 0;
  const c = createLightsCollector(fakeDeps({ readTail: async () => { reads++; return DONE_LINE; } }));
  await c.collect([S({})]);
  await c.collect([]);
  await c.collect([S({})]);
  assert.equal(reads, 2);
});

test('err band: non-ENOENT stat throw → {err:true}, memo dropped, ask surfaces conservative', async () => {
  const eacces = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
  let warned = 0;
  const good = fakeDeps({ readTail: async () => ASK_LINE });
  let statFile = good.statFile;
  const deps = { ...good, statFile: (...args) => statFile(...args), warn: () => { warned++; } };
  const c = createLightsCollector(deps);
  const ok = await c.collect([S({})]);
  assert.equal(ok.termLights.cd1.needsInput, true);
  statFile = eacces;
  const bad = await c.collect([S({})]);
  assert.deepEqual(bad.termLights.cd1, { err: true });
  assert.deepEqual(bad.attention, {});
  assert.deepEqual(bad.asks, {});
  assert.equal(warned, 1);
  statFile = () => ({ mtimeMs: 9, size: 900 });
  const rec = await c.collect([S({})]);
  assert.equal(rec.termLights.cd1.needsInput, true);
});

test('L1 boundary: an ask outside a 400-line window but inside 4000 raises needsInput', async () => {
  const filler = [];
  for (let i = 0; i < 1000; i++) filler.push(JSON.stringify({ type: 'progress', timestamp: '2026-07-17T01:30:00.000Z' }));
  const tail = [ASK_LINE, ...filler].join('\n');
  assert.equal(analyzeTranscript(tail.split('\n').slice(-400)).needsInput, false);
  const c = createLightsCollector(fakeDeps({ readTail: async (f, lines) => { assert.equal(lines, TAIL_LINES); return tail; } }));
  const out = await c.collect([S({})]);
  assert.equal(out.termLights.cd1.needsInput, true);
  assert.equal(out.attention.cd1, 'question');
});

test('codex resolver null vs throw: null → all-unknown; throw → err', async () => {
  const cNull = createLightsCollector(fakeDeps({ resolveCodexRollout: () => null }));
  const a = await cNull.collect([S({ codex: true, codexUuid: '99999999-9999-9999-9999-999999999999' })]);
  assert.equal(a.termLights.cd1.working, null);
  const cThrow = createLightsCollector(fakeDeps({ resolveCodexRollout: () => { const e = new Error('io'); e.code = 'EIO'; throw e; } }));
  const b = await cThrow.collect([S({ codex: true, codexUuid: '99999999-9999-9999-9999-999999999999' })]);
  assert.deepEqual(b.termLights.cd1, { err: true });
});

test('window constants pinned', () => {
  assert.equal(TAIL_LINES, 4000);
  assert.equal(TAIL_BYTES, 1024 * 1024);
});
