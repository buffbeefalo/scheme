'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  STALE_MS, MAX_CODEX_FILES, normalizeClaudeObservation, selectClaudeObservation,
  selectCodexObservation, normalizeCodexObservation, staleFallback, createAccountUsageReader,
} = require('../lib/account-usage');
const { parseCodexUsageObservation } = require('../lib/codex-telemetry');

const NOW = Date.parse('2026-07-20T12:00:00Z');
const claude = (overrides = {}) => ({
  fetchedAtMs: NOW - 1000, fiveHourPct: 41, fiveHourResetsAtMs: NOW + 3600000,
  sevenDayPct: 31, sevenDayResetsAtMs: NOW + 3 * 86400000,
  scopedPct: 12, scopedName: 'Fable', ...overrides,
});

test('Claude normalization keeps used-percentage direction and one atomic observation', () => {
  const p = normalizeClaudeObservation(claude(), NOW);
  assert.equal(p.state, 'fresh');
  assert.deepEqual(p.windows.map((w) => [w.key, w.usedPercent]), [
    ['five_hour', 41], ['seven_day', 31], ['scoped_weekly', 12],
  ]);
  assert.equal(p.partial, false);

  const partial = normalizeClaudeObservation(claude({ sevenDayPct: null, scopedPct: null }), NOW);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.windows.slice(1).map((w) => w.state), ['not-reported', 'not-reported']);
  assert.ok(!Object.hasOwn(partial.windows[1], 'usedPercent'));
});

test('Claude freshness and reset-passed states never imply replenishment', () => {
  const stale = normalizeClaudeObservation(claude({ fetchedAtMs: NOW - STALE_MS - 1 }), NOW);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.windows[1].state, 'stale');
  const passed = normalizeClaudeObservation(claude({ fiveHourResetsAtMs: NOW - 1 }), NOW);
  assert.equal(passed.windows[0].state, 'reset-passed');
  assert.equal(passed.windows[0].usedPercent, 41);
});

test('Claude selector mirrors account monotonicity without field-splicing', () => {
  const newerLow = claude({ fetchedAtMs: NOW - 10, fiveHourPct: 8, sevenDayPct: 99 });
  const olderHigh = claude({ fetchedAtMs: NOW - 100, fiveHourPct: 41, sevenDayPct: 31 });
  assert.equal(selectClaudeObservation([newerLow, olderHigh], NOW), olderHigh);
  const expired = olderHigh.fiveHourResetsAtMs = NOW - 1;
  assert.equal(expired, NOW - 1);
  assert.equal(selectClaudeObservation([newerLow, olderHigh], NOW), newerLow);
});

function codexLine({ ts = '2026-07-20T11:59:59.000Z', rate = {} } = {}) {
  return JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', rate_limits: rate } });
}

test('Codex pure parser accepts complete and valid-partial records, rejects bad framing', () => {
  const complete = parseCodexUsageObservation(codexLine({ rate: {
    plan_type: 'pro', primary: { used_percent: 7, window_minutes: 300, resets_at: (NOW + 1000) / 1000 },
    secondary: { used_percent: 19, window_minutes: 10080, resets_at: (NOW + 2000) / 1000 },
  } }), 12);
  assert.equal(complete.plan, 'pro');
  assert.equal(complete.partial, false);
  assert.deepEqual(complete.windows.map((w) => [w.label, w.usedPercent]), [['5h', 7], ['weekly', 19]]);
  assert.equal(complete.byteOffset, 12);

  const partial = parseCodexUsageObservation(codexLine({ rate: { plan_type: 'pro', primary: null } }));
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.windows.map((w) => w.reported), [false, false]);
  assert.equal(parseCodexUsageObservation('{"type":"event_msg"'), null);
  assert.equal(parseCodexUsageObservation(codexLine({ rate: {} })), null);
  assert.equal(parseCodexUsageObservation(codexLine({ ts: 'not-a-date', rate: { plan_type: 'pro' } })), null);
});

