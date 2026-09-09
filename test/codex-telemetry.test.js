'use strict';

// Pure analyzer for a Codex rollout JSONL → the telemetry the terminal rail renders.
// Codex's transcript schema is unrelated to Claude Code's, so this is a separate parser
// from lib/telemetry.js. Line shapes are taken from real ~/.codex/sessions rollouts:
//   {type, payload, timestamp} where type ∈ session_meta|turn_context|response_item|event_msg
//   node --test test/codex-telemetry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeCodexRollout, codexTranscriptPath, resolveCodexRollout, findCodexSessionUuid, listCodexSessionCandidates } = require('../lib/codex-telemetry');

// ---- inline rollout-line builders (real payload shapes) --------------------
const meta = (cwd, id = '019f3ac3-585e-7d23-990d-01e10eb50fe6') =>
  ({ type: 'session_meta', timestamp: '2026-07-15T00:00:30.000Z', payload: { id, cwd, timestamp: '2026-07-15T00:00:00.000Z', git: null, originator: 'codex', cli_version: '0.144.4', model: null } });
const turnCtx = (model, { approval = 'on-request', turn_id = 't1' } = {}) =>
  ({ type: 'turn_context', payload: { model, approval_policy: approval, sandbox_policy: { type: 'read-only' }, turn_id, model_reasoning_effort: null } });
const taskStarted = (turn_id, window = 258400) =>
  ({ type: 'event_msg', timestamp: '2026-07-15T00:00:01.000Z', payload: { type: 'task_started', turn_id, started_at: 1783310000, model_context_window: window, collaboration_mode_kind: 'default' } });
const taskComplete = (turn_id) =>
  ({ type: 'event_msg', timestamp: '2026-07-15T00:00:05.000Z', payload: { type: 'task_complete', turn_id, last_agent_message: null, completed_at: 1783310005, duration_ms: 4346 } });
const turnAborted = (turn_id, reason) =>
  ({ type: 'event_msg', timestamp: '2026-07-15T00:00:05.000Z', payload: { type: 'turn_aborted', turn_id, ...(reason !== undefined && { reason }) } });
// token_count.info is null until usage lands. total_token_usage is CUMULATIVE spend (grows past the
// window across turns); last_token_usage is the CURRENT turn — its input_tokens ≈ live window
// occupancy. The meter MUST read last, not total (verified against real multi-turn rollouts).
const rateWindow = (usedPercent, windowMinutes, resetsAt) => ({ used_percent: usedPercent, window_minutes: windowMinutes, resets_at: resetsAt });
const rateLimits = ({ primary = null, secondary = null, credits = { has_credits: false, unlimited: false, balance: '0' }, includeCredits = true, plan = null, reached = null } = {}) => {
  const limits = { limit_id: 'codex', primary, secondary, plan_type: plan, rate_limit_reached_type: reached };
  if (includeCredits) limits.credits = credits;
  return limits;
};
const tokenCount = ({ contextNow = null, cached = 0, output = 0, totalSpent = null, window = null, rateLimits: limits } = {}) => {
  const payload = { type: 'token_count',
    info: contextNow == null ? null : {
      total_token_usage: { input_tokens: totalSpent || contextNow, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: totalSpent || contextNow },
      last_token_usage: { input_tokens: contextNow, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: contextNow + output },
      model_context_window: window } };
  if (limits !== undefined) payload.rate_limits = limits;
  return { type: 'event_msg', timestamp: '2026-07-15T00:00:04.000Z', payload };
};
let callSeq = 0;
const fnCall = (name, args = '{}') =>
  ({ type: 'response_item', timestamp: '2026-07-15T00:00:03.000Z', payload: { type: 'function_call', name, arguments: args, call_id: `call_${++callSeq}` } });

test('model comes from turn_context, not the (null) session_meta.model', () => {
  const t = analyzeCodexRollout([meta('/home/you/proj'), turnCtx('gpt-5.5')]);
  assert.equal(t.model, 'gpt-5.5');
  assert.equal(t.modelShort, 'gpt-5.5');
});

test('latest turn_context model wins (model switched mid-session)', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), turnCtx('gpt-5.4-mini', { turn_id: 't2' })]);
  assert.equal(t.model, 'gpt-5.4-mini');
});

