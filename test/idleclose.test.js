'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_HOURS, HOUR_MS, thresholdMs, lastRecordTs, effectiveActivity, decide, selectStale, createIdleCloser,
} = require('../lib/idleclose');

const NOW = Date.parse('2026-08-11T08:00:00.000Z');
const H = (n) => n * HOUR_MS;
const THRESH = H(48);
const claudeTab = (over = {}) => ({ id: 'cdaaa', name: 'tab', cwd: '/home/you', uuid: 'u-1', createdAt: NOW - H(500), ...over });
const awake = { working: false, needsInput: false, needsInputKind: null, waitingOnBackground: false, lastTurnId: 't' };
// Idle by every input: nothing since 100h ago, and no reboot-revival stamp to rescue it.
const staleCtx = (over = {}) => ({ light: awake, tmuxInfo: { activity: NOW - H(100), created: NOW - H(300) }, convTs: NOW - H(100), now: NOW, threshold: THRESH, ...over });

// ---- thresholdMs -----------------------------------------------------------
test('thresholdMs defaults to 48h and honours an explicit value', () => {
  assert.equal(thresholdMs({}), H(DEFAULT_HOURS));
  assert.equal(thresholdMs({ COMMAND_DECK_IDLE_CLOSE_HOURS: '' }), H(48));
  assert.equal(thresholdMs({ COMMAND_DECK_IDLE_CLOSE_HOURS: '2' }), H(2));
  assert.equal(thresholdMs({ COMMAND_DECK_IDLE_CLOSE_HOURS: '0.5' }), H(0.5));
});

test('thresholdMs disables on 0/negative/garbage — an unparseable knob never means 48', () => {
  for (const v of ['0', '-1', 'off', 'NaN', 'forty-eight']) {
    assert.equal(thresholdMs({ COMMAND_DECK_IDLE_CLOSE_HOURS: v }), 0, `expected ${v} to disable`);
  }
});

// ---- lastRecordTs ----------------------------------------------------------
test('lastRecordTs takes the NEWEST stamp in the tail, parsed as UTC', () => {
  const tail = [
    '{"type":"user","timestamp":"2026-08-09T11:25:05.203Z"}',
    '{"type":"assistant","timestamp":"2026-08-10T23:59:00.000Z"}',
    '{"type":"system","timestamp":"2026-08-10T22:00:00.000Z"}',
  ].join('\n');
  assert.equal(lastRecordTs(tail), Date.parse('2026-08-10T23:59:00.000Z'));
});

test('lastRecordTs returns null when the tail carries no parseable stamp', () => {
  assert.equal(lastRecordTs(''), null);
  assert.equal(lastRecordTs(null), null);
  assert.equal(lastRecordTs('{"type":"system"}\nnot json at all'), null);
  assert.equal(lastRecordTs('{"timestamp":"never"}'), null);
});

// ---- effectiveActivity -----------------------------------------------------
test('effectiveActivity takes the max of the conversation clock and real interaction', () => {
  assert.equal(effectiveActivity({ convTs: 100, sessionActivity: 500, sessionCreated: 10, createdAt: 1 }), 500);
  assert.equal(effectiveActivity({ convTs: 900, sessionActivity: 500, sessionCreated: 10, createdAt: 1 }), 900);
});

test('effectiveActivity ignores the reboot-revival stamp (activity === created)', () => {
  // A revived tab gets activity===created at boot. Trusting it would hand every stale tab a
  // fresh 48h lease after each reboot; the transcript clock must win.
  assert.equal(effectiveActivity({ convTs: 100, sessionActivity: 9000, sessionCreated: 9000, createdAt: 1 }), 100);
  // One second of real interaction after revival is real, and does count.
  assert.equal(effectiveActivity({ convTs: 100, sessionActivity: 9001, sessionCreated: 9000, createdAt: 1 }), 9001);
});

