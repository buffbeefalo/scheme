'use strict';
// Compact switcher metadata (council a6363f19 §c): every switcher entry carries a truthful
// CURRENT-STATE DURATION alongside session age. The two are different facts and the council
// forbade conflating them — a session open for 121h that started working 3s ago must read
// "working 3s", never "working 121h". When the read tail cannot PROVE when the current state
// began, the honest answer is `—`, never a substituted age, mtime, or clock read.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTranscript } = require('../lib/telemetry');
const { analyzeCodexRollout } = require('../lib/codex-telemetry');
const { mergeCodexTelemetry } = require('../lib/codex-telemetry-merge');
const { reconstructHookTelemetry } = require('../lib/codex-hook-journal');
const { summarize, createLightsCollector } = require('../lib/lights');

const J = (o) => JSON.stringify(o);
const asst = (ts, stop, content = [{ type: 'text', text: 'x' }], extra = {}) => J({
  type: 'assistant', timestamp: ts, uuid: 'u-' + ts,
  message: { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, ...extra },
});
const prompt = (ts, text = 'go') => J({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const result = (ts, id, text = 'ok') => J({
  type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});

// ── Claude transcripts ────────────────────────────────────────────────────────

test('claude state duration dates from the turn end that established idle', () => {
  const t = analyzeTranscript([
    prompt('2026-08-16T10:00:00.000Z'),
    asst('2026-08-16T10:00:01.000Z', 'tool_use', [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }]),
    result('2026-08-16T10:00:02.000Z', 'a'),
    asst('2026-08-16T10:00:03.000Z', 'end_turn'),
  ]);
  assert.equal(t.working, false);
  assert.equal(t.stateSince, '2026-08-16T10:00:03.000Z');
});

test('claude state duration dates from the prompt that started the current turn', () => {
  const t = analyzeTranscript([
    asst('2026-08-16T10:00:00.000Z', 'end_turn'),
    prompt('2026-08-16T10:00:30.000Z'),
    asst('2026-08-16T10:00:31.000Z', 'tool_use', [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }]),
  ]);
  assert.equal(t.working, true);
  assert.equal(t.stateSince, '2026-08-16T10:00:30.000Z');
});

test('claude leaves state duration unknown when the tail witnesses no transition', () => {
  const t = analyzeTranscript([
    result('2026-08-16T10:00:00.000Z', 'a'),
    asst('2026-08-16T10:00:01.000Z', 'tool_use', [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }]),
    result('2026-08-16T10:00:02.000Z', 'b'),
  ]);
  assert.equal(t.working, true);
  assert.equal(t.stateSince, null, 'a uniformly busy tail cannot prove when busy began');
});

test('claude state duration dates from the blocking ask, not the turn', () => {
  const t = analyzeTranscript([
    prompt('2026-08-16T10:00:00.000Z'),
    asst('2026-08-16T10:00:05.000Z', 'tool_use', [{
      type: 'tool_use', id: 'q', name: 'AskUserQuestion',
      input: { questions: [{ question: 'pick?', header: 'Q', options: [{ label: 'a', description: 'A' }] }] },
    }]),
  ]);
  assert.equal(t.needsInput, true);
  assert.equal(t.stateSince, '2026-08-16T10:00:05.000Z');
});

test('claude waiting-on-background dates from the turn end, not the launch', () => {
  const t = analyzeTranscript([
    prompt('2026-08-16T10:00:00.000Z'),
    asst('2026-08-16T10:00:01.000Z', 'tool_use', [{ type: 'tool_use', id: 'bg', name: 'Agent', input: { description: 'd' } }]),
    result('2026-08-16T10:00:02.000Z', 'bg', 'launched. Task ID: T7'),
    asst('2026-08-16T10:00:09.000Z', 'end_turn'),
  ]);
  assert.equal(t.waitingOnBackground, true);
  assert.equal(t.stateSince, '2026-08-16T10:00:09.000Z');
});