test('context footprint comes from last_token_usage (current turn), NOT cumulative total', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), tokenCount({ contextNow: 10061, totalSpent: 28973, window: 258400 })]);
  assert.equal(t.tokens.context, 10061);        // the live window occupancy (last turn's input)
  assert.equal(t.tokens.totalSpent, 28973);
  assert.equal(t.contextWindow, 258400);
  assert.notEqual(t.tokens.context, 28973);     // must NOT be the cumulative spend
});

test('a long session never inflates the meter past the window (last, not cumulative total)', () => {
  // Real data: total_token_usage climbs 28973 → 829897 (>window) while last stays bounded. If the
  // meter read total it would show 321% — nonsense. It must track last_token_usage.
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'),
    tokenCount({ contextNow: 10061, totalSpent: 28973, window: 258400 }),
    tokenCount({ contextNow: 111725, totalSpent: 829897, window: 258400 })]);
  assert.equal(t.tokens.context, 111725);       // ~43% of the 258400 window — the truthful figure
  assert.equal(t.tokens.totalSpent, 829897);    // latest token_count's cumulative total wins
  assert.ok(t.tokens.context < t.contextWindow, 'context never exceeds the window');
});

test('absent or malformed cumulative total_token_usage leaves the prior session spend intact', () => {
  const absent = tokenCount({ contextNow: 100 });
  delete absent.payload.info.total_token_usage;
  const malformed = tokenCount({ contextNow: 200 });
  malformed.payload.info.total_token_usage = { total_tokens: '829897' };
  const t = analyzeCodexRollout([meta('/x'), tokenCount({ contextNow: 42, totalSpent: 15220 }), absent, malformed]);
  assert.equal(t.tokens.totalSpent, 15220);
});

test('cached input tokens break out for the meter (Claude-consistent input/cache split)', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), tokenCount({ contextNow: 10000, cached: 9000, output: 120, window: 258400 })]);
  assert.equal(t.tokens.context, 10000);
  assert.equal(t.tokens.cacheRead, 9000);
  assert.equal(t.tokens.input, 1000);           // input_tokens - cached_input_tokens (non-cached)
  assert.equal(t.tokens.output, 120);
});

test('context window is known from task_started even when token_count.info is null', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), taskStarted('t1', 258400), tokenCount({ /* info null */ })]);
  assert.equal(t.contextWindow, 258400);   // task_started supplied it; null info must not crash or clobber
  assert.equal(t.tokens.context, 0);        // no usage yet → 0, not NaN
});

test('working flips true on task_started and false on task_complete (last event wins)', () => {
  const busy = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), taskStarted('t1')]);
  assert.equal(busy.working, true);
  const done = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), taskStarted('t1'), taskComplete('t1')]);
  assert.equal(done.working, false);
});

test('turn_aborted clears working without counting a completed turn', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), taskStarted('t1'), turnAborted('t1', 'user_interrupt')]);
  assert.equal(t.working, false);
  assert.equal(t.turns, 0);
});

test('a task_started after turn_aborted re-arms working', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), taskStarted('t1'), turnAborted('t1'), taskStarted('t2')]);
  assert.equal(t.working, true);
});

test('turn_aborted without a reason clears working without throwing', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), taskStarted('t1'), turnAborted('t1')]);
  assert.equal(t.working, false);
});

test('turn_aborted without a prior task_started is idempotently idle', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), turnAborted('t1')]);
  assert.equal(t.working, false);
});

test('turns counts completed tasks in the tail', () => {
  const t = analyzeCodexRollout([meta('/x'), taskStarted('t1'), taskComplete('t1'), taskStarted('t2'), taskComplete('t2')]);
  assert.equal(t.turns, 2);
});

test('lastTool + tool counts come from function_call response items', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), fnCall('exec_command', '{"command":"ls"}'), fnCall('exec_command', '{"command":"cat x"}'), fnCall('apply_patch', '{}')]);
  assert.equal(t.lastTool, 'apply_patch');
  assert.equal(t.tools.exec_command, 2);
  assert.equal(t.tools.apply_patch, 1);
});

test('rate-limit primary-only live prolite shape surfaces as the first codexRate window', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5'), tokenCount({ rateLimits: rateLimits({
    primary: rateWindow(1.0, 10080, 1784837068), plan: 'prolite',
  }) })]);
  assert.deepEqual(t.codexRate, {
    plan: 'prolite', reached: null,
    windows: [{ usedPercent: 1.0, windowMinutes: 10080, resetsAt: 1784837068 }],
    credits: { balance: 0, hasCredits: false, unlimited: false },
  });
});

