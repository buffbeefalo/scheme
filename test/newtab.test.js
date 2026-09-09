'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { bumpVersion, parseArgs, sessionOptions } = require('../lib/newtab');
const { shquote, launchCmd, codexLaunchCmd, sanitizeLabel } = require('../lib/terminal');

test('bumpVersion appends v2 to a bare title', () => {
  assert.equal(bumpVersion('sample project'), 'sample project v2');
  assert.equal(bumpVersion('command deck handoff'), 'command deck handoff v2');
});

test('bumpVersion increments an existing vN (no stacking)', () => {
  assert.equal(bumpVersion('sample project v2'), 'sample project v3');
  assert.equal(bumpVersion('foo v9'), 'foo v10');
  assert.equal(bumpVersion('foo v10'), 'foo v11');
});

test('bumpVersion trims whitespace and handles empty/null', () => {
  assert.equal(bumpVersion('  spaced  '), 'spaced v2');
  assert.equal(bumpVersion(''), 'v2');
  assert.equal(bumpVersion(null), 'v2');
  assert.equal(bumpVersion(undefined), 'v2');
});

test('bumpVersion only bumps a real trailing vN', () => {
  assert.equal(bumpVersion('v2 rocket'), 'v2 rocket v2');   // "v2" not at the end
  assert.equal(bumpVersion('build vNext'), 'build vNext v2'); // not v<digits>
  assert.equal(bumpVersion('v2'), 'v3');                    // a title that IS just "v2"
});

test('parseArgs reads each flag and its value', () => {
  assert.deepEqual(
    parseArgs(['--agent', 'codex', '--bump', 'foo bar', '--cwd', '/x', '--prompt', 'hi there']),
    { agent: 'codex', bump: 'foo bar', cwd: '/x', prompt: 'hi there' },
  );
  assert.deepEqual(parseArgs(['--label', 'exact v5']), { label: 'exact v5' });
  assert.deepEqual(parseArgs(['--agent', '--cwd', '/x']), { agent: '', cwd: '/x' });
});

test('sessionOptions preserves Claude defaults and adds only the Codex marker', () => {
  const base = { label: 'next v2', cwd: '/work', prompt: 'continue' };
  assert.deepEqual(sessionOptions({ cwd: '/work', prompt: 'continue' }, 'next v2'), { ok: true, options: base });
  assert.deepEqual(sessionOptions({ agent: 'claude', cwd: '/work', prompt: 'continue' }, 'next v2'), { ok: true, options: base });
  assert.deepEqual(sessionOptions({ agent: 'codex', cwd: '/work', prompt: 'continue' }, 'next v2'), {
    ok: true, options: { ...base, codex: true },
  });
});

test('sessionOptions rejects invalid or missing agent values', () => {
  assert.deepEqual(sessionOptions({ agent: 'other' }, 'v2'), { ok: false, error: "--agent must be 'claude' or 'codex'" });
  assert.deepEqual(sessionOptions({ agent: '' }, 'v2'), { ok: false, error: "--agent must be 'claude' or 'codex'" });
});

test('shquote round-trips arbitrary strings through a real shell', () => {
  const nasty = ['plain', "it's tricky", 'a "b" c', '$(rm -rf /)', '`whoami`', 'a\nb', "x'; echo pwned; '", '* ? [a-z]'];
  for (const s of nasty) {
    const out = execFileSync('sh', ['-c', `printf %s ${shquote(s)}`]).toString();
    assert.equal(out, s, `round-trip failed for ${JSON.stringify(s)}`);
  }
});

test('launchCmd local mode swaps in claude-local and drops --effort max', () => {
  assert.match(launchCmd('UUID', ''), /\/claude --effort max --session-id UUID$/);
  const local = launchCmd('UUID', '', true);
  assert.match(local, /\/claude-local --session-id UUID$/);
  assert.doesNotMatch(local, /--effort max/);
  // A prompt still bakes shell-safely in local mode.
  const cmd = launchCmd('UUID', "it's local", true);
  const tail = cmd.split('--session-id UUID ')[1];
  const recovered = execFileSync('sh', ['-c', `set -- ${tail}; printf %s "$1"`]).toString();
  assert.equal(recovered, "it's local");
});