test('claude keeps the latest transition, not the first', () => {
  const t = analyzeTranscript([
    prompt('2026-08-16T10:00:00.000Z'),
    asst('2026-08-16T10:00:01.000Z', 'end_turn'),
    prompt('2026-08-16T10:05:00.000Z'),
    asst('2026-08-16T10:05:01.000Z', 'end_turn'),
  ]);
  assert.equal(t.stateSince, '2026-08-16T10:05:01.000Z');
});

test('claude refuses to date a transition whose event carries no timestamp', () => {
  const t = analyzeTranscript([
    prompt('2026-08-16T10:00:00.000Z'),
    J({ type: 'assistant', uuid: 'no-ts', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }),
  ]);
  assert.equal(t.working, false);
  assert.equal(t.stateSince, null);
});

test('claude refuses an unparseable transition timestamp', () => {
  const t = analyzeTranscript([
    prompt('2026-08-16T10:00:00.000Z'),
    J({ type: 'assistant', timestamp: 'not-a-date', uuid: 'bad', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }),
  ]);
  assert.equal(t.stateSince, null);
});

// ── Codex rollouts ────────────────────────────────────────────────────────────

test('codex state duration follows the rollout event that established the state', () => {
  const t = analyzeCodexRollout([
    { type: 'event_msg', timestamp: '2026-08-16T10:00:00.000Z', payload: { type: 'task_started' } },
    { type: 'event_msg', timestamp: '2026-08-16T10:00:04.000Z', payload: { type: 'task_complete', turn_id: 'c1' } },
  ]);
  assert.equal(t.working, false);
  assert.equal(t.stateSince, '2026-08-16T10:00:04.000Z');
});

test('codex leaves state duration unknown when the rollout tail proves no transition', () => {
  const t = analyzeCodexRollout([
    { type: 'event_msg', timestamp: '2026-08-16T10:00:00.000Z', payload: { type: 'task_started' } },
  ]);
  assert.equal(t.working, true);
  assert.equal(t.stateSince, null);
});

test('codex rollout with no lifecycle event at all has no state duration', () => {
  const t = analyzeCodexRollout([
    { type: 'turn_context', timestamp: '2026-08-16T10:00:00.000Z', payload: { model: 'gpt-5.6-sol' } },
  ]);
  assert.equal(t.working, null);
  assert.equal(t.stateSince, null);
});

// ── Codex hook-journal merge ──────────────────────────────────────────────────

const identity = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  tabId: 'cdtelemetry01',
  generationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};
const hookRecord = (extra = {}) => ({ v: 1, ...identity, seq: 1, at: '2026-08-16T10:00:00.000Z', kind: 'session_start', ...extra });

test('merge keeps a rollout state duration the hook journal does not contradict', () => {
  const rollout = analyzeCodexRollout([
    { type: 'event_msg', timestamp: '2026-08-16T10:00:00.000Z', payload: { type: 'task_started' } },
    { type: 'event_msg', timestamp: '2026-08-16T10:00:07.000Z', payload: { type: 'task_complete', turn_id: 'c1' } },
  ]);
  const hook = reconstructHookTelemetry({
    valid: true, identity, warnings: [], coverageSince: '2026-08-16T10:00:00.000Z',
    records: [hookRecord({ seq: 1 })],
  });
  const merged = mergeCodexTelemetry(rollout, { valid: true, identity, telemetry: hook, warnings: [] }, identity);
  assert.equal(merged.stateSince, '2026-08-16T10:00:07.000Z');
});

test('merge drops a state duration the hook journal has overridden with needs-input', () => {
  const rollout = analyzeCodexRollout([
    { type: 'event_msg', timestamp: '2026-08-16T10:00:00.000Z', payload: { type: 'task_started' } },
    { type: 'event_msg', timestamp: '2026-08-16T10:00:07.000Z', payload: { type: 'task_complete', turn_id: 'c1' } },
  ]);
  const hook = reconstructHookTelemetry({
    valid: true, identity, warnings: [], coverageSince: '2026-08-16T10:00:00.000Z',
    records: [hookRecord({ seq: 1 }), hookRecord({ seq: 2, kind: 'question_request', requestId: 'q1', at: '2026-08-16T10:00:09.000Z' })],
  });
  const merged = mergeCodexTelemetry(rollout, { valid: true, identity, telemetry: hook, warnings: [] }, identity);
  assert.equal(merged.needsInput, true);
  assert.equal(merged.stateSince, null, 'the rollout timestamp describes the idle turn, not the ask');
});