test('credits preserve the known prolite shape and strictly parse valid balances', () => {
  const cases = [
    [{ balance: '0', has_credits: false, unlimited: true }, { balance: 0, hasCredits: false, unlimited: true }],
    [{ balance: '500', has_credits: true, unlimited: false }, { balance: 500, hasCredits: true, unlimited: false }],
    [{ balance: '12.50', has_credits: true, unlimited: false }, { balance: 12.5, hasCredits: true, unlimited: false }],
    [{ balance: 500, has_credits: true, unlimited: false }, { balance: 500, hasCredits: true, unlimited: false }],
  ];
  for (const [credits, expected] of cases) {
    const t = analyzeCodexRollout([meta('/x'), tokenCount({ rateLimits: rateLimits({ credits }) })]);
    assert.deepEqual(t.codexRate.credits, expected);
  }
});

test('credits reject malformed, non-finite, and overflow balances', () => {
  for (const balance of ['500abc', 'abc', '', 'Infinity', 'NaN', '9'.repeat(309), Infinity, NaN]) {
    const t = analyzeCodexRollout([meta('/x'), tokenCount({ rateLimits: rateLimits({ credits: { balance, has_credits: true, unlimited: false } }) })]);
    assert.deepEqual(t.codexRate.credits, { balance: null, hasCredits: true, unlimited: false });
  }
});

test('rate limits are independent of token_count.info', () => {
  const t = analyzeCodexRollout([meta('/x'), tokenCount({ rateLimits: rateLimits({
    primary: rateWindow(12.5, 300, 1783320000), plan: 'plus',
  }) })]);
  assert.deepEqual(t.codexRate.windows[0], { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1783320000 });
});

test('rate-limit primary + secondary preserves both windows in order', () => {
  const t = analyzeCodexRollout([meta('/x'), tokenCount({ rateLimits: rateLimits({
    primary: rateWindow(12.5, 300, 1783320000), secondary: rateWindow(44, 10080, 1784837068), credits: null, plan: 'plus',
  }) })]);
  assert.deepEqual(t.codexRate.windows, [
    { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1783320000 },
    { usedPercent: 44, windowMinutes: 10080, resetsAt: 1784837068 },
  ]);
  assert.equal(t.codexRate.credits, null);
});

test('rate limits without credits record credits as null', () => {
  const t = analyzeCodexRollout([meta('/x'), tokenCount({ rateLimits: rateLimits({
    primary: rateWindow(12.5, 300, 1783320000), includeCredits: false, plan: 'plus',
  }) })]);
  assert.equal(t.codexRate.credits, null);
});

test('credits alone publish a Codex rate snapshot', () => {
  const t = analyzeCodexRollout([meta('/x'), tokenCount({ rateLimits: rateLimits({
    credits: { balance: '500', has_credits: true, unlimited: false },
  }) })]);
  assert.deepEqual(t.codexRate, {
    plan: null, reached: null, windows: [],
    credits: { balance: 500, hasCredits: true, unlimited: false },
  });
});

test('a null secondary emits no second rate window', () => {
  const t = analyzeCodexRollout([meta('/x'), tokenCount({ rateLimits: rateLimits({
    primary: rateWindow(12.5, 300, 1783320000), secondary: null, plan: 'plus',
  }) })]);
  assert.equal(t.codexRate.windows.length, 1);
});

test('a reached rate limit surfaces its reached type', () => {
  const t = analyzeCodexRollout([meta('/x'), tokenCount({ rateLimits: rateLimits({
    primary: rateWindow(100, 300, 1783320000), plan: 'plus', reached: 'primary_window',
  }) })]);
  assert.equal(t.codexRate.reached, 'primary_window');
});

test('the latest token_count with usable rate fields wins', () => {
  const t = analyzeCodexRollout([meta('/x'),
    tokenCount({ rateLimits: rateLimits({ primary: rateWindow(12.5, 300, 1783320000), plan: 'plus' }) }),
    tokenCount({ rateLimits: rateLimits({ primary: rateWindow(44, 10080, 1784837068), plan: 'prolite' }) }),
  ]);
  assert.deepEqual(t.codexRate.windows[0], { usedPercent: 44, windowMinutes: 10080, resetsAt: 1784837068 });
  assert.equal(t.codexRate.plan, 'prolite');
});

