'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toggles = require('../lib/claude-toggles');

function freshHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cdtoggles-')); }
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
