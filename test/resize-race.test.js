'use strict';
// Resize-race pin. A window drag sends one resize per animation frame, and the WS bridge fires each
// at terminal.resize() without awaiting. Every call is three async spawns (resize-window, list-clients,
// stty) with no ordering between calls, so a straggler from mid-drag can land AFTER the final size and
// leave tmux's window or its attached client at a stale size while xterm is at the final one (seen
// live 2026-09-01: client 89x28 while xterm and window were 81x31 — text rendered against the wrong
// geometry until the next resize). Contract: once the last call settles, the window AND every attached
// client equal the LAST requested size. Isolated tmux server + a real script-attached client, like the bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmuxSocketFile(socket) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket);
}

test('concurrent resizes settle the window AND the attached client at the LAST requested size', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-race-'));
  process.env.COMMAND_DECK_REGISTRY = path.join(dir, 'sessions.json');
  process.env.SYSMON_TMUX_SOCKET = `cdrace${process.pid}${Date.now().toString(36)}`;
  const sock = process.env.SYSMON_TMUX_SOCKET;
  const tmux = (args) => execFileSync('tmux', ['-L', sock, ...args], { encoding: 'utf8' }).trim();
  const id = 'cdrace1';
  let child = null;
  try {
    try { tmux(['new-session', '-d', '-s', id, '-x', '120', '-y', '30', '-c', '/tmp']); } catch { return t.skip('tmux unavailable'); }
    tmux(['set-option', '-t', id, 'window-size', 'manual']);
    delete require.cache[require.resolve('../lib/terminal')];
    const T = require('../lib/terminal');
    // Attach a client exactly the way the bridge does: util-linux script supplies the PTY.
    child = spawn('script', ['-q', '-f', '-c', `tmux -L ${sock} attach-session -t ${id}`, '/dev/null'], { env: { ...process.env, TERM: 'xterm-256color' } });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    for (let i = 0; i < 50 && !tmux(['list-clients', '-t', id, '-F', '#{client_tty}']); i++) await sleep(100);
    assert.ok(tmux(['list-clients', '-t', id, '-F', '#{client_tty}']), 'a client is attached');

    for (let round = 1; round <= 3; round++) {
      // One "drag": 60 frames, each a different size, fired without awaiting — what the bridge does.
      const sizes = []; for (let i = 0; i < 60; i++) sizes.push({ cols: 60 + i, rows: 20 + (i % 7) });
      const last = sizes[sizes.length - 1];
      await Promise.all(sizes.map((s) => T.resize(id, s.cols, s.rows)));
      await sleep(250);   // the client reports its new pty size to the server on SIGWINCH; give it a beat
      const want = `${last.cols}x${last.rows}`;
      const win = tmux(['display-message', '-p', '-t', id, '#{window_width}x#{window_height}']);
      const clients = tmux(['list-clients', '-t', id, '-F', '#{client_width}x#{client_height}']).split('\n').filter(Boolean);
      assert.equal(win, want, `round ${round}: window ends at the last requested size`);
      assert.ok(clients.length >= 1, `round ${round}: client still attached`);
      for (const c of clients) assert.equal(c, want, `round ${round}: attached client ends at the last requested size`);
    }
  } finally {
    try { child && child.kill('SIGTERM'); } catch {}
    try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch {}
    try { fs.rmSync(tmuxSocketFile(sock), { force: true }); } catch {}
    delete process.env.COMMAND_DECK_REGISTRY; delete process.env.SYSMON_TMUX_SOCKET;
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/terminal')];
  }
});
