'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const toggles = require('../lib/claude-toggles');

function freshHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdtoggles-'));
  if (t) t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function seedSettings(home, extra = {}) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settings = {
    env: { SECRET_KEY: 'do-not-lose-me' },
    model: 'claude-fable-5[1m]',
    enabledPlugins: { 'a@market': true, 'b@market': true, 'ai-council@personal-council': true },
    ...extra,
  };
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  return settings;
}
function readSettings(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
}

test('fresh home reports everything on, with honest detail strings', () => {
  const home = freshHome();
  const st = toggles.readState({ home });
  assert.equal(st.ok, true);
  assert.equal(st.toggles.plugins.on, true);
  assert.equal(st.toggles.hooks.on, true);
  assert.equal(st.toggles.skills.on, true);
  assert.equal(st.toggles.skills.detail, 'no skill dirs');
  assert.equal(st.toggles.council.on, true);
});

test('hooks toggle round-trips disableAllHooks and preserves every other key', async () => {
  const home = freshHome();
  seedSettings(home);
  const off = await toggles.setToggle('hooks', false, { home });
  assert.equal(off.ok, true);
  assert.equal(readSettings(home).disableAllHooks, true);
  assert.equal(off.toggles.hooks.on, false);
  const on = await toggles.setToggle('hooks', true, { home });
  assert.equal(on.toggles.hooks.on, true);
  const after = readSettings(home);
  assert.ok(!Object.hasOwn(after, 'disableAllHooks'));
  assert.equal(after.env.SECRET_KEY, 'do-not-lose-me');
  assert.equal(after.model, 'claude-fable-5[1m]');
});

test('plugins toggle flips every key EXCEPT the council plugin', async () => {
  const home = freshHome();
  seedSettings(home);
  const off = await toggles.setToggle('plugins', false, { home });
  const s = readSettings(home);
  assert.equal(s.enabledPlugins['a@market'], false);
  assert.equal(s.enabledPlugins['b@market'], false);
  assert.equal(s.enabledPlugins['ai-council@personal-council'], true, 'council key belongs to the council toggle');
  assert.equal(off.toggles.plugins.on, false);
  assert.equal(off.toggles.council.on, true);
  await toggles.setToggle('plugins', true, { home });
  assert.equal(readSettings(home).enabledPlugins['a@market'], true);
});

test('council toggle owns the plugin key and the CLAUDE.md marker file', async () => {
  const home = freshHome();
  seedSettings(home);
  const marker = path.join(home, '.claude', 'council-disabled');
  const off = await toggles.setToggle('council', false, { home });
  assert.equal(off.toggles.council.on, false);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(readSettings(home).enabledPlugins['ai-council@personal-council'], false);
  assert.equal(readSettings(home).enabledPlugins['a@market'], true, 'other plugins untouched');
  const on = await toggles.setToggle('council', true, { home });
  assert.equal(on.toggles.council.on, true);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(readSettings(home).enabledPlugins['ai-council@personal-council'], true);
});

test('skills toggle parks both dirs, keeps content, and never overwrites a collision', async () => {
  const home = freshHome();
  seedSettings(home);
  const claudeSkills = path.join(home, '.claude', 'skills');
  const agentSkills = path.join(home, '.agents', 'skills');
  fs.mkdirSync(path.join(claudeSkills, 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(claudeSkills, 'my-skill', 'SKILL.md'), 'hello');
  fs.mkdirSync(agentSkills, { recursive: true });

  const off = await toggles.setToggle('skills', false, { home });
  assert.equal(off.toggles.skills.on, false);
  assert.equal(fs.existsSync(claudeSkills), false);
  assert.equal(fs.readFileSync(path.join(claudeSkills + '.disabled', 'my-skill', 'SKILL.md'), 'utf8'), 'hello');
  assert.equal(fs.existsSync(agentSkills + '.disabled'), true);

  const on = await toggles.setToggle('skills', true, { home });
  assert.equal(on.toggles.skills.on, true);
  assert.equal(fs.readFileSync(path.join(claudeSkills, 'my-skill', 'SKILL.md'), 'utf8'), 'hello');

  // collision: both live and parked exist → skip with warning, no data loss
  fs.mkdirSync(claudeSkills + '.disabled', { recursive: true });
  const collide = await toggles.setToggle('skills', false, { home });
  assert.equal(collide.ok, true);
  assert.ok(collide.warnings.some((w) => w.includes('.disabled already exists')));
  assert.equal(fs.existsSync(claudeSkills), true, 'live dir left in place on collision');
});

test('unknown toggle name is a 400, corrupt settings are never written back', async () => {
  const home = freshHome();
  const bad = await toggles.setToggle('nonsense', true, { home });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);

  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const file = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(file, '{ this is not json');
  assert.equal(toggles.readState({ home }).ok, false);
  const r = await toggles.setToggle('hooks', false, { home });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'corrupt file untouched');
});

