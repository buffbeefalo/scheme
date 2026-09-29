'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-launch-'));
const runtime = path.join(dir, 'print-environment');
fs.writeFileSync(runtime, '#!/bin/sh\nexec env\n', { mode: 0o700 });
process.env.COMMAND_DECK_CLAUDE = runtime;
process.env.COMMAND_DECK_CLAUDE_ARGS = '';
process.env.COMMAND_DECK_CODEX = runtime;
// The unit recovery test must not start a real runtime on its red pass.
const execFile = cp.execFile;
cp.execFile = (_file, _args, _options, callback) => queueMicrotask(() => callback(new Error('test tmux unavailable'), '', ''));
const terminal = require('../lib/terminal');
cp.execFile = execFile;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('launched runtimes do not inherit another agent session identity or messaging credentials', () => {
  const privateKeys = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_PID',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_VERSION'];
  const env = { PATH: process.env.PATH, ...Object.fromEntries(privateKeys.map(key => [key, 'inherited-fixture'])) };
  for (const launch of [terminal.launchCmd('11111111-1111-4111-8111-111111111111'), terminal.codexLaunchCmd('')]) {
    const output = cp.execFileSync('sh', ['-c', launch], { env, encoding: 'utf8' });
    for (const key of privateKeys) assert.doesNotMatch(output, new RegExp(`^${key}=`, 'm'));
  }
});

test('Codex launch and resume keep each session process attached to its own terminal', () => {
  assert.match(terminal.codexLaunchCmd(''), / --no-daemon(?: |$)/);
  assert.match(terminal.codexResumeCmd('11111111-1111-4111-8111-111111111111'), / --no-daemon resume /);
});

test('the documented local default uses the public launcher default without a model override', () => {
  assert.deepEqual(terminal.normalizeLocalModel('qwen3-coder:30b'), { ok: true, model: null });
  assert.doesNotMatch(terminal.launchCmd('11111111-1111-4111-8111-111111111111', '', true, 'qwen3-coder:30b'), / --model /);
});

test('unverified Codex recovery preserves the saved identity and shows a paused notice', async () => {
  let launch;
  const saved = { id: 'cdunverified', label: 'Recovery fixture', cwd: dir, codex: true,
    codexUuid: '11111111-1111-4111-8111-111111111111' };
  const result = await terminal.resumeSession(saved, {
    isResumableCodexUuid: () => false,
    bringUp: async plan => { launch = plan; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recoveryBlocked, true);
  assert.equal(launch.codexUuid, saved.codexUuid);
  assert.match(launch.launch, /^printf /);
  assert.doesNotMatch(launch.launch, /--no-alt-screen/);
});

test('verified Codex recovery resumes the original conversation', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  let launch;
  const result = await terminal.resumeSession({ id: 'cdverified', cwd: dir, codex: true, codexUuid: uuid }, {
    isResumableCodexUuid: candidate => candidate === uuid,
    bringUp: async plan => { launch = plan; return { ok: true }; },
  });
  assert.deepEqual(result, { ok: true });
  assert.match(launch.launch, new RegExp(`resume ${uuid}$`));
});

test('previous input searches the prompt marker for the selected runtime', () => {
  assert.deepEqual(terminal.tmuxPrevInputArgs('cd1', 'codex'), ['send-keys', '-t', 'cd1', '-X', 'search-backward', '^› [^ ]']);
  assert.deepEqual(terminal.tmuxPrevInputArgs('cd1', 'claude'), ['send-keys', '-t', 'cd1', '-X', 'search-backward', '^❯ [^ ]']);
});