test('a newer token_count without rate_limits preserves the last known good rate', () => {
  const t = analyzeCodexRollout([meta('/x'),
    tokenCount({ rateLimits: rateLimits({ primary: rateWindow(12.5, 300, 1783320000), credits: { balance: '500', has_credits: true, unlimited: false }, plan: 'plus' }) }),
    tokenCount(),
  ]);
  assert.deepEqual(t.codexRate.windows[0], { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1783320000 });
  assert.equal(t.codexRate.plan, 'plus');
  assert.deepEqual(t.codexRate.credits, { balance: 500, hasCredits: true, unlimited: false });
});

test('needsInput is unavailable until a correlated hook observes it', () => {
  const t = analyzeCodexRollout([meta('/x'), turnCtx('gpt-5.5', { approval: 'on-request' }), taskStarted('t1')]);
  assert.equal(t.needsInput, null);
  assert.equal(t.needsInputKind, null);
  assert.equal(t.telemetryMeta.fields.needsInput.completeness, 'unavailable');
});

test('accepts a raw text blob (newline-joined JSON), not just an array', () => {
  const text = [meta('/x'), turnCtx('gpt-5.5'), tokenCount({ contextNow: 42, window: 258400 })]
    .map((o) => JSON.stringify(o)).join('\n');
  const t = analyzeCodexRollout(text);
  assert.equal(t.model, 'gpt-5.5');
  assert.equal(t.tokens.context, 42);
});

test('malformed / blank / non-object lines are ignored, not fatal', () => {
  const t = analyzeCodexRollout(['', '   ', 'not json', '{"type":"weird"}', JSON.stringify(turnCtx('gpt-5.5'))]);
  assert.equal(t.model, 'gpt-5.5');
});

test('empty input exposes the full parity shape without false negatives', () => {
  const t = analyzeCodexRollout([]);
  assert.equal(t.model, null);
  assert.equal(t.working, null);
  assert.equal(t.turns, 0);
  assert.equal(t.tokens.context, 0);
  assert.equal(t.contextWindow, null);
  assert.equal(t.codexRate, null);
  assert.equal(t.needsInput, null);
  assert.equal(t.waitingOnBackground, null);
  assert.equal(t.lastTurnId, null);
  for (const key of ['tasks', 'todos', 'skills', 'plugins', 'mcp', 'codex', 'recentFiles', 'readFiles', 'pendingBg']) {
    assert.equal(t[key], null, key);
    assert.equal(t.telemetryMeta.fields[key].completeness, 'unavailable', key);
  }
});

test('synthetic rollout combines plans, file changes and plugin calls', () => {
  const completedItem = (item) => ({ type: 'event_msg', payload: { type: 'item_completed', item } });
  const t = analyzeCodexRollout([
    fnCall('update_plan', JSON.stringify({ plan: [{ step: 'Parse rollout', status: 'in_progress' }] })),
    fnCall('exec'),
    completedItem({ id: 'files-1', type: 'FileChange', status: 'completed', changes: {
      '/work/lib/a.js': { type: 'add' }, '/work/lib/b.js': { type: 'add' },
    } }),
    completedItem({ id: 'mcp-1', type: 'McpToolCall', server: 'docs', tool: 'search', pluginId: 'docs-plugin' }),
    taskComplete('turn-1'),
  ]);
  assert.equal(t.lastTurnId, 'turn-1');
  assert.deepEqual(t.recentFiles, ['/work/lib/b.js', '/work/lib/a.js']);
  assert.equal(t.tools.update_plan, 1);
  assert.equal(t.tools.exec, 1);
  assert.deepEqual(t.tasks.map(({ subject, status }) => ({ subject, status })), [
    { subject: 'Parse rollout', status: 'in_progress' },
  ]);
  assert.deepEqual(t.mcp, [{ server: 'docs', tool: 'search', count: 1 }]);
  assert.deepEqual(t.plugins, [{ name: 'docs-plugin', count: 1 }]);
  assert.equal(t.telemetryMeta.fields.pendingBg.completeness, 'unavailable');
});

test('tool call ids are counted once and completion ids stay stable across advancing tails', () => {
  const call = { type: 'response_item', timestamp: '2026-07-21T01:00:00Z', payload: { type: 'function_call', name: 'wait', call_id: 'same' } };
  const done = { type: 'event_msg', timestamp: '2026-07-21T01:00:01Z', payload: { type: 'task_complete', turn_id: 'turn-fixed' } };
  assert.equal(analyzeCodexRollout([call, call, done]).tools.wait, 1);
  assert.equal(analyzeCodexRollout([done]).lastTurnId, analyzeCodexRollout([call, done]).lastTurnId);
});

