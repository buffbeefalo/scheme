'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findLiveCodexUuid, isResumableCodexUuid } = require('../lib/codex-telemetry');

const main = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const procRoot = path.join(root, 'proc');
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir);
  function process(pid, executable, children = []) {
    const dir = path.join(procRoot, String(pid));
    fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), children.join(' '));
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${executable}) S ${Array(18).fill('0').join(' ')} 12345\n`);
    fs.symlinkSync(`/usr/bin/${executable}`, path.join(dir, 'exe'));
  }
  function rollout(pid, id, meta = {}, dir = sessionsDir) {
    const file = path.join(dir, `rollout-2026-09-06T02-02-01-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: {
      id, cwd: '/old-project', timestamp: '2026-09-06T09:02:01.403Z', source: 'cli', thread_source: 'user', ...meta,
    } }) + '\n');
    fs.symlinkSync(file, path.join(procRoot, String(pid), 'fd', id));
  }
  return { root, procRoot, sessionsDir, process, rollout };
}

test('live identity follows the pane process, including an older manually resumed conversation', t => {
  const f = fixture(t);
  f.process(100, 'bash', [101]); f.process(101, 'codex', [102]); f.process(102, 'codex');
  f.process(200, 'codex');
  f.rollout(101, main);
  f.rollout(101, child, { source: { subagent: { thread_spawn: { parent_thread_id: main } } }, thread_source: 'subagent' });
  f.rollout(102, other); f.rollout(200, other);
  assert.equal(findLiveCodexUuid(100, f), main, 'nested Codex tools and neighboring panes cannot steal the binding');
});

test('live identity refuses ambiguity and files outside the configured session store', t => {
  const f = fixture(t);
  f.process(100, 'codex');
  f.rollout(100, main); f.rollout(100, other);
  assert.equal(findLiveCodexUuid(100, f), null);
  fs.unlinkSync(path.join(f.procRoot, '100', 'fd', other));
  fs.unlinkSync(path.join(f.procRoot, '100', 'fd', main));
  f.rollout(100, main, {}, f.root);
  assert.equal(findLiveCodexUuid(100, f), null);
  assert.equal(findLiveCodexUuid(99999, f), null);
  assert.equal(findLiveCodexUuid('../outside', f), null);
});

test('stored recovery accepts CLI roots and refuses spawned, unknown, and mismatched identities', t => {
  const f = fixture(t);
  f.process(100, 'codex');
  f.rollout(100, main);
  assert.equal(isResumableCodexUuid(main, f.sessionsDir), true);
  const file = path.join(f.sessionsDir, `rollout-2026-09-06T02-02-01-${main}.jsonl`);
  for (const meta of [
    { source: { subagent: { thread_spawn: { parent_thread_id: other } } } },
    { source: 'cli', parent_thread_id: other },
    { source: 'cli', thread_source: 'subagent' },
    { source: 'exec' },
    { source: undefined },
    { source: 'cli', id: other },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: main, ...meta } }) + '\n');
    assert.equal(isResumableCodexUuid(main, f.sessionsDir), false, JSON.stringify(meta));
    assert.equal(findLiveCodexUuid(100, f), null, JSON.stringify(meta));
  }
  assert.equal(isResumableCodexUuid(other, f.sessionsDir), false);
  assert.equal(isResumableCodexUuid('../outside', f.sessionsDir), false);
});