// ── quota-pool identity (2026-08-09) ─────────────────────────────────────────
// Codex changed which quota BUCKET it reports under this account. Real captured data:
//   through 2026-08-03: limit_id 'codex',           limit_name null,  weekly used 1→4%, resets 1786273624
//   from   2026-08-06: limit_id 'codex_bengalfox',  limit_name 'GPT-5.3-Codex-Spark', weekly used 0%, resets 1786667298
// Different resets_at => genuinely a different bucket, not the same window rolling over.
// The parser discarded limit_id/limit_name, so the meter silently swapped to an unused
// 0%-consumed pool and rendered it as the account's usage — reading as "tracking is broken".
// Pool identity must survive parsing; a meter that can't name its bucket can't be trusted.
test('Codex parser carries the quota-pool identity (limit_id / limit_name)', () => {
  const bengalfox = parseCodexUsageObservation(codexLine({ rate: {
    limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark', plan_type: 'pro',
    primary: { used_percent: 0, window_minutes: 10080, resets_at: 1786667298 }, secondary: null,
  } }));
  assert.equal(bengalfox.limitId, 'codex_bengalfox');
  assert.equal(bengalfox.limitName, 'GPT-5.3-Codex-Spark');

  // The historical shape: limit_name is genuinely null and must stay null, not be invented.
  const general = parseCodexUsageObservation(codexLine({ rate: {
    limit_id: 'codex', limit_name: null, plan_type: 'pro',
    primary: { used_percent: 4, window_minutes: 10080, resets_at: 1786273624 }, secondary: null,
  } }));
  assert.equal(general.limitId, 'codex');
  assert.equal(general.limitName, null);

  // Absent entirely (older rollouts) => null, never undefined-by-omission.
  const legacy = parseCodexUsageObservation(codexLine({ rate: {
    plan_type: 'pro', primary: { used_percent: 9, window_minutes: 10080 },
  } }));
  assert.equal(legacy.limitId, null);
  assert.equal(legacy.limitName, null);

  // Bounded like every other string field, and non-strings rejected rather than coerced.
  const hostile = parseCodexUsageObservation(codexLine({ rate: {
    limit_id: 'x'.repeat(500), limit_name: { evil: true }, plan_type: 'pro',
    primary: { used_percent: 1, window_minutes: 300 },
  } }));
  assert.equal(hostile.limitId.length, 64);
  assert.equal(hostile.limitName, null);
});

test('Codex provider surfaces the pool it measured, and flags a pool switch', () => {
  const row = (limitId, limitName, usedPercent, observedAt) => ({
    observedAt, limitId, limitName, plan: 'pro', partial: true,
    windows: [{ key: 'primary', label: 'weekly', reported: true, usedPercent, resetsAt: NOW + 6 * 86400000 }],
  });

  // A meter must be able to name the bucket it measured.
  const p = normalizeCodexObservation(row('codex_bengalfox', 'GPT-5.3-Codex-Spark', 0, NOW), NOW);
  assert.equal(p.limitId, 'codex_bengalfox');
  assert.equal(p.poolLabel, 'GPT-5.3-Codex-Spark');
  assert.equal(p.poolChanged, false);

  // limit_name null (the historical 'codex' pool) => fall back to the id, never blank.
  assert.equal(normalizeCodexObservation(row('codex', null, 4, NOW), NOW).poolLabel, 'codex');

  // Neither present => no pool claim at all, rather than a fabricated one.
  assert.equal(normalizeCodexObservation(row(null, null, 4, NOW), NOW).poolLabel, null);

  // The switch itself: comparing 0% in a NEW bucket against 4% in the OLD one is not a
  // decrease in usage, it is a change of subject. The provider must say so.
  const switched = normalizeCodexObservation(
    row('codex_bengalfox', 'GPT-5.3-Codex-Spark', 0, NOW), NOW, { previousLimitId: 'codex' });
  assert.equal(switched.poolChanged, true);
  assert.equal(switched.previousLimitId, 'codex');

  // Same pool as before is NOT a switch.
  assert.equal(normalizeCodexObservation(row('codex', null, 5, NOW), NOW,
    { previousLimitId: 'codex' }).poolChanged, false);

  // Unknown previous pool must not manufacture a switch on first observation.
  assert.equal(normalizeCodexObservation(row('codex', null, 5, NOW), NOW,
    { previousLimitId: null }).poolChanged, false);
});

test('stale fallback keeps the pool label attached to the numbers it belongs to', () => {
  // A fallback re-serves the last good observation when the live read fails. The percentage
  // and the pool it was measured against must travel together: re-showing "weekly 0%" without
  // "GPT-5.3-Codex-Spark" would recreate exactly the ambiguity this change removes.
  const good = normalizeCodexObservation({
    observedAt: NOW - 1000, limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark',
    plan: 'pro', partial: true,
    windows: [{ key: 'primary', label: 'weekly', reported: true, usedPercent: 0, resetsAt: NOW + 86400000 }],
  }, NOW);
  const fb = staleFallback(good, NOW);
  assert.equal(fb.fallback, true);
  assert.equal(fb.state, 'stale');
  assert.equal(fb.poolLabel, 'GPT-5.3-Codex-Spark');
  assert.equal(fb.limitId, 'codex_bengalfox');
  // An unavailable provider has nothing to fall back to — must stay null, not synthesize a pool.
  assert.equal(staleFallback({ state: 'unavailable' }, NOW), null);
});

