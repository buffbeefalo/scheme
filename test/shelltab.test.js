'use strict';

// Plain-terminal ("shell") runtime lane — 2026-07-16 runtime-picker design.
// A shell tab is the detached tmux login shell itself: NO launch line is ever typed into the
// pane, no uuid is minted, and reboot-resume recreates it as a fresh shell in the same cwd.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Same isolation posture as closetab.test.js: permissive admission bounds (this box may sit at
// the real cap), a throwaway registry file, and a PRIVATE tmux socket so nothing here can ever
// surface in the live Command Deck (its server only reads the default socket).
process.env.SYSMON_MAX_SESSIONS = '9999';
process.env.SYSMON_MEM_FLOOR_MB = '0';
process.env.COMMAND_DECK_REGISTRY = path.join(os.tmpdir(), `cd-shelltab-test-${process.pid}.json`);
process.env.SYSMON_TMUX_SOCKET = 'cdtest';

const terminal = require('../lib/terminal');
const registry = require('../lib/registry');

const INTEGRATION = process.env.SYSMON_INTEGRATION === '1';
const integrationOpts = { skip: INTEGRATION ? false : 'set SYSMON_INTEGRATION=1 to run (spawns a real tmux session)' };

const tmux = (args) => new Promise((resolve) => {
  execFile('tmux', ['-L', 'cdtest', ...args], (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
const psChildren = (pid) => new Promise((resolve) => {
  execFile('ps', ['--ppid', String(pid), '-o', 'pid='], (err, stdout) => resolve(String(stdout || '').trim()));
});

test('createSession refuses shell+codex and shell+local (one runtime per tab, nothing spawned)', async () => {
  for (const combo of [{ shell: true, codex: true }, { shell: true, local: true }]) {
    const r = await terminal.createSession({ label: 'zz shell exclusivity', cwd: '/tmp', ...combo });
    try {
      assert.equal(r.ok, false, `shell+${combo.codex ? 'codex' : 'local'} must refuse`);
      assert.match(String(r.error || ''), /one runtime/i);
    } finally {
      // Red-phase insurance: if a buggy implementation DID spawn, retire it so nothing leaks
      // (private socket regardless — invisible to the live server).
      if (r && r.ok && r.session) await terminal.killSession(r.session.id);
    }
  }
});

test('integration: shell tab is a bare shell — marker set, no launch line typed, no child process; reboot-resume revives it as shell', integrationOpts, async (t) => {
  // Non-"zz " label ON PURPOSE: parseSessions drops zz-labeled sessions (ephemeral filter), and
  // this test asserts THROUGH the parsed listing. The private socket is the leak guard here.
  const created = await terminal.createSession({ label: 'shelltab probe', cwd: '/tmp', shell: true });
  if (!created || !created.ok) return t.skip('tmux unavailable');
  const id = created.session.id;
  try {
    assert.equal(created.session.shell, true, 'create response carries the runtime');
    assert.equal(created.session.uuid, undefined, 'no conversation uuid is minted for a shell tab');

    const live = (await terminal.listSessions()).find((s) => s.id === id);
    assert.ok(live, 'session listed');
    assert.equal(live.shell, true, '@cd_shell round-trips through real tmux');
    assert.equal(live.local, false);
    assert.equal(live.codex, false);

    // The pane is the login shell itself: nothing was typed into it (no launch line in the
    // scrollback) and it has spawned nothing.
    const cap = await tmux(['capture-pane', '-p', '-t', id]);
    assert.ok(!/env -u|claude|codex/.test(cap.stdout), `no launch line typed into the pane, got: ${cap.stdout.slice(0, 200)}`);
    if (live.panePid) {
      assert.equal(await psChildren(live.panePid), '', 'bare shell has no child process');
    }

    // Reboot-resume semantics: kill ONLY tmux (registry entry survives, as after a real reboot),
    // then resumeSession must revive it as a shell tab again — fresh shell, same cwd, marker intact.
    const saved = registry.readAll().find((s) => s.id === id);
    assert.ok(saved && saved.shell === true, 'registry persisted shell:true');
    await tmux(['kill-session', '-t', id]);
    const up = await terminal.resumeSession(saved);
    assert.equal(up.ok, true, 'resume revives the tab');
    const revived = (await terminal.listSessions()).find((s) => s.id === id);
    assert.ok(revived && revived.shell === true, 'revived tab is still a shell tab');
    const cap2 = await tmux(['capture-pane', '-p', '-t', id]);
    assert.ok(!/env -u|claude|codex/.test(cap2.stdout), 'resume typed no launch line either');
  } finally {
    await terminal.killSession(id);   // insurance: an assertion throw must never leak the session
  }
});
