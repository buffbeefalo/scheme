'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const R = require('../lib/runtime');

test('runtimeOf: all 8 flag combos, 3 object shapes, null-safety', () => {
  const combos = [
    [{},                                        'claude'],
    [{ local: true },                           'local'],
    [{ codex: true },                           'codex'],
    [{ shell: true },                           'shell'],
    [{ local: true, codex: true },              'local'],
    [{ local: true, shell: true },              'local'],
    [{ codex: true, shell: true },              'codex'],
    [{ local: true, codex: true, shell: true }, 'local'],
  ];
  for (const [flags, want] of combos) {
    assert.equal(R.runtimeOf(flags), want);
    assert.equal(R.runtimeOf({ id: 'cdx', label: 'x', ...flags }), want);
    assert.equal(R.runtimeOf({ local: !!flags.local, codex: !!flags.codex, shell: !!flags.shell }), want);
  }
  assert.equal(R.runtimeOf(null), 'claude');
  assert.equal(R.runtimeOf(undefined), 'claude');
});

test('runtimeConflict: 8 combos + truthy strings', () => {
  assert.equal(R.runtimeConflict({}), false);
  assert.equal(R.runtimeConflict({ local: true }), false);
  assert.equal(R.runtimeConflict({ codex: true }), false);
  assert.equal(R.runtimeConflict({ shell: true }), false);
  assert.equal(R.runtimeConflict({ local: true, codex: true }), true);
  assert.equal(R.runtimeConflict({ local: true, shell: true }), true);
  assert.equal(R.runtimeConflict({ codex: true, shell: true }), true);
  assert.equal(R.runtimeConflict({ local: true, codex: true, shell: true }), true);
  assert.equal(R.runtimeConflict({ local: 'yes', codex: 1 }), true);
  assert.equal(R.runtimeConflict(null), false);
});

test('runtimeFromFlags: exclusivity error verbatim + legal mapping', () => {
  const ERR = 'a tab is ONE runtime — claude, codex, local, or a plain terminal';
  for (const bad of [{ local: true, codex: true }, { shell: true, local: true }, { shell: true, codex: true }]) {
    assert.deepEqual(R.runtimeFromFlags(bad), { ok: false, error: ERR });
  }
  assert.deepEqual(R.runtimeFromFlags({}), { ok: true, runtime: 'claude' });
  assert.deepEqual(R.runtimeFromFlags({ local: true }), { ok: true, runtime: 'local' });
  assert.deepEqual(R.runtimeFromFlags({ codex: true }), { ok: true, runtime: 'codex' });
  assert.deepEqual(R.runtimeFromFlags({ shell: true }), { ok: true, runtime: 'shell' });
});

test('claude marks are byte-additive for autonomous sessions only', () => {
  assert.deepEqual(R.RUNTIMES.claude.marks(), {});
  assert.deepEqual(R.RUNTIMES.claude.marks({}), {});
  assert.deepEqual(R.RUNTIMES.claude.marks({ autonomous: true }), { autonomous: true });
});