test('effectiveActivity floors at registry createdAt, and is null with no evidence at all', () => {
  assert.equal(effectiveActivity({ convTs: null, sessionActivity: null, createdAt: 42 }), 42);
  assert.equal(effectiveActivity({}), null);
});

// ---- decide: the guards ----------------------------------------------------
test('decide reaps an agent tab idle past the threshold', () => {
  const d = decide(claudeTab(), staleCtx());
  assert.equal(d.reap, true);
  assert.equal(d.reason, 'idle');
  assert.equal(d.idleMs, H(100));
});

test('decide keeps a tab that is still working', () => {
  const d = decide(claudeTab(), staleCtx({ light: { ...awake, working: true } }));
  assert.equal(d.reap, false);
  assert.equal(d.reason, 'working');
});

test('decide NEVER closes a tab asking for follow-up, however long it has waited', () => {
  const forever = staleCtx({ light: { ...awake, needsInput: true, needsInputKind: 'question' }, convTs: NOW - H(5000), tmuxInfo: { activity: NOW - H(5000), created: NOW - H(6000) } });
  const d = decide(claudeTab(), forever);
  assert.equal(d.reap, false);
  assert.equal(d.reason, 'needs-input');
});

test('decide keeps a tab waiting on a background task', () => {
  assert.equal(decide(claudeTab(), staleCtx({ light: { ...awake, waitingOnBackground: true } })).reason, 'waiting-on-background');
});

test('decide fails closed with no lights evidence', () => {
  assert.equal(decide(claudeTab(), staleCtx({ light: undefined })).reason, 'no-lights');
  assert.equal(decide(claudeTab(), staleCtx({ light: { err: true } })).reason, 'no-lights');
  assert.equal(decide(claudeTab(), staleCtx({ light: undefined })).reap, false);
});

test('decide keeps a tab with conflicting runtime markers', () => {
  assert.equal(decide(claudeTab({ local: true, codex: true }), staleCtx()).reason, 'runtime-conflict');
});

test('decide keeps a fresh tab, and the boundary is inclusive', () => {
  const fresh = staleCtx({ convTs: NOW - H(47), tmuxInfo: { activity: NOW - H(47), created: NOW - H(300) } });
  assert.equal(decide(claudeTab(), fresh).reap, false);
  assert.equal(decide(claudeTab(), fresh).reason, 'fresh');
  const exact = staleCtx({ convTs: NOW - THRESH, tmuxInfo: { activity: NOW - THRESH, created: NOW - H(300) } });
  assert.equal(decide(claudeTab(), exact).reap, true);
});

test('decide keeps everything when the reaper is disabled', () => {
  assert.equal(decide(claudeTab(), staleCtx({ threshold: 0 })).reason, 'disabled');
});

test('a stale conversation is kept alive by recent human interaction', () => {
  // The measured case: a tab whose conversation died 12 days ago but that the user clicked into
  // 40 minutes ago. "No activity from me OR it" — he counts.
  const looked = staleCtx({ convTs: NOW - H(288), tmuxInfo: { activity: NOW - H(0.7), created: NOW - H(300) } });
  assert.equal(decide(claudeTab(), looked).reap, false);
});

test('a detached tab streaming output is kept by its conversation clock alone', () => {
  // The courses-v4 case: tmux interaction is 33h old, but the transcript moved a minute ago.
  const streaming = staleCtx({ convTs: NOW - H(0.02), tmuxInfo: { activity: NOW - H(33), created: NOW - H(300) } });
  assert.equal(decide(claudeTab(), streaming).reap, false);
});

// ---- decide: shell tabs ----------------------------------------------------
test('shell tab at a plain prompt reaps on interaction age; a busy shell never does', () => {
  const shell = claudeTab({ shell: true, uuid: null });
  const ctx = staleCtx({ light: undefined, convTs: null });
  assert.equal(decide(shell, { ...ctx, paneCmd: 'bash' }).reap, true);
  assert.equal(decide(shell, { ...ctx, paneCmd: 'node' }).reason, 'shell-busy');
  assert.equal(decide(shell, { ...ctx, paneCmd: null }).reason, 'shell-busy');
});

