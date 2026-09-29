'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const terminal = require('../lib/terminal');

const ua = '019f0000-0000-0000-0000-000000000021';
const ub = '019f0000-0000-0000-0000-000000000022';

function makeDeps(records, candidates, options = {}) {
  const writes = [];
  return {
    deps: {
      listCodexSessionCandidates: (opts) => candidates(opts),
      run: async () => ({ ok: true }),
      registry: { readAll: () => records, upsert: (value) => { writes.push(value); return true; } },
      captureWindowMs: options.captureWindowMs == null ? 300000 : options.captureWindowMs,
      nearTieMs: options.nearTieMs == null ? 1000 : options.nearTieMs,
    },
    writes,
  };
}

test('backfill binds distinct same-cwd tabs and patches the live session snapshot', async () => {
  const sessions = [
    { id: 'cda', codex: true, cwd: '/proj', createdAt: 1000000 },
    { id: 'cdb', codex: true, cwd: '/proj', createdAt: 1004000 },
  ];
  const { deps, writes } = makeDeps(sessions.map((s) => ({ id: s.id, createdAt: s.createdAt })), ({ claimed }) => [
    { uuid: ua, startMs: 1000500 }, { uuid: ub, startMs: 1004500 },
  ].filter((c) => !claimed.has(c.uuid)));
  assert.equal(await terminal.backfillCodexUuid(sessions[0], sessions, deps), ua);
  assert.equal(sessions[0].codexUuid, ua, 'the listSessions snapshot is patched before the next iteration');
  assert.equal(await terminal.backfillCodexUuid(sessions[1], sessions, deps), ub);
  assert.equal(sessions[1].codexUuid, ub);
  assert.deepEqual(writes.map((w) => w.codexUuid), [ua, ub]);
});

test('backfill defers a partial arrival until the nearer sibling can bind, then binds the remaining tab', async () => {
  const sessions = [
    { id: 'cda', codex: true, cwd: '/proj', createdAt: 2000000 },
    { id: 'cdb', codex: true, cwd: '/proj', createdAt: 2001000 },
  ];
  let available = [{ uuid: ub, startMs: 2001000 }];
  const { deps } = makeDeps(sessions.map((s) => ({ id: s.id, createdAt: s.createdAt })), ({ claimed }) => available.filter((c) => !claimed.has(c.uuid)));
  assert.equal(await terminal.backfillCodexUuid(sessions[0], sessions, deps), null, 'A cannot steal B\'s sole rollout');
  assert.equal(await terminal.backfillCodexUuid(sessions[1], sessions, deps), ub);
  available = [{ uuid: ua, startMs: 2000001 }, { uuid: ub, startMs: 2001000 }];
  assert.equal(await terminal.backfillCodexUuid(sessions[0], sessions, deps), ua);
});

test('backfill defers second-resolution cohort ties and launch-jitter near ties', async () => {
  const tied = [
    { id: 'cda', codex: true, cwd: '/proj', createdAt: 3000000 },
    { id: 'cdb', codex: true, cwd: '/proj', createdAt: 3000000 },
  ];
  const tieDeps = makeDeps(tied.map((s) => ({ id: s.id, createdAt: s.createdAt })), () => [{ uuid: ua, startMs: 3000100 }]).deps;
  assert.equal(await terminal.backfillCodexUuid(tied[0], tied, tieDeps), null, 'whole-second anchors are an exact mutual-nearest tie');

  const one = [{ id: 'cda', codex: true, cwd: '/proj', createdAt: 4000000 }];
  const jitterDeps = makeDeps(one.map((s) => ({ id: s.id, createdAt: s.createdAt })), () => [
    { uuid: ua, startMs: 4000100 }, { uuid: ub, startMs: 4000600 },
  ], { nearTieMs: 500 }).deps;
  assert.equal(await terminal.backfillCodexUuid(one[0], one, jitterDeps), null, 'two launch-jitter candidates inside epsilon defer');
});

test('backfill uses the pre-launch anchor, rejects far old candidates, and accepts a single nearby tab', async () => {
  const source = fs.readFileSync(require.resolve('../lib/terminal'), 'utf8');
  assert.ok(source.indexOf('const createdAt = Date.now();') < source.indexOf('const up = await bringUp('), 'createdAt precedes bringUp/send-keys');
  const session = { id: 'cda', codex: true, cwd: '/proj', createdAt: 5000000 };
  let seenSince = null;
  const near = makeDeps([{ id: session.id, createdAt: session.createdAt }], (opts) => {
    seenSince = opts.sinceMs;
    return [{ uuid: ua, startMs: 5000500 }];
  }).deps;
  assert.equal(await terminal.backfillCodexUuid(session, [session], near), ua);
  assert.equal(seenSince, 5000000, 'a rollout before the post-bringUp time remains eligible');

  const old = { id: 'cdb', codex: true, cwd: '/proj', createdAt: 6000000 };
  const far = makeDeps([{ id: old.id, createdAt: old.createdAt }], () => [{ uuid: ub, startMs: 5600000 }], { captureWindowMs: 300000 }).deps;
  assert.equal(await terminal.backfillCodexUuid(old, [old], far), null, 'a sole old, mtime-bumped candidate is outside the acceptance window');
});

test('a live pane repairs a stale binding from its actual process instead of a nearby rollout', async () => {
  const session = { id: 'cda', codex: true, cwd: '/proj', panePid: 1234, codexUuid: ub, createdAt: 5000000 };
  const { deps, writes } = makeDeps([{ ...session }], () => { assert.fail('a live pane must not use timing guesses'); });
  deps.findLiveCodexUuid = pid => { assert.equal(pid, 1234); return ua; };
  assert.equal(await terminal.backfillCodexUuid(session, [session], deps), ua);
  assert.equal(session.codexUuid, ua);
  assert.deepEqual(writes, [{ id: 'cda', codexUuid: ua }]);
});

test('an unidentified live pane waits without claiming another conversation', async () => {
  const session = { id: 'cda', codex: true, cwd: '/proj', panePid: 1234, createdAt: 5000000 };
  const { deps, writes } = makeDeps([{ ...session }], () => { assert.fail('must not fall back to timing'); });
  deps.findLiveCodexUuid = () => null;
  assert.equal(await terminal.backfillCodexUuid(session, [session], deps), null);
  assert.deepEqual(writes, []);
});

test('a failed tmux binding never changes the registry or live snapshot', async () => {
  const session = { id: 'cda', codex: true, cwd: '/proj', panePid: 1234, createdAt: 5000000 };
  const { deps, writes } = makeDeps([{ ...session }], () => []);
  deps.findLiveCodexUuid = () => ua;
  deps.run = async () => ({ ok: false });
  assert.equal(await terminal.backfillCodexUuid(session, [session], deps), null);
  assert.equal(session.codexUuid, undefined);
  assert.deepEqual(writes, []);
});

test('a registry failure remains retryable and never reports a persisted binding', async () => {
  const session = { id: 'cda', codex: true, cwd: '/proj', panePid: 1234, codexUuid: ub };
  const { deps } = makeDeps([{ ...session }], () => []);
  deps.findLiveCodexUuid = () => ua;
  deps.registry.upsert = () => false;
  assert.equal(await terminal.backfillCodexUuid(session, [session], deps), null);
  assert.equal(session.codexUuid, ub);
  deps.registry.upsert = () => true;
  assert.equal(await terminal.backfillCodexUuid(session, [session], deps), ua);
  assert.equal(session.codexUuid, ua);
});
