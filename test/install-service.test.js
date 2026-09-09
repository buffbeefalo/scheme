'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '..', 'bin');

// Run the real installer with only the service managers replaced: never install a live service.
function fixture(t, platform = 'Linux', withNode = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'Scheme & tools %h $USER');
  const commands = path.join(root, 'commands');
  const nodeDir = path.join(root, 'node-version', 'bin');
  for (const dir of [home, path.join(project, 'bin'), commands, nodeDir]) fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(source)) fs.copyFileSync(path.join(source, name), path.join(project, 'bin', name));
  for (const name of ['bash', 'cat', 'dirname', 'mkdir', 'rm', 'id']) {
    const resolved = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
    assert.equal(resolved.status, 0, `${name} must be available to run installer tests`);
    fs.symlinkSync(resolved.stdout.trim(), path.join(commands, name));
  }
  if (withNode) fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  const fake = (name, body) => fs.writeFileSync(path.join(commands, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fake('uname', `echo ${platform}`);
  fake('sleep', 'exit 0');
  fake('loginctl', 'exit 0');
  fake('launchctl', 'printf "%s\\n" "$*" >> "$HOME/manager.log"');
  fake('systemctl', 'printf "%s\\n" "$*" >> "$HOME/manager.log"\ncase "$*" in *status*|*is-active*) exit "${TEST_SERVICE_STATUS:-0}" ;; esac');
  const env = {
    HOME: home, USER: 'tester', PATH: `${nodeDir}:${commands}`, SHELL: '/bin/bash',
    SYSMON_PORT: '4100', COMMAND_DECK_CLAUDE_ARGS: '',
    CLAUDE_LOCAL_MODEL: 'example-model:latest', SCHEME_PROJECT_DIRS: `${home}/code & notes`,
    ANTHROPIC_API_KEY: 'fixture-must-not-be-saved', CLAUDE_CODE_SESSION_ID: 'fixture-parent-session',
  };
  const unit = platform === 'Linux'
    ? path.join(home, '.config/systemd/user/scheme.service')
    : path.join(home, 'Library/LaunchAgents/io.scheme.server.plist');
  return {
    home, project, env, unit,
    run: (args = [], extra = {}) => spawnSync('/bin/bash', [path.join(project, 'bin/install-service.sh'), ...args], {
      env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
    }),
  };
}

test('Linux service keeps the working PATH and explicit Scheme settings, including empty values', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const unit = fs.readFileSync(f.unit, 'utf8');
  assert.ok(unit.includes(`Environment="PATH=${f.env.PATH}"`), 'the service must still find version-managed Node');
  assert.ok(unit.includes('Environment="COMMAND_DECK_CLAUDE_ARGS="'), 'empty disables the default effort flag');
  assert.ok(unit.includes('Environment="CLAUDE_LOCAL_MODEL=example-model:latest"'));
  assert.ok(unit.includes(`Environment="SCHEME_PROJECT_DIRS=${f.env.SCHEME_PROJECT_DIRS}"`));
  assert.doesNotMatch(unit, /fixture-must-not-be-saved|fixture-parent-session/);
  assert.match(fs.readFileSync(path.join(f.home, 'manager.log'), 'utf8'), /--user restart scheme\.service/, 'reinstallation must apply changed settings');
});

test('Linux service quotes the launcher path and escapes systemd expansions', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const unit = fs.readFileSync(f.unit, 'utf8');
  assert.ok(unit.includes('Scheme & tools %%h $$USER/bin/scheme"'), 'spaces and literal percent/dollar names must survive service parsing');
});

test('Linux service stops only Scheme so tmux sessions can outlive it', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.match(fs.readFileSync(f.unit, 'utf8'), /^KillMode=process$/m,
    'systemd defaults to killing the whole process group, including the tmux server');
});

test('macOS service escapes XML and keeps the working PATH and Scheme settings', (t) => {
  const f = fixture(t, 'Darwin');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const plist = fs.readFileSync(f.unit, 'utf8');
  assert.ok(plist.includes('Scheme &amp; tools %h $USER/bin/scheme</string>'));
  assert.ok(plist.includes(`<key>PATH</key><string>${f.env.PATH}</string>`));
  assert.ok(plist.includes('<key>COMMAND_DECK_CLAUDE_ARGS</key><string></string>'));
  assert.ok(plist.includes('<key>CLAUDE_LOCAL_MODEL</key><string>example-model:latest</string>'));
  assert.ok(plist.includes('/code &amp; notes</string>'));
  assert.doesNotMatch(plist, /fixture-must-not-be-saved|fixture-parent-session/);
});

for (const platform of ['Linux', 'Darwin']) {
  test(`${platform} removal works after Node has been uninstalled`, (t) => {
    const f = fixture(t, platform, false);
    fs.mkdirSync(path.dirname(f.unit), { recursive: true });
    fs.writeFileSync(f.unit, 'previous installation');
    const result = f.run(['--remove']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.unit), false);
  });
}

test('installer reports a failed service instead of claiming successful installation', (t) => {
  const f = fixture(t);
  const result = f.run([], { TEST_SERVICE_STATUS: '3' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /Installed /);
});

test('invalid settings do not overwrite an existing service or contact the service manager', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.unit), { recursive: true });
  fs.writeFileSync(f.unit, 'previous installation');
  const result = f.run([], { SCHEME_PROJECT_DIRS: '/projects\nRestart=always' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.unit, 'utf8'), 'previous installation');
  assert.equal(fs.existsSync(path.join(f.home, 'manager.log')), false);
});

test('unknown installer arguments cause no service changes', (t) => {
  const f = fixture(t);
  const result = f.run(['--typo']);
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(f.unit), false);
  assert.equal(fs.existsSync(path.join(f.home, 'manager.log')), false);
});
