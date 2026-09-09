'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('state paths use the operating system home when HOME is absent', () => {
  // No filesystem operations: these three modules only compute their default path on import.
  const code = `
    delete process.env.HOME;
    delete process.env.COMMAND_DECK_REGISTRY;
    delete process.env.COMMAND_DECK_AUDIT;
    require('node:os').homedir = () => '/example-account';
    process.stdout.write(JSON.stringify([
      require('./lib/registry').file(), require('./lib/audit').file(),
      require('./lib/codex-telemetry').SESSIONS_DIR
    ]));
  `;
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [
    '/example-account/.claude/command-deck/sessions.json',
    '/example-account/.claude/command-deck/audit.jsonl',
    '/example-account/.codex/sessions',
  ]);
});
