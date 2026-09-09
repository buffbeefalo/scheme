'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Run actual resumeSession/bringUp planning. The external tmux boundary records terminal input;
// it never starts a terminal or an AI tool. Module startup shims stay in the temporary HOME.
function resume(t, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-resume-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8',
    COMMAND_DECK_CLAUDE: '/fixture/claude', COMMAND_DECK_CLAUDE_LOCAL: '/fixture/local' };
  if (args !== undefined) env.COMMAND_DECK_CLAUDE_ARGS = args;
  const program = `
    const input = {};
    require('node:child_process').execFile = (binary, args, options, callback) => {
      if (require('node:path').basename(binary) !== 'tmux') throw new Error('Unexpected external command');
      if (args[0] === 'send-keys') input[args[2]] = args[3];
      callback(null, '', '');
    };
    const T = require('./lib/terminal');
    (async () => {
      const base = { uuid: '${uuid}', cwd: process.env.HOME, label: 'Example' };
      const results = [];
      results.push(await T.resumeSession({ ...base, id: 'cdnormal', runtime: 'claude' }));
      results.push(await T.resumeSession({ ...base, id: 'cdauto', runtime: 'claude', autonomous: true }));
      results.push(await T.resumeSession({ ...base, id: 'cdlocal', runtime: 'local', local: true }));
      process.stdout.write(JSON.stringify({ input, results, fresh: T.launchCmd('${uuid}', '') }));
    })().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const r = spawnSync(process.execPath, ['-e', program], {
    cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

for (const { name, args, suffix } of [
  { name: 'unset settings keep the existing default', args: undefined, suffix: ' --effort max' },
  { name: 'configured high effort is preserved', args: '--effort high', suffix: ' --effort high' },
  { name: 'explicit empty settings omit extra arguments', args: '', suffix: '' },
]) {
  test(`cloud resume: ${name}; local and autonomous behavior is preserved`, (t) => {
    const out = resume(t, args);
    assert.deepEqual(out.results, [{ ok: true }, { ok: true }, { ok: true }]);
    assert.ok(out.input.cdnormal.endsWith(`/fixture/claude${suffix} --resume ${uuid}`), out.input.cdnormal);
    assert.ok(out.fresh.endsWith(`/fixture/claude${suffix} --session-id ${uuid}`), out.fresh);
    assert.ok(out.input.cdauto.endsWith(`/fixture/claude${suffix} --resume ${uuid} --dangerously-skip-permissions`));
    assert.ok(out.input.cdauto.includes(' -u COMMAND_DECK_AUTONOMOUS_TOKEN '));
    assert.ok(!out.input.cdnormal.includes('--dangerously-skip-permissions'));
    assert.ok(out.input.cdlocal.endsWith(`/fixture/local --resume ${uuid}`), out.input.cdlocal);
  });
}
