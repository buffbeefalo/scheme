'use strict';

// Scroll must EXIT copy-mode when the user scrolls back to the bottom — 2026-07-16 live incident:
// a pane stuck at `pane_in_mode=1, scroll_position=0` looks live but never updates and eats wheel
// input ("really laggy to scroll"). CD's scrollOp entered PLAIN copy-mode, and tmux's scroll-down
// at the bottom does NOT exit it — exit relied entirely on the client posting a separate 'bottom'
// op, which a race (two browser windows share one tmux session's scroll state) can drop. Entering
// with `copy-mode -e` makes scroll-down-to-bottom exit natively, server-side, race-proof; the
// client's explicit 'bottom' op stays as belt-and-braces.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Same isolation posture as shelltab.test.js: permissive admission bounds, throwaway registry,
// PRIVATE tmux socket so nothing here surfaces in live Command Deck.
process.env.SYSMON_MAX_SESSIONS = '9999';
process.env.SYSMON_MEM_FLOOR_MB = '0';
process.env.COMMAND_DECK_REGISTRY = path.join(os.tmpdir(), `cd-scrollmode-test-${process.pid}.json`);
process.env.SYSMON_TMUX_SOCKET = 'cdtest';

const terminal = require('../lib/terminal');

const INTEGRATION = process.env.SYSMON_INTEGRATION === '1';
const integrationOpts = { skip: INTEGRATION ? false : 'set SYSMON_INTEGRATION=1 to run (spawns a real tmux session)' };

const tmux = (args) => new Promise((resolve) => {
  execFile('tmux', ['-L', 'cdtest', ...args], (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
const inMode = async (id) => (await tmux(['display-message', '-p', '-t', id, '#{pane_in_mode}'])).stdout.trim();

test('integration: scrolling back down to the bottom exits copy-mode (no frozen live view)', integrationOpts, async (t) => {
  // Shell tab = deterministic content source (no agent, no quota). Non-"zz " label on purpose.
  const created = await terminal.createSession({ label: 'scrollmode probe', cwd: '/tmp', shell: true });
  if (!created || !created.ok) return t.skip('tmux unavailable');
  const id = created.session.id;
  try {
    // Generate enough output that the pane has real history to scroll into.
    await tmux(['send-keys', '-t', id, 'seq 1 200', 'Enter']);
    await new Promise((r) => setTimeout(r, 400));

    await terminal.scrollOp(id, 'up', 10);
    assert.equal(await inMode(id), '1', 'scrolling up enters copy-mode');

    // Scroll back down past the bottom — MORE lines than we went up, like a real wheel flick.
    await terminal.scrollOp(id, 'down', 50);
    assert.equal(await inMode(id), '0',
      'reaching the bottom must exit copy-mode natively — a pane left in_mode=1 at pos 0 renders a frozen "live" view');
  } finally {
    await terminal.killSession(id);   // insurance: an assertion throw must never leak the session
  }
});