test('marks: registry file bytes identical to legacy inline spreads', () => {
  const registry = require('../lib/registry');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-rtenum-'));
  const writeBytes = (name, sessions) => {
    process.env.COMMAND_DECK_REGISTRY = path.join(dir, name);
    assert.ok(registry.writeAll(sessions));
    const b = fs.readFileSync(path.join(dir, name));
    delete process.env.COMMAND_DECK_REGISTRY;
    return b;
  };
  const legacyCreateMarks = (local, lmModel, codex, cmModel, shell) =>
    ({ ...(local ? { local: true } : {}), ...(lmModel ? { localModel: lmModel } : {}), ...(codex ? { codex: true } : {}), ...(cmModel ? { codexModel: cmModel } : {}), ...(shell ? { shell: true } : {}) });
  const base = { id: 'cdgold1', label: 'g', cwd: '/tmp', createdAt: 1752700000000 };
  const uuid = '11111111-1111-1111-1111-111111111111';
  const cases = [
    ['claude', {}, legacyCreateMarks(false, null, false, null, false)],
    ['local', {}, legacyCreateMarks(true, null, false, null, false)],
    ['local', { localModel: 'qwen3-coder:30b' }, legacyCreateMarks(true, 'qwen3-coder:30b', false, null, false)],
    ['local', { localModel: '' }, legacyCreateMarks(true, '', false, null, false)],
    ['codex', {}, legacyCreateMarks(false, null, true, null, false)],
    ['codex', { codexModel: 'gpt-5.5' }, legacyCreateMarks(false, null, true, 'gpt-5.5', false)],
    ['shell', {}, legacyCreateMarks(false, null, false, null, true)],
  ];
  for (const [rt, src, legacy] of cases) {
    const a = writeBytes('new.json', [{ ...base, ...R.RUNTIMES[rt].marks(src) }]);
    const b = writeBytes('legacy.json', [{ ...base, ...legacy }]);
    assert.deepEqual(a, b, `create-layout bytes differ for ${rt} ${JSON.stringify(src)}`);
  }
  const autonomousClaude = writeBytes('autonomous-claude.json', [{ ...base, ...R.RUNTIMES.claude.marks({ autonomous: true }) }]);
  const autonomousGolden = writeBytes('autonomous-claude-golden.json', [{ ...base, autonomous: true }]);
  assert.deepEqual(autonomousClaude, autonomousGolden);
  const s = { id: 'cdgold2', name: 'n', cwd: '/tmp', createdAt: 1752700000000, uuid,
              local: true, localModel: 'qwen3-coder:30b', codex: false, codexModel: null, codexUuid: null, shell: false };
  const newLocal = writeBytes('bl-new.json', [{ id: s.id, label: s.name, cwd: s.cwd, uuid: s.uuid, createdAt: s.createdAt, ...R.RUNTIMES.local.marks(s) }]);
  const legacyLocal = writeBytes('bl-old.json', [{ id: s.id, label: s.name, cwd: s.cwd, uuid: s.uuid, createdAt: s.createdAt, ...(s.local ? { local: true } : {}), ...(s.local && s.localModel ? { localModel: s.localModel } : {}) }]);
  assert.deepEqual(newLocal, legacyLocal);
  const c = { id: 'cdgold3', name: 'n', cwd: '/tmp', createdAt: 1752700000000,
              local: false, localModel: null, codex: true, codexModel: 'gpt-5.5', codexUuid: uuid, shell: false };
  const newCodex = writeBytes('bc-new.json', [{ id: c.id, label: c.name, cwd: c.cwd, createdAt: c.createdAt, ...R.RUNTIMES.codex.marks(c) }]);
  const legacyCodex = writeBytes('bc-old.json', [{ id: c.id, label: c.name, cwd: c.cwd, createdAt: c.createdAt, codex: true, ...(c.codexModel ? { codexModel: c.codexModel } : {}), ...(c.codexUuid ? { codexUuid: c.codexUuid } : {}) }]);
  assert.deepEqual(newCodex, legacyCodex);
  const sh = { id: 'cdgold4', name: 'n', cwd: '/tmp', createdAt: 1752700000000, shell: true };
  const newShell = writeBytes('bs-new.json', [{ id: sh.id, label: sh.name, cwd: sh.cwd, createdAt: sh.createdAt, ...R.RUNTIMES.shell.marks(sh) }]);
  const legacyShell = writeBytes('bs-old.json', [{ id: sh.id, label: sh.name, cwd: sh.cwd, createdAt: sh.createdAt, shell: true }]);
  assert.deepEqual(newShell, legacyShell);
});