// ---- selectStale -----------------------------------------------------------
test('selectStale returns only reapable tabs, oldest first, with resume metadata', () => {
  const sessions = [
    claudeTab({ id: 'cdfresh', uuid: 'u-fresh' }),
    claudeTab({ id: 'cdold', name: 'old', uuid: 'u-old' }),
    claudeTab({ id: 'cdoldest', name: 'oldest', uuid: 'u-oldest' }),
    claudeTab({ id: 'cdasking', uuid: 'u-ask' }),
  ];
  const stale = selectStale(sessions, {
    lights: { cdfresh: awake, cdold: awake, cdoldest: awake, cdasking: { ...awake, needsInput: true } },
    tmux: {
      cdfresh: { activity: NOW - H(1), created: NOW - H(300) },
      cdold: { activity: NOW - H(60), created: NOW - H(300) },
      cdoldest: { activity: NOW - H(200), created: NOW - H(300) },
      cdasking: { activity: NOW - H(400), created: NOW - H(500) },
    },
    convTs: { cdfresh: NOW - H(1), cdold: NOW - H(60), cdoldest: NOW - H(200), cdasking: NOW - H(400) },
    now: NOW, threshold: THRESH,
  });
  assert.deepEqual(stale.map((s) => s.id), ['cdoldest', 'cdold']);
  assert.equal(stale[0].uuid, 'u-oldest');
  assert.equal(stale[0].runtime, 'claude');
});

// ---- sweep -----------------------------------------------------------------
function harness(over = {}) {
  const events = [];
  const deps = {
    listSessions: async () => [claudeTab({ id: 'cdold', name: 'old' })],
    tmuxActivity: async () => ({ cdold: { activity: NOW - H(100), created: NOW - H(300) } }),
    readTail: async () => `{"timestamp":"${new Date(NOW - H(100)).toISOString()}"}`,
    transcriptFor: () => '/tmp/t.jsonl',
    killSession: async (id) => { events.push(['kill', id]); return { ok: true }; },
    audit: (e) => events.push(['audit', e.action, e.target, e.ok]),
    ledger: (e) => events.push(['ledger', e.id, e.uuid, e.idleHours]),
    now: () => NOW,
    env: {},
    ...over,
  };
  return { deps, events, closer: createIdleCloser(deps) };
}

test('sweep closes a stale tab, ledgering it BEFORE the kill', async () => {
  const h = harness();
  const r = await h.closer.sweep({ cdold: awake });
  assert.deepEqual(r.closed.map((c) => c.id), ['cdold']);
  assert.deepEqual(h.events, [
    ['ledger', 'cdold', 'u-1', 100],
    ['kill', 'cdold'],
    ['audit', 'term:autoclose', 'cdold', true],
  ]);
});

test('sweep reports how many sessions it scanned, so a quiet reaper is distinguishable from a dead one', async () => {
  const h = harness({
    listSessions: async () => [claudeTab({ id: 'cda' }), claudeTab({ id: 'cdb' })],
    tmuxActivity: async () => ({ cda: { activity: NOW - H(1), created: NOW - H(300) }, cdb: { activity: NOW - H(1), created: NOW - H(300) } }),
    readTail: async () => '',
  });
  const r = await h.closer.sweep({ cda: awake, cdb: awake });
  assert.equal(r.scanned, 2);
  assert.deepEqual(r.closed, []);
  assert.equal((await harness({ env: { COMMAND_DECK_IDLE_CLOSE_HOURS: '0' } }).closer.sweep({})).scanned, 0);
});

test('a tab with no tmux row is kept — half a clock is not evidence', () => {
  // Measured case: conversation 287h idle, but the human clicked in an hour ago. Without the
  // tmux half we would only see the 287h and close a tab in active use.
  const d = decide(claudeTab(), staleCtx({ tmuxInfo: {}, convTs: NOW - H(287) }));
  assert.equal(d.reap, false);
  assert.equal(d.reason, 'no-tmux-activity');
});