test('Codex selector covers timestamp, mtime, lexical-path, and later-offset ties', () => {
  const base = { observedAt: 10, fileMtime: 20, filePath: '/b', byteOffset: 30 };
  assert.equal(selectCodexObservation([base, { ...base, observedAt: 11 }]).observedAt, 11);
  assert.equal(selectCodexObservation([base, { ...base, fileMtime: 21 }]).fileMtime, 21);
  assert.equal(selectCodexObservation([base, { ...base, filePath: '/a' }]).filePath, '/a');
  assert.equal(selectCodexObservation([base, { ...base, byteOffset: 31 }]).byteOffset, 31);
});

test('Codex normalization reports stale, reset-passed, and not-reported truthfully', () => {
  const p = normalizeCodexObservation({ observedAt: NOW - STALE_MS - 1, plan: 'pro', partial: true, windows: [
    { key: 'primary', label: 'weekly', reported: true, usedPercent: 19, resetsAt: NOW - 1 },
    { key: 'secondary', label: 'secondary', reported: false },
  ] }, NOW);
  assert.equal(p.state, 'stale');
  assert.equal(p.windows[0].state, 'reset-passed');
  assert.equal(p.windows[1].state, 'not-reported');
  assert.equal(p.windows[0].usedPercent, 19);
});

test('whole-provider fallback is stale and never fills missing windows', () => {
  const source = normalizeClaudeObservation(claude({ scopedPct: null }), NOW);
  const fb = staleFallback(source, NOW + 1000);
  assert.equal(fb.fallback, true);
  assert.equal(fb.state, 'stale');
  assert.equal(fb.windows[2].state, 'not-reported');
  assert.ok(!Object.hasOwn(fb.windows[2], 'usedPercent'));
});

test('bounded Codex discovery does not inspect the 17th-newest rollout', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-account-usage-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const day = path.join(home, '.codex', 'sessions', '2026', '07', '20');
  fs.mkdirSync(day, { recursive: true });
  for (let i = 0; i < MAX_CODEX_FILES + 1; i++) {
    const file = path.join(day, `rollout-${String(i).padStart(2, '0')}.jsonl`);
    const valid = i === 0 ? codexLine({ rate: { plan_type: 'pro', primary: { used_percent: 77, window_minutes: 10080 } } }) + '\n' : '{truncated\n';
    fs.writeFileSync(file, valid);
    const stamp = new Date(NOW + i * 1000); fs.utimesSync(file, stamp, stamp);
  }
  const out = await createAccountUsageReader({ home, now: () => NOW + 999999 }).refresh();
  assert.equal(out.codex.state, 'unavailable');
  assert.match(out.codex.absence, /bounded discovery/);
});

test('reader returns only the whitelisted aggregate/provider/window fields', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-account-shape-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, '.cache', 'claude-usage-guard', 'oauth-cache.json');
  fs.mkdirSync(path.dirname(state), { recursive: true }); fs.writeFileSync(state, JSON.stringify(claude()));
  const out = await createAccountUsageReader({ home, now: () => NOW }).refresh();
  assert.deepEqual(Object.keys(out).sort(), ['claude', 'codex', 'generatedAt']);
  assert.deepEqual(Object.keys(out.claude).sort(), ['absence', 'expiresAt', 'fallback', 'observedAt', 'partial', 'plan', 'state', 'windows']);
  for (const w of out.claude.windows) {
    assert.ok(Object.keys(w).every((k) => ['key', 'label', 'state', 'usedPercent', 'resetsAt'].includes(k)));
  }
  assert.doesNotMatch(JSON.stringify(out), /\.cache|\.codex|credentials|error/i);
});

test('usage strip renders the quota-pool label with a pool: prefix (not a bare model-like name)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'terminal-ui.js'), 'utf8');
  assert.match(src, /title="quota pool reported by the provider">pool: ' \+ esc\(p\.poolLabel\)/,
    'a bare limit_name like "GPT-5.3-Codex-Spark" reads as the session model; the prefix disambiguates');
});
