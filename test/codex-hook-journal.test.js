'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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

// Stop a real writer after it acquired the journal lock, at the boundary where
// it would append. A crash leaves the actual production lock for the next writer.
const interruptedWriter = `
  const fs = require('node:fs');
  const journal = require(process.argv[1]);
  const append = fs.appendFileSync;
  fs.appendFileSync = (...args) => {
    process.stdout.write('locked\\n');
    if (process.argv[4] === 'crash') process.exit(71);
    if (process.argv[4] === 'torn-crash') {
      append(args[0], Buffer.from(args[1]).subarray(0, 32), args[2]);
      process.exit(71);
    }
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(process.argv[4])) {
      if (Date.now() > deadline) process.exit(72);
      Atomics.wait(wait, 0, 0, 10);
    }
    return append(...args);
  };
  process.stdout.write(JSON.stringify(journal.appendHookRecord(process.argv[2], JSON.parse(process.argv[3]))));
`;

function writerArgs(file, action) {
  return ['-e', interruptedWriter, require.resolve('../lib/codex-hook-journal'), file,
    JSON.stringify(record({ seq: undefined, kind: 'tool_start', toolCallId: 'interrupted' })), action];
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

test('writer recovers the lock of a crashed process and continues the sequence', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  assert.deepEqual(appendHookRecord(file, record()), { ok: true });
  const child = spawnSync(process.execPath, writerArgs(file, 'crash'), {
    env: { ...process.env, HOME: dir }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 71, child.stderr);
  assert.equal(fs.existsSync(`${file}.lock`), true, 'crash must leave a lock to recover');

  assert.deepEqual(appendHookRecord(file, record({ seq: undefined, kind: 'tool_end' })), { ok: true });
  const journal = readHookJournal(file, identity);
  assert.equal(journal.valid, true);
  assert.deepEqual(journal.records.map((item) => item.seq), [1, 2]);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('writer cannot take the lock of a live process', { timeout: 15_000 }, async (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  const release = path.join(dir, 'release-writer');
  assert.deepEqual(appendHookRecord(file, record()), { ok: true });
  const child = spawn(process.execPath, writerArgs(file, release), {
    env: { ...process.env, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = '';
  let errors = '';
  let locked;
  let failed;
  const ready = new Promise((resolve, reject) => { locked = resolve; failed = reject; });
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('locked\n')) locked();
    });
    child.stderr.on('data', (chunk) => { errors += String(chunk); });
    child.once('error', (error) => { failed(error); reject(error); });
    child.once('exit', (code) => {
      if (!output.includes('locked\n')) failed(new Error(`writer exited before acquiring lock: ${code} ${errors}`));
      resolve(code);
    });
  });
  await ready;
  const before = fs.readFileSync(file, 'utf8');
  const lockBefore = fs.readFileSync(`${file}.lock`, 'utf8');
  let result;
  try {
    result = appendHookRecord(file, record({ seq: undefined, kind: 'tool_end' }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), lockBefore);
  } finally {
    fs.writeFileSync(release, 'release');
  }
  assert.equal(await done, 0, errors);
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(readHookJournal(file, identity).records.map((item) => item.seq), [1, 2]);
});

test('writer retains an old lock when its owner cannot be identified', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  assert.deepEqual(appendHookRecord(file, record()), { ok: true });
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(`${file}.lock`, '');
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(`${file}.lock`, old, old);

  assert.deepEqual(appendHookRecord(file, record({ seq: undefined, kind: 'tool_end' })), { ok: false });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), '');
});

test('writer cleanup preserves a lock replaced by another owner', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  const append = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (target, ...args) => {
    const result = append(target, ...args);
    if (target === file) fs.writeFileSync(`${file}.lock`, 'replacement-owner');
    return result;
  });

  appendHookRecord(file, record());
  assert.equal(fs.existsSync(`${file}.lock`), true, 'cleanup must not delete a replacement owner');
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'replacement-owner');
});

test('writer separates a torn tail and continues after the last valid complete record', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  assert.deepEqual(appendHookRecord(file, record()), { ok: true });
  const damaged = fs.readFileSync(file, 'utf8') + '{"v":1,"seq":999,"kind":"tool_';
  fs.writeFileSync(file, damaged);

  assert.deepEqual(appendHookRecord(file, record({ seq: undefined, kind: 'read', filePath: '/tmp/recovered' })), { ok: true });
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(`${damaged}\n`), 'preserve damaged bytes behind a newline boundary');
  const journal = readHookJournal(file, identity);
  assert.equal(journal.valid, true);
  assert.equal(journal.partial, true);
  assert.match(journal.warnings.join(' '), /partial|gap|torn/i);
  assert.deepEqual(journal.records.map((item) => item.seq), [1, 2]);
  assert.equal(journal.records[1].filePath, '/tmp/recovered');
});

