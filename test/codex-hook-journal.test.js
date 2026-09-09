'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  JOURNAL_MAX_BYTES, appendHookRecord, journalPath, readHookJournal,
  reconstructHookTelemetry, pruneHookJournals,
} = require('../lib/codex-hook-journal');
const { writeHookInput } = require('../lib/codex-hook-writer');
const { mergeCodexTelemetry } = require('../lib/codex-telemetry-merge');
const { loadCodexTelemetry, codexJournalStatKey } = require('../lib/codex-telemetry-source');
const { analyzeCodexRollout, markField } = require('../lib/codex-telemetry');

const identity = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  tabId: 'cdtelemetry01',
  generationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

function record(extra = {}) {
  return {
    v: 1, ...identity, seq: 1, at: '2026-07-21T01:00:00.000Z', kind: 'session_start',
    ...extra,
  };
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-hook-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('writer round-trips an allowlisted record and strips arbitrary payload fields', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  assert.deepEqual(appendHookRecord(file, record({ secret: 'never-store-me', question: 'Proceed?' })), { ok: true });
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /never-store-me/);
  const journal = readHookJournal(file, identity);
  assert.equal(journal.valid, true);
  assert.equal(journal.records[0].question, 'Proceed?');
});

test('writer stays within one MiB and emits one overflow record', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  for (let i = 0; i < 9000; i++) {
    appendHookRecord(file, record({ kind: 'subagent_start', subagentId: `agent-${i}`, seq: i + 1, question: 'x'.repeat(400) }));
  }
  assert.ok(fs.statSync(file).size <= JOURNAL_MAX_BYTES);
  const overflow = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('"kind":"overflow"'));
  assert.equal(overflow.length, 1);
  assert.equal(readHookJournal(file, identity).valid, false);
});

