'use strict';

// Codex reboot-resume must re-stamp @cd_codex_uuid on the REVIVED tmux session — 2026-07-16 live
// E2E finding: the marker died with the killed session, so live-tmux-fed telemetry went blind
// (model/meter/window all null) even though the conversation resumed fine. The backfill cannot
// rescue it either: findCodexSessionUuid skips rollouts with mtime older than the tab's creation,
// and a just-revived tab is NEWER than its own rollout's last write — only the registry still knew
// the uuid. Re-stamping at bringUp closes the gap at the source.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Same isolation posture as shelltab.test.js/closetab.test.js: permissive admission bounds, a
// throwaway registry file, and a PRIVATE tmux socket so nothing here surfaces in live Command Deck.
process.env.SYSMON_MAX_SESSIONS = '9999';
process.env.SYSMON_MEM_FLOOR_MB = '0';
process.env.COMMAND_DECK_REGISTRY = path.join(os.tmpdir(), `cd-codexresume-test-${process.pid}.json`);
process.env.SYSMON_TMUX_SOCKET = 'cdtest';

const terminal = require('../lib/terminal');

const INTEGRATION = process.env.SYSMON_INTEGRATION === '1';
const integrationOpts = { skip: INTEGRATION ? false : 'set SYSMON_INTEGRATION=1 to run (spawns a real tmux session)' };

const tmux = (args) => new Promise((resolve) => {
  execFile('tmux', ['-L', 'cdtest', ...args], (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

test('autonomous Claude resume refuses a vanished cwd before tmux spawn', async () => {
  const r = await terminal.resumeSession({
    id: 'cdautocwd', label: 'autonomous cwd probe', cwd: path.join(os.tmpdir(), `cd-autonomous-missing-${process.pid}`),
    uuid: '11111111-1111-1111-1111-111111111111', autonomous: true,
  });
  assert.deepEqual(r, { ok: false, reason: 'autonomous-cwd-missing' });
});

test('integration: autonomous Claude resume re-stamps marker, skip-permissions, and token scrub', integrationOpts, async (t) => {
  const id = `cdautoresume${Date.now().toString(36)}`;
  const normalId = `cdnormalresume${Date.now().toString(36)}`;
  const uuid = '22222222-2222-2222-2222-222222222222';
  try {
    const up = await terminal.resumeSession({ id, label: 'autonomous resume probe', cwd: '/tmp', uuid, autonomous: true });
    if (!up.ok) return t.skip('tmux unavailable');
    const revived = (await terminal.listSessions()).find((s) => s.id === id);
    assert.ok(revived && revived.autonomous, 'revived tab carries @cd_autonomous');
    const cap = await tmux(['capture-pane', '-p', '-J', '-S', '-', '-t', id]);   // -J joins soft-wrapped lines so pane width can't split the flag
    assert.match(cap.stdout, /--dangerously-skip-permissions/, 'resume launch carries skip-permissions');
    assert.match(cap.stdout, /-u COMMAND_DECK_AUTONOMOUS_TOKEN/, 'autonomous resume scrubs the mint-token');
    const normal = await terminal.resumeSession({ id: normalId, label: 'normal resume probe', cwd: '/tmp', uuid });
    assert.ok(normal.ok, 'normal Claude resume starts');
    const normalCap = await tmux(['capture-pane', '-p', '-J', '-S', '-', '-t', normalId]);
    assert.doesNotMatch(normalCap.stdout, /COMMAND_DECK_AUTONOMOUS_TOKEN/, 'normal Claude resume stays unsanitized');
  } finally {
    await terminal.killSession(id);
    await terminal.killSession(normalId);
  }
});

test('integration: codex reboot-resume re-stamps @cd_codex_uuid (telemetry reads live tmux, not the registry)', integrationOpts, async (t) => {
  // Non-"zz " label ON PURPOSE: the assertion goes THROUGH listSessions — the same parsed view
  // telemetry reads — and parseSessions drops zz-labeled sessions. Private socket = leak guard.
  const uuid = '019f0000-dead-beef-aaaa-0123456789ab';
  const created = await terminal.createSession({ label: 'codexresume probe', cwd: '/tmp', codex: true });
  if (!created || !created.ok) return t.skip('tmux unavailable');
  const id = created.session.id;
  try {
    // Simulate a reboot: tmux dies; the registry entry (which captured the uuid on turn one)
    // survives. The saved shape mirrors what resumeSaved hands resumeSession.
    await tmux(['kill-session', '-t', id]);
    const up = await terminal.resumeSession({ id, label: 'codexresume probe', cwd: '/tmp', codex: true, codexUuid: uuid, createdAt: Date.now() });
    assert.equal(up.ok, true, 'resume revives the tab');
    const revived = (await terminal.listSessions()).find((s) => s.id === id);
    assert.ok(revived && revived.codex === true, 'revived tab is codex');
    assert.equal(revived.codexUuid, uuid,
      'revived session carries @cd_codex_uuid again — without it the rail is blind until the next turn');
  } finally {
    await terminal.killSession(id);   // insurance: an assertion throw must never leak the session
  }
});