// The plugins switch used to be a one-way door: OFF wrote false to every key, and ON wrote true
// to every key — force-enabling plugins that had been deliberately disabled (14 of 23 on the
// real box). A kill switch has to put back exactly what it took away.
test('turning plugins off and on again restores the exact per-plugin mix', async () => {
  const home = freshHome();
  seedSettings(home, { enabledPlugins: { 'keep@market': true, 'off-on-purpose@market': false, 'also-on@market': true } });

  const off = await toggles.setToggle('plugins', false, { home });
  assert.equal(off.ok, true);
  const blacked = readSettings(home).enabledPlugins;
  assert.deepEqual(blacked, { 'keep@market': false, 'off-on-purpose@market': false, 'also-on@market': false });

  const on = await toggles.setToggle('plugins', true, { home });
  assert.equal(on.ok, true);
  const restored = readSettings(home).enabledPlugins;
  assert.deepEqual(restored, { 'keep@market': true, 'off-on-purpose@market': false, 'also-on@market': true },
    'the deliberately-disabled plugin must still be disabled');
  assert.equal(readSettings(home).env.SECRET_KEY, 'do-not-lose-me');
});

test('a plugin added while plugins were off keeps its own value on restore', async () => {
  const home = freshHome();
  seedSettings(home, { enabledPlugins: { 'old@market': false } });
  await toggles.setToggle('plugins', false, { home });
  const s = readSettings(home);
  s.enabledPlugins['new@market'] = true;
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(s, null, 2));
  await toggles.setToggle('plugins', true, { home });
  assert.deepEqual(readSettings(home).enabledPlugins, { 'old@market': false, 'new@market': true });
});

test('with no saved state the switch still turns everything on, and says so', async () => {
  const home = freshHome();
  seedSettings(home, { enabledPlugins: { 'a@market': false, 'b@market': false } });
  const on = await toggles.setToggle('plugins', true, { home });
  assert.equal(on.ok, true);
  assert.deepEqual(readSettings(home).enabledPlugins, { 'a@market': true, 'b@market': true });
  assert.ok((on.warnings || []).some((w) => /no saved plugin state/i.test(w)), 'warns that it guessed');
});

for (const code of ['EACCES', 'EIO']) {
  test(`settings read ${code} refuses a toggle without replacing existing settings`, async (t) => {
    const home = freshHome(t);
    const original = seedSettings(home);
    const file = path.join(home, '.claude', 'settings.json');
    const readFileSync = fs.readFileSync;
    const fault = t.mock.method(fs, 'readFileSync', function (target, ...args) {
      if (target === file) throw Object.assign(new Error('simulated settings read failure'), { code });
      return readFileSync.call(this, target, ...args);
    });

    const result = await toggles.setToggle('hooks', false, { home });
    const state = toggles.readState({ home });
    fault.mock.restore();

    assert.deepEqual(readSettings(home), original, 'unreadable settings must remain untouched');
    assert.equal(result.ok, false, 'the write must be refused');
    assert.equal(state.ok, false, 'an unreadable file must not look like default settings');
  });
}

test('concurrent different toggles preserve both changes and unrelated settings', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home, { permissions: { allow: ['Read'] } });

  const results = await Promise.all([
    toggles.setToggle('hooks', false, { home }),
    toggles.setToggle('council', false, { home }),
  ]);

  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(readSettings(home), {
    ...original,
    disableAllHooks: true,
    enabledPlugins: { 'a@market': true, 'b@market': true, 'ai-council@personal-council': false },
  });
  assert.equal(fs.existsSync(path.join(home, '.claude', 'council-disabled')), true);
});

