'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseArgs, guardId, main } = require('../lib/closetab');
const terminal = require('../lib/terminal');
const registry = require('../lib/registry');

// NEW-cmddeck-5: createSession now enforces a live-session cap + memory floor. This box may already
// be at/over the default cap, which would make the create-based integration tests below refuse and
// SKIP as "tmux unavailable". Pin permissive bounds (own test process) so they keep exercising the
// real create+retire path they are here to verify.
process.env.SYSMON_MAX_SESSIONS = '9999';
process.env.SYSMON_MEM_FLOOR_MB = '0';

// Isolate from the LIVE Command Deck — two prod hazards this closes:
//  1) These tests wrote the REAL registry (~/.claude/command-deck/sessions.json), so a
//     "zz closetab selftest" entry left behind by a failed/interrupted retire resurfaced as a real
//     tab: resumeSaved() backfills live tmux AND auto-resumes registry entries on boot. Point the
//     registry at a throwaway file (registry.file() reads this env lazily, per call — safe to set
//     after the require above).
//  2) Each integration test spawns a real `claude --effort max` via tmux. Running that on every
//     `node --test` (including scheduled test runs on a busy host) is both wasteful and
//     the source of the leaked tabs. Gate the two spawning tests behind SYSMON_INTEGRATION=1 so
//     routine runs skip them; run on demand with `SYSMON_INTEGRATION=1 node --test test/closetab.test.js`.
const os = require('node:os');
const path = require('node:path');
process.env.COMMAND_DECK_REGISTRY = path.join(os.tmpdir(), `cd-closetab-test-${process.pid}.json`);
// Isolate every tmux call this test makes onto a PRIVATE socket so the real sessions it spawns
// can never touch the production tmux server. Even if a spawning test is interrupted before its
// finally-kill, the leaked session lives on 'cdtest' — invisible to the live Command Deck server
// (default socket), so it can't be listed as a tab or backfilled/resumed. (terminal.run reads
// SYSMON_TMUX_SOCKET lazily per call, so setting it here — after the require above — takes effect.)
process.env.SYSMON_TMUX_SOCKET = 'cdtest';
const INTEGRATION = process.env.SYSMON_INTEGRATION === '1';
const integrationOpts = { skip: INTEGRATION ? false : 'set SYSMON_INTEGRATION=1 to run (spawns a real claude session)' };

test('parseArgs extracts --id and --after', () => {
  assert.deepEqual(parseArgs(['--id', 'cdabc', '--after', '45']), { id: 'cdabc', after: '45' });
  assert.deepEqual(parseArgs([]), {});
});

test('guardId accepts Command Deck ids only', () => {
  assert.equal(guardId('cdabc123').ok, true);
  assert.equal(guardId('cdabc123').id, 'cdabc123');
  assert.equal(guardId('  cdabc123  ').id, 'cdabc123');
});

test('guardId refuses non-cd session names (personal tmux is off limits)', () => {
  for (const bad of ['main', 'work', 'abcd', '', null, undefined, 'CD-upper']) {
    assert.equal(guardId(bad).ok, false, `should refuse ${String(bad)}`);
  }
});

test('main refuses a bad id without touching tmux', async () => {
  const r = await main(['--id', 'main']);
  assert.equal(r.ok, false);
  assert.match(r.error, /refusing/);
});

test('integration: creates then retires a real session (tmux + registry)', integrationOpts, async (t) => {
  const created = await terminal.createSession({ label: 'zz closetab selftest', cwd: '/tmp' });
  if (!created || !created.ok) return t.skip('tmux unavailable');
  const id = created.session.id;
  try {
    assert.equal(await terminal.hasSession(id), true, 'session should exist after create');

    const r = await main(['--id', id]);
    assert.equal(r.ok, true);
    assert.equal(r.id, id);
    assert.equal(await terminal.hasSession(id), false, 'tmux session should be gone');
    assert.equal(registry.readAll().some((s) => s.id === id), false, 'registry entry should be gone');
  } finally {
    await terminal.killSession(id);   // insurance: a thrown assertion above must never leak the real tmux session
  }
});

test('integration: --after defers the kill', integrationOpts, async (t) => {
  const created = await terminal.createSession({ label: 'zz closetab delay', cwd: '/tmp' });
  if (!created || !created.ok) return t.skip('tmux unavailable');
  const id = created.session.id;
  try {
    const t0 = Date.now();
    const r = await main(['--id', id, '--after', '1']);
    assert.equal(r.ok, true);
    assert.ok(Date.now() - t0 >= 1000, 'kill should be deferred by ~1s');
    assert.equal(await terminal.hasSession(id), false);
  } finally {
    await terminal.killSession(id);   // insurance: a thrown assertion above must never leak the real tmux session
  }
});
