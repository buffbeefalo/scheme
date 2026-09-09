'use strict';
// B1/B2/B3 behavior pins (spec ledger) — red at HEAD, green after the S5/S6 dispatch.
// B2 red-phase safety (round-3 nit): private tmux socket + scratch registry + finally
// cleanup, because at HEAD a valid-id conflicted entry takes the codex resume branch and
// spawns a REAL tmux session.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function scratchEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-rtb-'));
  process.env.COMMAND_DECK_REGISTRY = path.join(dir, 'sessions.json');
  process.env.SYSMON_TMUX_SOCKET = `cdrtb${process.pid}${Date.now().toString(36)}`;
  return dir;
}
function cleanEnv() {
  delete process.env.COMMAND_DECK_REGISTRY;
  delete process.env.SYSMON_TMUX_SOCKET;
}
function tmuxSocketFile(socket) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket);
}
function removeTmuxSocket(socket) {
  try { fs.rmSync(tmuxSocketFile(socket), { force: true }); } catch {}
}
function tmuxUsable(socket) {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'cdprobe', '-x', '80', '-y', '24', '-c', '/tmp'], { stdio: 'ignore' });
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
  finally { removeTmuxSocket(socket); }
}

test('B2: conflicting runtime markers refuse to resume', async (t) => {
  scratchEnv();
  try {
    if (!tmuxUsable(process.env.SYSMON_TMUX_SOCKET)) return t.skip('tmux unavailable');
    delete require.cache[require.resolve('../lib/terminal')];
    const T = require('../lib/terminal');
    const r = await T.resumeSession({ id: 'cdconf1', label: 'zz conflict', cwd: '/tmp', local: true, codex: true, codexUuid: '11111111-1111-1111-1111-111111111111', createdAt: Date.now() });
    assert.deepEqual(r, { ok: false, reason: 'conflicting-runtime-markers' });
  } finally {
    const { execFileSync } = require('node:child_process');
    try { execFileSync('tmux', ['-L', process.env.SYSMON_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch {}
    removeTmuxSocket(process.env.SYSMON_TMUX_SOCKET);
    cleanEnv();
    delete require.cache[require.resolve('../lib/terminal')];
  }
});

test('B1: single-flag codex session with a valid @cd_uuid backfills as codex, not claude', async (t) => {
  scratchEnv();
  try {
    if (!tmuxUsable(process.env.SYSMON_TMUX_SOCKET)) return t.skip('tmux unavailable');
    delete require.cache[require.resolve('../lib/terminal')];
    const T = require('../lib/terminal');
    const registry = require('../lib/registry');
    const uuid = '22222222-2222-2222-2222-222222222222';
    const line = ['cdb1x', 'poison', '/tmp', '1752700000', '0', uuid, '', '', '1', '', '', '', '4242'].join('\t');
    const s = T.parseSessions(line)[0];
    assert.equal(s.codex, true); assert.equal(s.uuid, uuid);
    const rowAtHead = { id: s.id, label: s.name, cwd: s.cwd, uuid: s.uuid, createdAt: s.createdAt };
    const rowExpected = { id: s.id, label: s.name, cwd: s.cwd, createdAt: s.createdAt, codex: true };
    const { execFileSync } = require('node:child_process');
    const sock = process.env.SYSMON_TMUX_SOCKET;
    execFileSync('tmux', ['-L', sock, 'new-session', '-d', '-s', 'cdb1x', '-x', '80', '-y', '24', '-c', '/tmp'], { stdio: 'ignore' });
    execFileSync('tmux', ['-L', sock, 'set-option', '-t', 'cdb1x', '@cd_name', 'poison'], { stdio: 'ignore' });
    execFileSync('tmux', ['-L', sock, 'set-option', '-t', 'cdb1x', '@cd_uuid', uuid], { stdio: 'ignore' });
    execFileSync('tmux', ['-L', sock, 'set-option', '-t', 'cdb1x', '@cd_codex', '1'], { stdio: 'ignore' });
    await T.resumeSaved();
    const rows = registry.readAll().filter((x) => x.id === 'cdb1x');
    assert.equal(rows.length, 1, 'backfill persisted the live session');
    assert.equal(rows[0].codex, true, 'B1: identity persisted as codex (red at HEAD: claude-shaped row)');
    assert.equal(rows[0].uuid, undefined, 'B1: no claude uuid on a codex row');
    void rowAtHead; void rowExpected;
  } finally {
    const { execFileSync } = require('node:child_process');
    try { execFileSync('tmux', ['-L', process.env.SYSMON_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch {}
    removeTmuxSocket(process.env.SYSMON_TMUX_SOCKET);
    cleanEnv();
    delete require.cache[require.resolve('../lib/terminal')];
  }
});

test('B3: conflicted live session is never persisted by backfill', async (t) => {
  scratchEnv();
  try {
    if (!tmuxUsable(process.env.SYSMON_TMUX_SOCKET)) return t.skip('tmux unavailable');
    delete require.cache[require.resolve('../lib/terminal')];
    const T = require('../lib/terminal');
    const registry = require('../lib/registry');
    const { execFileSync } = require('node:child_process');
    const sock = process.env.SYSMON_TMUX_SOCKET;
    execFileSync('tmux', ['-L', sock, 'new-session', '-d', '-s', 'cdb3x', '-x', '80', '-y', '24', '-c', '/tmp'], { stdio: 'ignore' });
    execFileSync('tmux', ['-L', sock, 'set-option', '-t', 'cdb3x', '@cd_name', 'conflicted'], { stdio: 'ignore' });
    execFileSync('tmux', ['-L', sock, 'set-option', '-t', 'cdb3x', '@cd_codex', '1'], { stdio: 'ignore' });
    execFileSync('tmux', ['-L', sock, 'set-option', '-t', 'cdb3x', '@cd_shell', '1'], { stdio: 'ignore' });
    await T.resumeSaved();
    assert.equal(registry.readAll().some((x) => x.id === 'cdb3x'), false, 'B3: conflicted identity not persisted (red at HEAD: codex row)');
    const s = (await T.listSessions()).find((x) => x.id === 'cdb3x');
    if (s) assert.equal(await T.backfillCodexUuid(s, [s]), null);
  } finally {
    const { execFileSync } = require('node:child_process');
    try { execFileSync('tmux', ['-L', process.env.SYSMON_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch {}
    removeTmuxSocket(process.env.SYSMON_TMUX_SOCKET);
    cleanEnv();
    delete require.cache[require.resolve('../lib/terminal')];
  }
});