test('turning plugins off twice then on restores the original mixed states', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home, {
    enabledPlugins: { 'keep@market': true, 'off-on-purpose@market': false, 'ai-council@personal-council': true },
  });

  assert.equal((await toggles.setToggle('plugins', false, { home })).ok, true);
  assert.equal((await toggles.setToggle('plugins', false, { home })).ok, true);
  assert.equal((await toggles.setToggle('plugins', true, { home })).ok, true);

  assert.deepEqual(readSettings(home), original, 'a repeated off request must not replace the original mix');
});

test('a failed plugin snapshot save refuses to disable plugins', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home, { enabledPlugins: { 'keep@market': true, 'off-on-purpose@market': false } });
  const snapshot = path.join(home, '.claude', '.deck-plugin-state.json');
  const rename = fs.promises.rename;
  const fault = t.mock.method(fs.promises, 'rename', async function (from, to) {
    if (to === snapshot) throw Object.assign(new Error('simulated snapshot save failure'), { code: 'EIO' });
    return rename.call(this, from, to);
  });

  const result = await toggles.setToggle('plugins', false, { home });
  fault.mock.restore();

  assert.deepEqual(readSettings(home), original, 'a failed backup must not destroy the state it should preserve');
  assert.equal(result.ok, false);
});

test('a failed plugin restore write can be retried without losing the original mix', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home, { enabledPlugins: { 'keep@market': true, 'off-on-purpose@market': false } });
  assert.equal((await toggles.setToggle('plugins', false, { home })).ok, true);
  const disabled = readSettings(home);
  const file = path.join(home, '.claude', 'settings.json');
  const rename = fs.promises.rename;
  const fault = t.mock.method(fs.promises, 'rename', async function (from, to) {
    if (to === file) throw Object.assign(new Error('simulated settings save failure'), { code: 'EIO' });
    return rename.call(this, from, to);
  });

  const failed = await toggles.setToggle('plugins', true, { home });
  fault.mock.restore();

  assert.equal(failed.ok, false);
  assert.deepEqual(readSettings(home), disabled, 'failed replacement leaves the disabled settings intact');
  assert.equal((await toggles.setToggle('plugins', true, { home })).ok, true);
  assert.deepEqual(readSettings(home), original, 'retry must still know which plugins were deliberately disabled');
});

test('an unreadable plugin snapshot refuses restore and remains usable after the read recovers', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home, { enabledPlugins: { 'keep@market': true, 'off-on-purpose@market': false } });
  assert.equal((await toggles.setToggle('plugins', false, { home })).ok, true);
  const disabled = readSettings(home);
  const snapshot = path.join(home, '.claude', '.deck-plugin-state.json');
  const readFileSync = fs.readFileSync;
  const fault = t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (target === snapshot) throw Object.assign(new Error('simulated snapshot read failure'), { code: 'EIO' });
    return readFileSync.call(this, target, ...args);
  });

  const failed = await toggles.setToggle('plugins', true, { home });
  fault.mock.restore();

  assert.deepEqual(readSettings(home), disabled, 'an unreadable snapshot must not enable every plugin');
  assert.equal(failed.ok, false);
  assert.equal((await toggles.setToggle('plugins', true, { home })).ok, true);
  assert.deepEqual(readSettings(home), original);
});

test('a corrupt plugin snapshot refuses restore instead of enabling deliberately disabled plugins', async (t) => {
  const home = freshHome(t);
  seedSettings(home, { enabledPlugins: { 'keep@market': true, 'off-on-purpose@market': false } });
  assert.equal((await toggles.setToggle('plugins', false, { home })).ok, true);
  const disabled = readSettings(home);
  const snapshot = path.join(home, '.claude', '.deck-plugin-state.json');
  fs.writeFileSync(snapshot, '{ invalid snapshot');

  const result = await toggles.setToggle('plugins', true, { home });

  assert.deepEqual(readSettings(home), disabled);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), '{ invalid snapshot');
});

