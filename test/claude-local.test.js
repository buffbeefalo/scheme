'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const wrapper = path.resolve(__dirname, '../bin/claude-local');

// Exercise the wrapper; only Ollama HTTP and the paid agent executable are replaced.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = path.join(root, 'bin');
  fs.mkdirSync(commands);
  fs.writeFileSync(path.join(commands, 'curl'), `#!/bin/sh
if [ "\${TEST_OLLAMA_DOWN:-}" = 1 ]; then exit 7; fi
printf '%s\\n' '{"parameters":"num_ctx 32768"}'
`, { mode: 0o755 });
  const agent = path.join(commands, 'fixture-agent');
  fs.writeFileSync(agent, `#!${process.execPath}
require('node:fs').writeFileSync(process.env.HOME + '/agent-started', 'yes');
process.stdout.write(JSON.stringify({ apiKey: process.env.ANTHROPIC_API_KEY,
  base: process.env.ANTHROPIC_BASE_URL, model: process.env.ANTHROPIC_MODEL,
  sessionId: process.env.CLAUDE_CODE_SESSION_ID, args: process.argv.slice(2) }));
`, { mode: 0o755 });
  const env = { HOME: root, PATH: `${commands}:/usr/bin:/bin`, CLAUDE_LOCAL_BIN: agent,
    CLAUDE_LOCAL_BASE: 'http://127.0.0.1:11434', ANTHROPIC_API_KEY: 'fixture-inherited-key',
    CLAUDE_CODE_SESSION_ID: 'fixture-parent' };
  return { root, run: (args = [], extra = {}) => spawnSync('/bin/bash', [wrapper, ...args], {
    env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000,
  }) };
}

test('local wrapper clears inherited cloud API credentials and session identity', (t) => {
  const f = fixture(t);
  const r = f.run(['--model', 'example-coder:latest']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.apiKey, '');
  assert.equal(out.base, 'http://127.0.0.1:11434');
  assert.equal(out.sessionId, undefined);
  assert.equal(out.model, 'example-coder:latest');
  assert.deepEqual(out.args, ['--model', 'example-coder:latest']);
});

test('local wrapper stops before launching the agent when Ollama is unavailable', (t) => {
  const f = fixture(t);
  const r = f.run([], { TEST_OLLAMA_DOWN: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Ollama not reachable/);
  assert.equal(fs.existsSync(path.join(f.root, 'agent-started')), false);
});