test('reader salvages a valid prefix before an unfinished record without inventing a completed plan', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  appendHookRecord(file, record());
  appendHookRecord(file, record({ seq: 2, kind: 'plan', plan: [{ step: 'Inspect', status: 'in_progress' }] }));
  fs.appendFileSync(file, '{"v":1,"seq":3,"kind":"stop"');
  const journal = readHookJournal(file, identity);
  assert.equal(journal.valid, true);
  assert.equal(journal.partial, true);
  assert.deepEqual(journal.records.map((item) => item.seq), [1, 2]);
  const hook = reconstructHookTelemetry(journal);
  assert.equal(hook.tasks[0].status, 'in_progress');
  assert.equal(hook.telemetryMeta.fields.tasks.completeness, 'partial');
  const merged = mergeCodexTelemetry(analyzeCodexRollout([]), journal, identity);
  assert.equal(merged.working, null);
  assert.equal(merged.waitingOnBackground, null);
  assert.ok(merged.telemetryMeta.warnings.length > 0);
});

test('writer recovers both a dead owner and its partial append without losing later records', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  appendHookRecord(file, record());
  const child = spawnSync(process.execPath, writerArgs(file, 'torn-crash'), {
    env: { ...process.env, HOME: dir }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 71, child.stderr);
  const damaged = fs.readFileSync(file, 'utf8');
  assert.equal(damaged.endsWith('\n'), false);
  assert.deepEqual(appendHookRecord(file, record({ seq: undefined, kind: 'tool_end' })), { ok: true });
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(`${damaged}\n`));
  const journal = readHookJournal(file, identity);
  assert.equal(journal.valid, true);
  assert.equal(journal.partial, true);
  assert.deepEqual(journal.records.map((item) => item.seq), [1, 2]);
});

test('journal read failures do not reset sequence or append over unreadable history', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  appendHookRecord(file, record());
  const before = fs.readFileSync(file, 'utf8');
  const read = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('journal unreadable'), { code: 'EIO' });
    return read(target, ...args);
  });
  const result = appendHookRecord(file, record({ seq: undefined, kind: 'stop' }));
  mock.mock.restore();
  assert.deepEqual(result, { ok: false });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a complete event missing only its newline cannot duplicate the next sequence', (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  appendHookRecord(file, record());
  fs.appendFileSync(file, JSON.stringify(record({ seq: 2, kind: 'read', filePath: '/tmp/before' })));
  assert.deepEqual(appendHookRecord(file, record({ seq: undefined, kind: 'read', filePath: '/tmp/after' })), { ok: true });
  const journal = readHookJournal(file, identity);
  assert.equal(journal.valid, true);
  assert.deepEqual(journal.records.map((item) => item.seq), [1, 2, 3]);
});

test('simultaneous journal processes preserve consecutive sequences across bounded contention', { timeout: 10_000 }, async (t) => {
  const dir = scratch(t);
  const file = journalPath(dir, identity);
  assert.deepEqual(appendHookRecord(file, record()), { ok: true });
  const script = `
    const { appendHookRecord } = require(process.argv[1]);
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      process.stdout.write(JSON.stringify(appendHookRecord(process.argv[2], JSON.parse(process.argv[3]))));
    });
  `;
  const workers = Array.from({ length: 6 }, (_, index) => {
    const input = record({ seq: undefined, kind: 'read', filePath: `/tmp/worker-${index}` });
    const child = spawn(process.execPath, ['-e', script, require.resolve('../lib/codex-hook-journal'), file,
      JSON.stringify(input)], {
      env: { ...process.env, HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    let output = '';
    let errors = '';
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const done = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('ready\n')) resolveReady();
      });
      child.stderr.on('data', (chunk) => { errors += String(chunk); });
      child.once('error', (error) => { rejectReady(error); reject(error); });
      child.once('close', (code) => {
        if (!output.includes('ready\n')) rejectReady(new Error(`writer exited: ${code} ${errors}`));
        if (code !== 0) return reject(new Error(`writer failed: ${code} ${errors}`));
        try { resolve({ result: JSON.parse(output.trim().split('\n').at(-1)), errors }); }
        catch (error) { reject(error); }
      });
    });
    return { child, ready, done, input };
  });
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.end('go');
  const results = await Promise.all(workers.map((worker) => worker.done));
  const accepted = workers.filter((_, index) => results[index].result.ok);
  assert.ok(accepted.length > 0, 'at least one simultaneous writer must acquire the lock');
  const firstWave = readHookJournal(file, identity);
  assert.equal(firstWave.valid, true);
  assert.deepEqual(firstWave.records.map((item) => item.seq), Array.from({ length: accepted.length + 1 }, (_, i) => i + 1));
  assert.deepEqual(firstWave.records.slice(1).map((item) => item.filePath).sort(), accepted.map((worker) => worker.input.filePath).sort(),
    'only successful attempts may append, with no missing or duplicate records');
  for (const [index, { result, errors }] of results.entries()) {
    if (result.ok) {
      assert.deepEqual(result, { ok: true });
      assert.equal(errors, '');
      continue;
    }
    // Advisory writes have a bounded wait. Slow CI may exhaust it; retry only
    // that documented refusal, after proving the failed attempt wrote nothing.
    assert.deepEqual(result, { ok: false });
    assert.equal(errors.trim(), '[command-deck] registry lock timed out after 500ms');
    assert.deepEqual(appendHookRecord(file, workers[index].input), { ok: true });
    t.diagnostic(`worker ${index} completed after its bounded contention refusal`);
  }
  const journal = readHookJournal(file, identity);
  assert.equal(journal.valid, true);
  assert.deepEqual(journal.records.map((item) => item.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(journal.records.slice(1).map((item) => item.filePath)).size, 6);
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