for (const raw of ['null', '[]', '"settings"', '{"enabledPlugins":[]}', '{"enabledPlugins":null}']) {
  test(`invalid settings shape ${raw} is read-only`, async (t) => {
    const home = freshHome(t);
    seedSettings(home);
    const file = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(file, raw);

    const result = await toggles.setToggle('hooks', false, { home });

    assert.equal(result.ok, false);
    assert.equal(toggles.readState({ home }).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  });
}

for (const raw of ['null', '[true]', '{"keep@market":"true"}']) {
  test(`invalid plugin snapshot shape ${raw} refuses restore`, async (t) => {
    const home = freshHome(t);
    seedSettings(home, { enabledPlugins: { 'keep@market': false, 'off-on-purpose@market': false } });
    const original = readSettings(home);
    const snapshot = path.join(home, '.claude', '.deck-plugin-state.json');
    fs.writeFileSync(snapshot, raw);

    const result = await toggles.setToggle('plugins', true, { home });

    assert.equal(result.ok, false);
    assert.deepEqual(readSettings(home), original);
    assert.equal(fs.readFileSync(snapshot, 'utf8'), raw);
  });
}

test('an external settings change observed before replacement is preserved and reported', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home);
  const external = { ...original, model: 'changed-outside-scheme', permissions: { allow: ['Read'] } };
  const file = path.join(home, '.claude', 'settings.json');
  const writeFile = fs.promises.writeFile;
  const fault = t.mock.method(fs.promises, 'writeFile', async function (target, ...args) {
    const result = await writeFile.call(this, target, ...args);
    if (String(target).startsWith(file + '.') && String(target).endsWith('.tmp')) {
      fs.writeFileSync(file, JSON.stringify(external));
    }
    return result;
  });

  const result = await toggles.setToggle('hooks', false, { home });
  fault.mock.restore();

  assert.deepEqual(readSettings(home), external, 'an observed external change must not be replaced');
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});

test('a refused first plugin blackout cannot restore stale choices on a later retry', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home, { enabledPlugins: { a: true, b: false } });
  const external = { ...original, enabledPlugins: { a: false, b: true } };
  const file = path.join(home, '.claude', 'settings.json');
  const snapshot = path.join(home, '.claude', '.deck-plugin-state.json');
  const writeFile = fs.promises.writeFile;
  const fault = t.mock.method(fs.promises, 'writeFile', async function (target, ...args) {
    const result = await writeFile.call(this, target, ...args);
    if (String(target).startsWith(file + '.') && String(target).endsWith('.tmp')) {
      fs.writeFileSync(file, JSON.stringify(external));
    }
    return result;
  });

  const failed = await toggles.setToggle('plugins', false, { home });
  fault.mock.restore();
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 409);
  assert.deepEqual(readSettings(home), external);
  assert.equal(fs.existsSync(snapshot), false, 'a backup for a blackout that never happened must not survive');
  assert.equal((await toggles.setToggle('plugins', false, { home })).ok, true);
  assert.equal((await toggles.setToggle('plugins', true, { home })).ok, true);
  assert.deepEqual(readSettings(home), external, 'retry must restore the choices that were actually disabled');
});

test('a failed repeated blackout retains the recovery snapshot from the successful blackout', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home, { enabledPlugins: { a: true, b: false } });
  assert.equal((await toggles.setToggle('plugins', false, { home })).ok, true);
  const file = path.join(home, '.claude', 'settings.json');
  const snapshot = path.join(home, '.claude', '.deck-plugin-state.json');
  const saved = fs.readFileSync(snapshot, 'utf8');
  const rename = fs.promises.rename;
  const fault = t.mock.method(fs.promises, 'rename', async function (from, to) {
    if (to === file) throw Object.assign(new Error('simulated settings failure'), { code: 'EIO' });
    return rename.call(this, from, to);
  });
  const failed = await toggles.setToggle('plugins', false, { home });
  fault.mock.restore();
  assert.equal(failed.ok, false);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), saved);
  assert.equal((await toggles.setToggle('plugins', true, { home })).ok, true);
  assert.deepEqual(readSettings(home), original);
});