// ── compact SSE tuple ─────────────────────────────────────────────────────────

test('summarize carries the compact metadata with explicit nulls for the unknown', () => {
  assert.deepEqual(summarize({}), {
    working: null, needsInput: null, needsInputKind: null,
    waitingOnBackground: null, lastTurnId: null,
    stateSince: null, lastActivity: null,
    contextTokens: null, contextWindow: null, modelShort: null,
  });
});

test('summarize never lets an unread token count masquerade as zero', () => {
  const tuple = summarize({ tokens: { context: 0 }, contextWindow: 200000 });
  assert.equal(tuple.contextTokens, null);
  assert.equal(tuple.contextWindow, 200000);
});

test('summarize rejects non-finite and non-string metadata rather than passing it through', () => {
  const tuple = summarize({ tokens: { context: '12000' }, contextWindow: Infinity, modelShort: 7, stateSince: 5, lastActivity: {} });
  assert.deepEqual(
    { c: tuple.contextTokens, w: tuple.contextWindow, m: tuple.modelShort, s: tuple.stateSince, a: tuple.lastActivity },
    { c: null, w: null, m: null, s: null, a: null },
  );
});

test('summarize resolves a Claude context window from the model when asked', () => {
  const tuple = summarize({ model: 'claude-opus-5', modelShort: 'opus-5', tokens: { context: 91000 } }, (m) => (m === 'claude-opus-5' ? 200000 : null));
  assert.deepEqual({ c: tuple.contextTokens, w: tuple.contextWindow, m: tuple.modelShort }, { c: 91000, w: 200000, m: 'opus-5' });
});

test('the lights walk ships state duration and context on the existing stat-gated tuple', async () => {
  const text = [
    prompt('2026-08-16T10:00:00.000Z'),
    asst('2026-08-16T10:00:03.000Z', 'end_turn', [{ type: 'text', text: 'done' }], { usage: { input_tokens: 5000, cache_read_input_tokens: 86000 } }),
  ].join('\n');
  let reads = 0;
  const c = createLightsCollector({
    statFile: () => ({ mtimeMs: 1, size: 100 }),
    readTail: async () => { reads++; return text; },
    transcriptPath: (cwd, uuid) => `/t/${uuid}.jsonl`,
    resolveCodexRollout: () => null,
    analyzeTranscript,
    analyzeCodexRollout,
    backfillCodexUuid: async () => null,
    contextWindowFor: () => 200000,
    warn: () => {},
  });
  const s = { id: 'cd1', cwd: '/w', uuid: '11111111-2222-3333-4444-555555555555' };
  const out = await c.collect([s]);
  assert.equal(out.termLights.cd1.stateSince, '2026-08-16T10:00:03.000Z');
  assert.equal(out.termLights.cd1.contextTokens, 91000);
  assert.equal(out.termLights.cd1.contextWindow, 200000);
  assert.equal(out.termLights.cd1.modelShort, 'opus-5');
  await c.collect([s]);
  assert.equal(reads, 1, 'the memo still gates the second walk — no extra transcript read');
});

test('a session age is never promoted into the state-duration slot', async () => {
  // Session created long ago, transcript proves nothing about when the current state began.
  const c = createLightsCollector({
    statFile: () => ({ mtimeMs: 1, size: 100 }),
    readTail: async () => result('2026-08-16T10:00:00.000Z', 'a'),
    transcriptPath: (cwd, uuid) => `/t/${uuid}.jsonl`,
    resolveCodexRollout: () => null,
    analyzeTranscript,
    analyzeCodexRollout,
    backfillCodexUuid: async () => null,
    warn: () => {},
  });
  const out = await c.collect([{ id: 'cd1', cwd: '/w', uuid: '11111111-2222-3333-4444-555555555555', createdAt: 1 }]);
  assert.equal(out.termLights.cd1.working, true);
  assert.equal(out.termLights.cd1.stateSince, null);
});