test('reader rejects torn, mismatched, unknown-schema, and out-of-sequence journals', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  const cases = [
    '{"v":1',
    JSON.stringify(record({ generationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })),
    JSON.stringify(record({ v: 99 })),
    [record({ seq: 2 }), record({ seq: 1 })].map(JSON.stringify).join('\n'),
  ];
  for (const bad of cases) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${bad}\n`);
    assert.equal(readHookJournal(file, identity).valid, false, bad);
  }
});

test('reconstruction correlates asks, plans, reads, skills, and subagents', () => {
  const records = [
    record({ seq: 1 }),
    record({ seq: 2, kind: 'permission_request', requestId: 'r1', toolCallId: 'c1', question: 'Run command?' }),
    record({ seq: 3, kind: 'subagent_start', subagentId: 'a1', agentType: 'explorer' }),
    record({ seq: 4, kind: 'plan', toolCallId: 'p1', plan: [{ step: 'Inspect', status: 'in_progress' }] }),
    record({ seq: 5, kind: 'read', filePath: '/skills/demo/SKILL.md' }),
  ];
  const hook = reconstructHookTelemetry({ valid: true, identity, records, warnings: [], coverageSince: records[0].at });
  assert.equal(hook.needsInput, true);
  assert.equal(hook.pendingAsk.requestId, 'r1');
  assert.equal(hook.pendingBg, 1);
  assert.equal(hook.tasks[0].subject, 'Inspect');
  assert.deepEqual(hook.readFiles, ['/skills/demo/SKILL.md']);
  assert.deepEqual(hook.skills, ['demo']);
  assert.equal(hook.telemetryMeta.fields.skills.source, 'derived');
});

test('explicit paired events clear positives back to unknown; elapsed time alone does not', () => {
  const base = [
    record({ seq: 1 }),
    record({ seq: 2, kind: 'permission_request', requestId: 'r1', toolCallId: 'c1' }),
    record({ seq: 3, kind: 'subagent_start', subagentId: 'a1' }),
  ];
  let hook = reconstructHookTelemetry({ valid: true, identity, records: base, warnings: [], coverageSince: base[0].at });
  assert.equal(hook.needsInput, true);
  assert.equal(hook.pendingBg, 1);
  hook = reconstructHookTelemetry({ valid: true, identity, records: [
    ...base,
    record({ seq: 4, kind: 'tool_end', toolCallId: 'c1', status: 'completed' }),
    record({ seq: 5, kind: 'subagent_stop', subagentId: 'a1', status: 'completed' }),
  ], warnings: [], coverageSince: base[0].at });
  assert.equal(hook.needsInput, null);
  assert.equal(hook.pendingBg, null);
});

test('stdin mapper writes only validated Command Deck identities and bounded semantic fields', (t) => {
  const root = scratch(t);
  const env = {
    COMMAND_DECK_CODEX_TELEMETRY_DIR: root,
    COMMAND_DECK_TAB_ID: identity.tabId,
    COMMAND_DECK_CODEX_GENERATION: identity.generationId,
  };
  assert.equal(writeHookInput(env, {
    session_id: identity.sessionId,
    hook_event_name: 'SubagentStart',
    agent_id: 'a1',
    agent_type: 'worker',
    prompt: 'must not be stored',
  }).ok, true);
  const file = journalPath(root, identity);
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /must not be stored/);
  assert.match(raw, /subagent_start/);
  assert.deepEqual(writeHookInput({ ...env, COMMAND_DECK_TAB_ID: '../escape' }, { session_id: identity.sessionId }), { ok: false });
});

test('merge keeps rollout authority and does not infer waiting from partial negatives', () => {
  const rollout = analyzeCodexRollout([
    { type: 'event_msg', timestamp: '2026-07-21T01:00:00.000Z', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { type: 'response_item', timestamp: '2026-07-21T01:00:01.000Z', payload: { type: 'function_call', name: 'update_plan', call_id: 'rp', arguments: '{"plan":[{"step":"native","status":"completed"}]}' } },
  ]);
  const hookTelemetry = reconstructHookTelemetry({ valid: true, identity, warnings: [], coverageSince: '2026-07-21T01:00:00.000Z', records: [
    record({ seq: 1 }),
    record({ seq: 2, kind: 'subagent_start', subagentId: 'a1' }),
    record({ seq: 3, kind: 'plan', toolCallId: 'hp', plan: [{ step: 'fallback', status: 'pending' }] }),
  ] });
  const merged = mergeCodexTelemetry(rollout, { valid: true, identity, telemetry: hookTelemetry, warnings: [] }, identity);
  assert.equal(merged.tasks[0].subject, 'native');
  assert.equal(merged.pendingBg, 1);
  assert.equal(merged.needsInput, null);
  assert.equal(merged.waitingOnBackground, null);
  assert.equal(merged.telemetryMeta.fields.waitingOnBackground.source, 'unavailable');
});

test('invalid or mismatched journal leaves rollout and marks hook fields unavailable', () => {
  const rollout = analyzeCodexRollout([{ type: 'event_msg', timestamp: '2026-07-21T01:00:00.000Z', payload: { type: 'task_started' } }]);
  const merged = mergeCodexTelemetry(rollout, { valid: false, warnings: ['generation mismatch'] }, identity);
  assert.equal(merged.working, true);
  assert.equal(merged.needsInput, null);
  assert.ok(merged.telemetryMeta.warnings.includes('generation mismatch'));
});

test('shared loader merges only a matching launch generation and exposes its stat key', (t) => {
  const root = scratch(t);
  const file = journalPath(root, identity);
  appendHookRecord(file, record());
  appendHookRecord(file, record({ seq: 2, kind: 'subagent_start', subagentId: 'a1' }));
  const session = { id: identity.tabId, codexUuid: identity.sessionId, codexGeneration: identity.generationId };
  const telemetry = loadCodexTelemetry(session, '', { journalRoot: root });
  assert.equal(telemetry.pendingBg, 1);
  assert.match(codexJournalStatKey(session, { journalRoot: root }), /^\d+(?:\.\d+)?:\d+$/);
  assert.equal(loadCodexTelemetry({ ...session, codexGeneration: null }, '', { journalRoot: root }).pendingBg, null);
});

test('retention removes only old inactive generations and honors the directory quota', (t) => {
  const root = scratch(t);
  const oldIdentity = { ...identity, generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  const oldFile = journalPath(root, oldIdentity);
  appendHookRecord(oldFile, record({ ...oldIdentity }));
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, old, old);
  const activeFile = journalPath(root, identity);
  appendHookRecord(activeFile, record());
  const result = pruneHookJournals(root, new Set([`${identity.sessionId}:${identity.generationId}`]));
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(activeFile), true);
  assert.ok(result.bytes <= 32 * 1024 * 1024);
});