// ---- codexTranscriptPath: resolves ~/.codex/sessions/**/rollout-*-<uuid>.jsonl ----
test('codexTranscriptPath returns null for a bad/absent uuid', () => {
  assert.equal(codexTranscriptPath(''), null);
  assert.equal(codexTranscriptPath('not-a-uuid'), null);
});

test('codexTranscriptPath resolves rollout-<ts>-<uuid>.jsonl under the sessions base', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexsess-'));
  try {
    const day = path.join(base, '2026', '07', '15');
    fs.mkdirSync(day, { recursive: true });
    const uuid = '019f3ac3-585e-7d23-990d-01e10eb50fe6';
    const f = path.join(day, `rollout-2026-07-15T10-00-00-${uuid}.jsonl`);
    fs.writeFileSync(f, '{}');
    assert.equal(codexTranscriptPath(uuid, base), f);                                     // found
    assert.equal(codexTranscriptPath('019f0000-0000-0000-0000-000000000000', base), null); // absent → null
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---- findCodexSessionUuid: the resume-parity linchpin ----------------------
// Codex mints its own session id (in the rollout filename) after the FIRST turn. To resume a
// specific tab we must map tab → uuid by: matching session_meta.cwd, mtime ≥ the tab's launch,
// and NOT already claimed by another tab (defends the "two same-cwd codex tabs" race).
test('findCodexSessionUuid picks the newest matching-cwd, recent, unclaimed rollout', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexcap-'));
  try {
    const today = new Date();
    const day = path.join(base, String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0'));
    fs.mkdirSync(day, { recursive: true });
    const cwd = '/home/you/proj';
    const mk = (uuid, metaCwd, tsName) => {
      const f = path.join(day, `rollout-${tsName}-${uuid}.jsonl`);
      const payloadTimestamp = tsName.replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3') + '.000Z';
      const timestamp = new Date(Date.parse(payloadTimestamp) + 60_000).toISOString();
      fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', timestamp, payload: { id: uuid, cwd: metaCwd, timestamp: payloadTimestamp } }) + '\n');
      return f;
    };
    const uOld = '019f0000-0000-0000-0000-000000000001';
    const uMatch = '019f0000-0000-0000-0000-000000000002';
    const uOther = '019f0000-0000-0000-0000-000000000003';
    const fOld = mk(uOld, cwd, '2026-07-15T09-00-00');       // right cwd but too old
    const fMatch = mk(uMatch, cwd, '2026-07-15T10-00-00');   // the one we want
    mk(uOther, '/some/other/dir', '2026-07-15T10-05-00');    // newest, but wrong cwd
    const since = Date.now() - 60_000;
    fs.utimesSync(fOld, new Date(since - 120_000), new Date(since - 120_000));   // predates launch → excluded
    fs.utimesSync(fMatch, new Date(), new Date());

    assert.equal(findCodexSessionUuid({ cwd, sinceMs: since }, base), uMatch);
    assert.equal(findCodexSessionUuid({ cwd, sinceMs: since, claimed: new Set([uMatch]) }, base), null); // claimed → none left
    assert.equal(findCodexSessionUuid({ cwd: '/nope', sinceMs: since }, base), null);                    // wrong cwd → null
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function candidateFile(day, uuid, cwd, timestamp, payloadTimestamp, extra = '') {
  const file = path.join(day, `rollout-${timestamp.replace(/[.:]/g, '-')}-${uuid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp, payload: { id: uuid, cwd, timestamp: payloadTimestamp }, extra }) + '\n');
  return file;
}

test('candidate listing uses session_meta.payload.timestamp, not envelope timestamp, mtime, or filename order', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-candidates-'));
  try {
    const day = path.join(base, '2026', '07', '15'); fs.mkdirSync(day, { recursive: true });
    const cwd = '/home/you/proj';
    const old = '019f0000-0000-0000-0000-000000000010';
    const fresh = '019f0000-0000-0000-0000-000000000011';
    const oldFile = candidateFile(day, old, cwd, '2026-07-15T10:04:00.000Z', '2026-07-15T09:00:00.000Z');
    candidateFile(day, fresh, cwd, '2026-07-15T09:01:00.000Z', '2026-07-15T10:00:00.000Z');
    const since = Date.parse('2026-07-15T08:00:00.000Z');
    fs.utimesSync(oldFile, new Date('2026-07-15T11:00:00.000Z'), new Date('2026-07-15T11:00:00.000Z'));
    const candidates = listCodexSessionCandidates({ cwd, sinceMs: since }, base);
    assert.deepEqual(candidates.sort((a, b) => a.uuid.localeCompare(b.uuid)), [
      { uuid: old, startMs: Date.parse('2026-07-15T09:00:00.000Z') },
      { uuid: fresh, startMs: Date.parse('2026-07-15T10:00:00.000Z') },
    ].sort((a, b) => a.uuid.localeCompare(b.uuid)));
    assert.equal(findCodexSessionUuid({ cwd, sinceMs: since }, base), fresh, 'newer payload timestamp wins despite inverted envelope order and old rollout mtime being bumped');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('candidate listing applies the local date-dir floor with one day of midnight slack', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-datefloor-'));
  const priorTz = process.env.TZ;
  const priorRead = fs.readdirSync;
  const priorStat = fs.statSync;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const oldDay = path.join(base, '2026', '07', '13');
    const slackDay = path.join(base, '2026', '07', '14');
    const currentDay = path.join(base, '2026', '07', '15');
    fs.mkdirSync(oldDay, { recursive: true }); fs.mkdirSync(slackDay, { recursive: true }); fs.mkdirSync(currentDay, { recursive: true });
    const cwd = '/home/you/proj';
    candidateFile(oldDay, '019f0000-0000-0000-0000-000000000012', cwd, '2026-07-13T23:00:30.000Z', '2026-07-13T23:00:00.000Z');
    candidateFile(slackDay, '019f0000-0000-0000-0000-000000000013', cwd, '2026-07-15T06:00:30.000Z', '2026-07-15T06:00:00.000Z');
    candidateFile(currentDay, '019f0000-0000-0000-0000-000000000014', cwd, '2026-07-15T06:31:30.000Z', '2026-07-15T06:31:00.000Z');
    const reads = [], stats = [];
    fs.readdirSync = (...args) => { reads.push(String(args[0])); return priorRead(...args); };
    fs.statSync = (...args) => { stats.push(String(args[0])); return priorStat(...args); };
    const candidates = listCodexSessionCandidates({ cwd, sinceMs: Date.parse('2026-07-16T06:30:00.000Z') }, base);
    assert.deepEqual(candidates.map((c) => c.uuid).sort(), ['019f0000-0000-0000-0000-000000000013', '019f0000-0000-0000-0000-000000000014']);
    assert.equal(reads.some((p) => p === oldDay), false, 'a directory before local floor minus slack is never read');
    assert.equal(stats.some((p) => p.startsWith(oldDay)), false, 'its rollout is never statted');
  } finally {
    fs.readdirSync = priorRead;
    fs.statSync = priorStat;
    if (priorTz == null) delete process.env.TZ; else process.env.TZ = priorTz;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('candidate listing excludes missing, invalid, and over-cap session_meta payload timestamps', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-badtimestamp-'));
  try {
    const day = path.join(base, '2026', '07', '15'); fs.mkdirSync(day, { recursive: true });
    const cwd = '/home/you/proj';
    const mk = (uuid, line) => {
      const file = path.join(day, `rollout-2026-07-15T10-00-00-${uuid}.jsonl`);
      fs.writeFileSync(file, line + '\n');
      return file;
    };
    mk('019f0000-0000-0000-0000-000000000015', JSON.stringify({ type: 'session_meta', timestamp: '2026-07-15T10:01:00.000Z', payload: { cwd } }));
    mk('019f0000-0000-0000-0000-000000000016', JSON.stringify({ type: 'session_meta', timestamp: '2026-07-15T10:02:00.000Z', payload: { cwd, timestamp: 'not-a-date' } }));
    mk('019f0000-0000-0000-0000-000000000017', JSON.stringify({ type: 'session_meta', timestamp: '2026-07-15T10:03:00.000Z', payload: { cwd, timestamp: '2026-07-15T10:00:00.000Z' }, padding: 'x'.repeat(262144) }));
    assert.deepEqual(listCodexSessionCandidates({ cwd, sinceMs: Date.parse('2026-07-15T09:00:00.000Z') }, base), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function mkRollout(base, y, m, d, uuid) {
  const dir = path.join(base, y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${y}-${m}-${d}T00-00-00-${uuid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: '/x', timestamp: `${y}-${m}-${d}T00:00:00.000Z` } }) + '\n');
  return file;
}

test('resolveCodexRollout: returns {path, stat}; wrapper returns the same path string', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cxr-'));
  const uuid = '11111111-2222-3333-4444-555555555555';
  const file = mkRollout(base, '2026', '07', '17', uuid);
  const r = resolveCodexRollout(uuid, base);
  assert.equal(r.path, file);
  assert.equal(typeof r.stat.mtimeMs, 'number');
  assert.equal(r.stat.size, fs.statSync(file).size);
  assert.equal(codexTranscriptPath(uuid, base), file);
  fs.rmSync(base, { recursive: true, force: true });
});

test('resolveCodexRollout: cache hit skips the tree walk (readdir spy); ENOENT drops the entry and re-walks', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cxr-'));
  const uuid = '11111111-2222-3333-4444-666666666666';
  const file = mkRollout(base, '2026', '07', '17', uuid);
  const orig = fs.readdirSync;
  let readdirs = 0;
  try {
    fs.readdirSync = (...a) => { readdirs++; return orig.apply(fs, a); };
    assert.equal(resolveCodexRollout(uuid, base).path, file);
    assert.ok(readdirs > 0, 'first resolve walks');
    readdirs = 0;
    assert.equal(resolveCodexRollout(uuid, base).path, file);
    assert.equal(readdirs, 0, 'second resolve is a pure cache hit (stat only)');
    fs.rmSync(file);
    const moved = mkRollout(base, '2026', '07', '16', uuid);
    readdirs = 0;
    assert.equal(resolveCodexRollout(uuid, base).path, moved);
    assert.ok(readdirs > 0, 'ENOENT dropped the entry and re-walked');
  } finally {
    fs.readdirSync = orig;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveCodexRollout: root ENOENT → null; wrapper swallows resolver throws to null', () => {
  const missing = path.join(os.tmpdir(), `cd-cxr-missing-${process.pid}`);
  assert.equal(resolveCodexRollout('11111111-2222-3333-4444-777777777777', missing), null);
  assert.equal(codexTranscriptPath('11111111-2222-3333-4444-777777777777', missing), null);
});

test('resolveCodexRollout: root permission error THROWS; codexTranscriptPath returns null (HEAD-exact)', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root ignores modes');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cxr-'));
  const uuid = '11111111-2222-3333-4444-888888888888';
  mkRollout(base, '2026', '07', '17', uuid);
  fs.chmodSync(base, 0o000);
  try {
    assert.throws(() => resolveCodexRollout(uuid, base));
    assert.equal(codexTranscriptPath(uuid, base), null);
  } finally {
    fs.chmodSync(base, 0o755);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveCodexRollout: deep date-dir errors keep skip-and-continue', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root ignores modes');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cxr-'));
  const uuid = '11111111-2222-3333-4444-999999999999';
  fs.mkdirSync(path.join(base, '2026', '07', '18'), { recursive: true });
  fs.chmodSync(path.join(base, '2026', '07', '18'), 0o000);
  const file = mkRollout(base, '2026', '07', '17', uuid);
  try {
    assert.equal(resolveCodexRollout(uuid, base).path, file);
  } finally {
    fs.chmodSync(path.join(base, '2026', '07', '18'), 0o755);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveCodexRollout: per-base cache keying + 128-entry cap does not throw', () => {
  const baseA = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cxr-'));
  const baseB = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cxr-'));
  const uuid = '11111111-2222-3333-4444-aaaaaaaaaaaa';
  const fa = mkRollout(baseA, '2026', '07', '17', uuid);
  const fb = mkRollout(baseB, '2026', '07', '17', uuid);
  assert.equal(resolveCodexRollout(uuid, baseA).path, fa);
  assert.equal(resolveCodexRollout(uuid, baseB).path, fb);
  for (let i = 0; i < 140; i++) {
    const u = `11111111-2222-3333-4444-${String(100000000000 + i)}`;
    mkRollout(baseA, '2026', '07', '17', u);
    assert.equal(resolveCodexRollout(u, baseA).path, path.join(baseA, '2026', '07', '17', `rollout-2026-07-17T00-00-00-${u}.jsonl`));
  }
  assert.equal(resolveCodexRollout(uuid, baseA).path, fa);
  fs.rmSync(baseA, { recursive: true, force: true });
  fs.rmSync(baseB, { recursive: true, force: true });
});