test('bringUpPlan: exact ordered argv per runtime (HEAD write order)', () => {
  const T = require('../lib/terminal');
  const uuid = '11111111-1111-1111-1111-111111111111';
  assert.deepEqual(
    T.bringUpPlan({ id: 'cda1', dir: '/tmp', cols: 120, rows: 34, name: 'n', uuid, launch: 'LAUNCH', runtime: 'claude' }),
    [
      ['new-session', '-d', '-s', 'cda1', '-x', '120', '-y', '34', '-c', '/tmp'],
      ['set-option', '-t', 'cda1', 'window-size', 'manual'],
      ['set-option', '-g', 'escape-time', '10'],
      ['set-option', '-t', 'cda1', '@cd_name', 'n'],
      ['set-option', '-t', 'cda1', '@cd_cwd', '/tmp'],
      ['set-option', '-t', 'cda1', '@cd_uuid', uuid],
      ['set-option', '-t', 'cda1', 'status-style', 'bg=#243228,fg=#b9d9c4'],
      ['set-option', '-t', 'cda1', 'mode-style', 'bg=#bfea4b,fg=#17211a'],
      ['send-keys', '-t', 'cda1', 'LAUNCH', 'Enter'],
    ]);
  assert.deepEqual(
    T.bringUpPlan({ id: 'cda2', dir: '/tmp', cols: 120, rows: 34, name: 'n', uuid, launch: 'L', runtime: 'local', localModel: 'qwen3-coder:30b' }),
    [
      ['new-session', '-d', '-s', 'cda2', '-x', '120', '-y', '34', '-c', '/tmp'],
      ['set-option', '-t', 'cda2', 'window-size', 'manual'],
      ['set-option', '-g', 'escape-time', '10'],
      ['set-option', '-t', 'cda2', '@cd_name', 'n'],
      ['set-option', '-t', 'cda2', '@cd_cwd', '/tmp'],
      ['set-option', '-t', 'cda2', '@cd_uuid', uuid],
      ['set-option', '-t', 'cda2', '@cd_local', '1'],
      ['set-option', '-t', 'cda2', '@cd_local_model', 'qwen3-coder:30b'],
      ['set-option', '-t', 'cda2', 'status-style', 'bg=#243228,fg=#b9d9c4'],
      ['set-option', '-t', 'cda2', 'mode-style', 'bg=#bfea4b,fg=#17211a'],
      ['send-keys', '-t', 'cda2', 'L', 'Enter'],
    ]);
  assert.deepEqual(
    T.bringUpPlan({ id: 'cda3', dir: '/tmp', cols: 120, rows: 34, name: 'n', uuid: null, launch: 'R', runtime: 'codex', codexModel: 'gpt-5.5', codexUuid: uuid }),
    [
      ['new-session', '-d', '-s', 'cda3', '-x', '120', '-y', '34', '-c', '/tmp'],
      ['set-option', '-t', 'cda3', 'window-size', 'manual'],
      ['set-option', '-g', 'escape-time', '10'],
      ['set-option', '-t', 'cda3', '@cd_name', 'n'],
      ['set-option', '-t', 'cda3', '@cd_cwd', '/tmp'],
      ['set-option', '-t', 'cda3', '@cd_codex', '1'],
      ['set-option', '-t', 'cda3', '@cd_codex_model', 'gpt-5.5'],
      ['set-option', '-t', 'cda3', '@cd_codex_uuid', uuid],
      ['set-option', '-t', 'cda3', 'status-style', 'bg=#243228,fg=#b9d9c4'],
      ['set-option', '-t', 'cda3', 'mode-style', 'bg=#bfea4b,fg=#17211a'],
      ['send-keys', '-t', 'cda3', 'R', 'Enter'],
    ]);
  assert.deepEqual(
    T.bringUpPlan({ id: 'cda4', dir: '/tmp', cols: 120, rows: 34, name: 'n', uuid: null, launch: null, runtime: 'shell' }),
    [
      ['new-session', '-d', '-s', 'cda4', '-x', '120', '-y', '34', '-c', '/tmp'],
      ['set-option', '-t', 'cda4', 'window-size', 'manual'],
      ['set-option', '-g', 'escape-time', '10'],
      ['set-option', '-t', 'cda4', '@cd_name', 'n'],
      ['set-option', '-t', 'cda4', '@cd_cwd', '/tmp'],
      ['set-option', '-t', 'cda4', '@cd_shell', '1'],
      ['set-option', '-t', 'cda4', 'status-style', 'bg=#243228,fg=#b9d9c4'],
      ['set-option', '-t', 'cda4', 'mode-style', 'bg=#bfea4b,fg=#17211a'],
    ]);
  assert.deepEqual(
    T.bringUpPlan({ id: 'cda5', dir: '/tmp', cols: 120, rows: 34, name: 'n', uuid, launch: 'A', runtime: 'claude', autonomous: true }),
    [
      ['new-session', '-d', '-s', 'cda5', '-x', '120', '-y', '34', '-c', '/tmp'],
      ['set-option', '-t', 'cda5', 'window-size', 'manual'],
      ['set-option', '-g', 'escape-time', '10'],
      ['set-option', '-t', 'cda5', '@cd_name', 'n'],
      ['set-option', '-t', 'cda5', '@cd_cwd', '/tmp'],
      ['set-option', '-t', 'cda5', '@cd_uuid', uuid],
      ['set-option', '-t', 'cda5', '@cd_autonomous', '1'],
      ['set-option', '-t', 'cda5', 'status-style', 'bg=#243228,fg=#b9d9c4'],
      ['set-option', '-t', 'cda5', 'mode-style', 'bg=#bfea4b,fg=#17211a'],
      ['send-keys', '-t', 'cda5', 'A', 'Enter'],
    ]);
  const noRestamp = T.bringUpPlan({ id: 'cda5', dir: '/tmp', cols: 120, rows: 34, name: 'n', uuid: null, launch: 'R', runtime: 'codex', codexUuid: 'not-a-uuid' });
  assert.ok(!noRestamp.some((a) => a.includes('@cd_codex_uuid')));
});