test('failed blackout cleanup preserves a backup changed by another writer', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home, { enabledPlugins: { a: true, b: false } });
  const file = path.join(home, '.claude', 'settings.json');
  const snapshot = path.join(home, '.claude', '.deck-plugin-state.json');
  const external = JSON.stringify({ a: false, b: true });
  const rename = fs.promises.rename;
  const fault = t.mock.method(fs.promises, 'rename', async function (from, to) {
    if (to === file) {
      fs.writeFileSync(snapshot, external);
      throw Object.assign(new Error('simulated settings failure'), { code: 'EIO' });
    }
    return rename.call(this, from, to);
  });
  const failed = await toggles.setToggle('plugins', false, { home });
  fault.mock.restore();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /unused plugin backup could not be removed/);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), external);
  assert.deepEqual(readSettings(home), original);
});

test('concurrent path aliases share one settings transaction queue', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home);

  const results = await Promise.all([
    toggles.setToggle('hooks', false, { home }),
    toggles.setToggle('council', false, { home: path.relative(process.cwd(), home) }),
  ]);

  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(readSettings(home), {
    ...original,
    disableAllHooks: true,
    enabledPlugins: { 'a@market': true, 'b@market': true, 'ai-council@personal-council': false },
  });
});

test('a failed settings write does not prevent a later toggle from succeeding', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home);
  const file = path.join(home, '.claude', 'settings.json');
  const rename = fs.promises.rename;
  const fault = t.mock.method(fs.promises, 'rename', async function (from, to) {
    if (to === file) throw Object.assign(new Error('simulated settings save failure'), { code: 'EIO' });
    return rename.call(this, from, to);
  });

  const failed = await toggles.setToggle('hooks', false, { home });
  fault.mock.restore();

  assert.equal(failed.ok, false);
  assert.deepEqual(readSettings(home), original);
  assert.equal((await toggles.setToggle('hooks', false, { home })).ok, true);
  assert.deepEqual(readSettings(home), { ...original, disableAllHooks: true });
});

test('a settings lock held by another process refuses changes until the owner releases it', async (t) => {
  const home = freshHome(t);
  const original = seedSettings(home);
  const file = path.join(home, '.claude', 'settings.json');
  const release = path.join(home, 'release-owner');
  const script = `
    const fs = require('node:fs');
    const { createRegistryLock } = require(process.argv[1]);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const ok = createRegistryLock().withLock(process.argv[2], () => {
      process.send('locked');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(process.argv[3]) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
      return fs.existsSync(process.argv[3]);
    });
    process.exit(ok ? 0 : 1);
  `;
  const child = spawn(process.execPath, ['-e', script, require.resolve('../lib/registry-lock'), file, release], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const finished = once(child, 'exit');
  const ready = Promise.race([
    once(child, 'message'),
    finished.then(() => { throw new Error('settings lock owner exited before readiness'); }),
  ]);
  try {
    assert.deepEqual(await ready, ['locked', undefined]);
    const result = await toggles.setToggle('hooks', false, { home });
    assert.equal(result.ok, false);
    assert.deepEqual(readSettings(home), original);
  } finally {
    fs.writeFileSync(release, 'release');
    const [code] = await finished;
    assert.equal(code, 0);
  }

  assert.equal((await toggles.setToggle('hooks', false, { home })).ok, true);
  assert.deepEqual(readSettings(home), { ...original, disableAllHooks: true });
});

test('a toggle keeps private settings unreadable to group and other users', async (t) => {
  const previousUmask = process.umask(0o022);
  t.after(() => process.umask(previousUmask));
  const home = freshHome(t);
  seedSettings(home);
  const file = path.join(home, '.claude', 'settings.json');
  fs.chmodSync(file, 0o600);

  assert.equal((await toggles.setToggle('hooks', false, { home })).ok, true);

  assert.equal(fs.statSync(file).mode & 0o077, 0, 'replacing the settings file must not make its secrets readable to others');
});

test('the plugin snapshot is unreadable to group and other users', async (t) => {
  const previousUmask = process.umask(0o022);
  t.after(() => process.umask(previousUmask));
  const home = freshHome(t);
  seedSettings(home);

  assert.equal((await toggles.setToggle('plugins', false, { home })).ok, true);

  const snapshot = path.join(home, '.claude', '.deck-plugin-state.json');
  assert.equal(fs.statSync(snapshot).mode & 0o077, 0, 'plugin choices are private configuration');
});
