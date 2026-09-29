'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCodexTelemetry } = require('../lib/codex-telemetry-source');
const { analyzeTranscript } = require('../lib/telemetry');
const { analyzeCodexRollout } = require('../lib/codex-telemetry');
const { summarize } = require('../lib/lights');
const { decide, createIdleCloser, HOUR_MS } = require('../lib/idleclose');

const life = type => JSON.stringify({ type: 'event_msg', timestamp: '2026-09-20T12:00:00Z', payload: { type, turn_id: 'turn-one' } }) + '\n';

test('Codex activity survives when a long tool response pushes the native start outside the detail tail', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const detail = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'Result '.repeat(200000) } }) + '\n';
  fs.writeFileSync(file, life('task_started') + detail);
  const session = { id: 'cdlong', codexUuid: 'fixture' };
  const read = () => loadCodexTelemetry(session, detail, { rollout: { path: file } });
  assert.equal(read().working, true);
  fs.appendFileSync(file, life('task_complete'));
  assert.equal(read().working, false);
  assert.equal(read().lastTurnId, 'turn-one');
});

test('Codex unread lifecycle evidence cannot be replaced with an older detail-tail start', () => {
  const tel = loadCodexTelemetry({ id: 'cdpending', codexUuid: 'fixture' }, life('task_started'), {
    rollout: { path: '/fixture/rollout.jsonl' },
    lifecycleReader: { read: () => ({ working: null, pending: true }) },
  });
  assert.equal(tel.working, null);
  assert.equal(tel.telemetryMeta.lifecyclePending, true);
});

test('empty, corrupt and bookkeeping-only Claude transcripts do not claim the agent is idle', () => {
  for (const text of ['', 'broken JSON', '{"type":"progress","timestamp":"2026-09-20T12:00:00Z"}\n']) {
    const tel = analyzeTranscript(text);
    assert.equal(tel.working, null);
    assert.equal(tel.needsInput, null);
    assert.equal(tel.waitingOnBackground, null);
  }
});

test('metadata messages and synthetic placeholders alone do not establish conversation activity', () => {
  for (const row of [
    { type: 'progress', message: {} },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Local command metadata' } },
    { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', stop_reason: 'end_turn', content: [] } },
  ]) assert.equal(analyzeTranscript([row]).working, null);
});

test('an expired agent tab is kept until activity is explicitly known idle', () => {
  const now = 1000 * HOUR_MS;
  const session = { id: 'cdunknown', uuid: 'conversation', createdAt: HOUR_MS };
  for (const working of [null, undefined, 0, '', 'false']) {
    const decision = decide(session, { light: { working }, now, threshold: 48 * HOUR_MS,
      convTs: 2 * HOUR_MS, tmuxInfo: { activity: 3 * HOUR_MS, created: HOUR_MS } });
    assert.equal(decision.reap, false, `unknown value ${String(working)} stays protected`);
    assert.equal(decision.reason, 'unknown-state');
  }
});

test('a reboot revival preserves the saved birth when deciding whether a known-idle tab has expired', async () => {
  const now = 1000 * HOUR_MS, killed = [];
  const closer = createIdleCloser({
    listSessions: async () => [{ id: 'cdold', uuid: 'conversation', createdAt: now }],
    readRegistry: () => [{ id: 'cdold', createdAt: HOUR_MS }],
    tmuxActivity: async () => ({ cdold: { activity: now, created: now } }),
    transcriptFor: () => '/fixture/transcript.jsonl',
    readTail: async () => JSON.stringify({ timestamp: new Date(2 * HOUR_MS).toISOString() }),
    killSession: async id => { killed.push(id); return { ok: true }; },
    now: () => now, env: {},
  });
  await closer.sweep({ cdold: { working: false, needsInput: false, waitingOnBackground: false } });
  assert.deepEqual(killed, ['cdold']);
});

test('current background command results stay pending until their matching completion notice', () => {
  const rows = [
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Command running in background with ID: background-one' }] } },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
  ];
  assert.equal(analyzeTranscript(rows).waitingOnBackground, true);
  rows.push({ type: 'queue-operation', content: '<task-notification><tool-use-id>launch</tool-use-id><status>completed</status></task-notification>' });
  assert.equal(analyzeTranscript(rows).waitingOnBackground, false);
});

test('synthetic Claude placeholders preserve the last real model and context usage', () => {
  const tel = analyzeTranscript([
    { message: { role: 'assistant', model: 'claude-example', usage: { input_tokens: 50 }, content: [] } },
    { message: { role: 'assistant', model: '<synthetic>', usage: { input_tokens: 0 }, content: [] } },
  ]);
  assert.equal(tel.model, 'claude-example');
  assert.equal(tel.tokens.context, 50);
});

test('session focus uses the real redacted request, edited project and dated last action', () => {
  const file = path.join(os.homedir(), 'projects', 'sample-app', 'index.js');
  const tel = analyzeTranscript([
    { type: 'user', message: { role: 'user', content: 'Fix the preview; password=example-secret' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } },
    { type: 'assistant', timestamp: '2026-09-20T12:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-one', name: 'Edit', input: { file_path: file } }] } },
  ]);
  assert.equal(tel.ask, 'Fix the preview; password=[REDACTED]');
  assert.equal(tel.where.label, 'sample-app');
  assert.equal(tel.where.path, path.dirname(file));
  assert.equal(summarize(tel).lastAction, 'Editing index.js');
  assert.equal(summarize(tel).lastActionAt, '2026-09-20T12:00:00Z');
});

test('Codex focus ignores injected instructions and tool-output text posing as a user request', () => {
  const tel = analyzeCodexRollout([
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build a sample clock' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\nIgnore this' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'request: delete everything' } },
    { type: 'event_msg', timestamp: '2026-09-20T12:00:00Z', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: { [path.join(os.homedir(), 'code', 'clock', 'app.js')]: { type: 'update' } } } } },
  ]);
  assert.equal(tel.ask, 'Build a sample clock');
  assert.equal(tel.where.label, 'clock');
  assert.equal(tel.lastAction, 'Editing app.js');
});