test('sweep stands down entirely when the tmux read fails or comes back empty', async () => {
  for (const tmuxActivity of [async () => ({}), async () => { throw new Error('EAGAIN'); }]) {
    const h = harness({ tmuxActivity });
    const r = await h.closer.sweep({ cdold: awake });
    assert.equal(r.skipped, 'no-tmux-activity');
    assert.deepEqual(h.events, []);
  }
});

test('sweep kills nothing when the lights map is missing — no evidence, no reaping', async () => {
  for (const lights of [undefined, null, 'nope']) {
    const h = harness();
    const r = await h.closer.sweep(lights);
    assert.equal(r.skipped, 'no-lights-map');
    assert.deepEqual(h.events, []);
  }
});

test('sweep is a no-op when disabled by env', async () => {
  const h = harness({ env: { COMMAND_DECK_IDLE_CLOSE_HOURS: '0' } });
  const r = await h.closer.sweep({ cdold: awake });
  assert.equal(r.skipped, 'disabled');
  assert.deepEqual(h.events, []);
});

test('dry-run reports the tab but never kills or ledgers it', async () => {
  const h = harness({ env: { COMMAND_DECK_IDLE_CLOSE_DRY: '1' } });
  const r = await h.closer.sweep({ cdold: awake });
  assert.deepEqual(r.closed.map((c) => [c.id, c.dry]), [['cdold', true]]);
  assert.deepEqual(h.events, []);
});

test('an unreadable transcript keeps the tab when nothing else is stale enough', async () => {
  // Fail-closed: the read throws, so convTs is null and only interaction remains — and here
  // interaction is recent, so the tab survives rather than being reaped on missing evidence.
  const h = harness({
    readTail: async () => { throw new Error('EACCES'); },
    tmuxActivity: async () => ({ cdold: { activity: NOW - H(2), created: NOW - H(300) } }),
  });
  const r = await h.closer.sweep({ cdold: awake });
  assert.deepEqual(r.closed, []);
  assert.deepEqual(h.events, []);
});

test('a failed kill is audited as a failure and not reported closed', async () => {
  const h = harness({ killSession: async () => ({ ok: false, error: 'nope' }) });
  const r = await h.closer.sweep({ cdold: awake });
  assert.deepEqual(r.closed, []);
  assert.ok(h.events.some((e) => e[0] === 'audit' && e[3] === false));
});

test('sweep survives a listSessions failure without killing anything', async () => {
  const h = harness({ listSessions: async () => { throw new Error('tmux EAGAIN'); } });
  const r = await h.closer.sweep({ cdold: awake });
  assert.equal(r.ok, false);
  assert.deepEqual(h.events, []);
});

// ---- pinned tabs -----------------------------------------------------------
test('decide keeps a pinned tab regardless of idleness', () => {
  assert.deepEqual(decide(claudeTab(), staleCtx({ pinned: true })),
    { reap: false, reason: 'pinned', idleMs: null });
});

test('selectStale honours ctx.pins by uuid and by tab id; unpinned peers still reap', () => {
  const a = claudeTab();                                   // uuid u-1 — pinned by uuid
  const b = claudeTab({ id: 'cdbbb', uuid: 'u-2' });       // pinned by tab id
  const c = claudeTab({ id: 'cdccc', uuid: 'u-3' });       // not pinned — must still reap
  const per = { activity: NOW - H(100), created: NOW - H(300) };
  const ctx = {
    lights: { cdaaa: awake, cdbbb: awake, cdccc: awake },
    tmux: { cdaaa: per, cdbbb: per, cdccc: per },
    convTs: { cdaaa: NOW - H(100), cdbbb: NOW - H(100), cdccc: NOW - H(100) },
    pins: ['u-1', 'cdbbb'],
    now: NOW, threshold: THRESH,
  };
  assert.deepEqual(selectStale([a, b, c], ctx).map((t) => t.id), ['cdccc']);
});