test('omitted models emit no CLI override while explicit automation overrides remain', () => {
  const localDefault = launchCmd('UUID', '', true);
  const localPinned = launchCmd('UUID', '', true, 'qwen3-coder:30b');
  assert.doesNotMatch(localDefault, /--model\b/);
  assert.match(localPinned, /--model qwen3-coder:30b\b/);
  const codexDefault = codexLaunchCmd('', null);
  const codexPinned = codexLaunchCmd('', 'gpt-5.6-terra');
  assert.doesNotMatch(codexDefault, /-c ['"]?model=/);
  assert.match(codexPinned, /-c 'model="gpt-5\.6-terra"'/);
});

test('launchCmd bakes a prompt only when present, and shell-safely', () => {
  // No prompt → no trailing positional arg.
  assert.match(launchCmd('UUID', ''), /--session-id UUID$/);
  assert.doesNotMatch(launchCmd('UUID', ''), /''/);
  // With a prompt → recoverable as the trailing positional arg via a real shell.
  const prompt = "Read 'the' doc & continue $(now)";
  const cmd = launchCmd('UUID', prompt);
  const tail = cmd.split('--session-id UUID ')[1];      // everything after the id = the quoted prompt
  const recovered = execFileSync('sh', ['-c', `set -- ${tail}; printf %s "$1"`]).toString();
  assert.equal(recovered, prompt);
});

// Regression for finding 4b (caught by the handoff round-trip verification): bumpVersion appended
// " vN" BEFORE terminal.js's sanitizeLabel sliced the label to 40 chars, so long titles lost their
// version suffix and repeated handoffs stopped incrementing.
test('bumpVersion keeps the " vN" suffix within the 40-char label cap (4b)', () => {
  const long = 'Networker scrape pipeline rebuild session'; // 41 chars
  const out = bumpVersion(long);
  assert.ok(out.length <= 40, `expected <=40 chars, got ${out.length}: ${JSON.stringify(out)}`);
  assert.ok(out.endsWith(' v2'), `expected trailing " v2", got ${JSON.stringify(out)}`);
});

test('repeated handoffs from a long title keep incrementing, never collapse (4b)', () => {
  const first = bumpVersion('x'.repeat(39));   // base+suffix > 40 → base must be trimmed to fit
  assert.ok(first.endsWith(' v2') && first.length <= 40, `first=${JSON.stringify(first)}`);
  const second = bumpVersion(first);           // must read the v2 and bump to v3, not re-append v2
  assert.ok(second.endsWith(' v3'), `expected " v3", got ${JSON.stringify(second)}`);
  assert.ok(second.length <= 40);
});

test('bumpVersion output survives sanitizeLabel unchanged (4b integration)', () => {
  for (const t of ['Networker scrape pipeline rebuild session', 'x'.repeat(39), 'command deck handoff', 'short v9']) {
    const b = bumpVersion(t);
    assert.equal(sanitizeLabel(b), b, `sanitizeLabel would mangle ${JSON.stringify(b)}`);
  }
});

// COMMAND_DECK_CLAUDE_ARGS replaces the pinned --effort max on a fresh cloud launch (standalone installs
// on plans without `max`); unset keeps the default byte-for-byte; empty means no extra args.
test('launchCmd honours COMMAND_DECK_CLAUDE_ARGS (unset = --effort max, empty = none)', () => {
  const { execFileSync } = require('node:child_process');
  const probe = (env) => execFileSync(process.execPath, ['-e', "process.stdout.write(require('./lib/terminal').launchCmd('UUID', ''))"],
    { cwd: require('node:path').resolve(__dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.match(probe({ COMMAND_DECK_CLAUDE_ARGS: undefined }), /\/claude --effort max --session-id UUID$/);
  assert.match(probe({ COMMAND_DECK_CLAUDE_ARGS: '--effort high' }), /\/claude --effort high --session-id UUID$/);
  assert.match(probe({ COMMAND_DECK_CLAUDE_ARGS: '' }), /\/claude --session-id UUID$/);
});
