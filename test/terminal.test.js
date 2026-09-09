'use strict';

// Pure logic for the tmux-backed terminal session manager. The argv builders are
// the security boundary: every user-influenced value (cwd, label, dims, id) must
// travel as a SEPARATE argv token so it can never be shell-interpreted.
//   node --test test/terminal.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('../lib/terminal');

test('isSafeId accepts generated ids, rejects injection/targets', () => {
  assert.equal(T.isSafeId('cd9z7q3'), true);
  assert.equal(T.isSafeId('cd1; rm -rf /'), false);
  assert.equal(T.isSafeId('../evil'), false);
  assert.equal(T.isSafeId('other-session'), false);   // not our prefix
  assert.equal(T.isSafeId(''), false);
});

test('newSessionId produces unique, tmux-safe ids', () => {
  const a = T.newSessionId(), b = T.newSessionId();
  assert.match(a, /^cd[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test('sanitizeLabel strips control chars/newlines and caps length', () => {
  assert.equal(T.sanitizeLabel('  my  bot \n\t rm-rf  '), 'my  bot  rm-rf');
  assert.equal(T.sanitizeLabel(''), 'session');
  assert.equal(T.sanitizeLabel('x'.repeat(100)).length <= 40, true);
  assert.equal(T.sanitizeLabel('', ''), '');            // create asks for "" so it can tell a blank label apart
  assert.equal(T.sanitizeLabel('typed', ''), 'typed');
});

// Ratified lane contract e0458eff clause (e): "Empty-label creation mints a collision-free
// <Runtime> · <HH:MM> name." The literal 'session' default is why six tabs were all called
// "session". Runtime words mirror the client's RT_META labels (terminal-ui.js:149-152).
test('mintSessionName names an unlabelled tab by runtime and creation minute', () => {
  const at = new Date(2026, 7, 17, 9, 5);
  assert.equal(T.mintSessionName('claude', at, []), 'Claude · 09:05');
  assert.equal(T.mintSessionName('codex', at, []), 'Codex · 09:05');
  assert.equal(T.mintSessionName('local', at, []), 'Local · 09:05');
  assert.equal(T.mintSessionName('shell', at, []), 'Shell · 09:05');
  assert.equal(T.mintSessionName('claude', at.getTime(), []), 'Claude · 09:05');   // epoch ms too
});

test('mintSessionName never hands back a name a live tab already carries', () => {
  const at = new Date(2026, 7, 17, 14, 32);
  assert.equal(T.mintSessionName('claude', at, ['some tab']), 'Claude · 14:32');
  assert.equal(T.mintSessionName('claude', at, ['Claude · 14:32']), 'Claude · 14:32 v2');
  assert.equal(T.mintSessionName('claude', at, ['Claude · 14:32', 'Claude · 14:32 v2']), 'Claude · 14:32 v3');
  assert.equal(T.mintSessionName('shell', at, ['Claude · 14:32']), 'Shell · 14:32');   // a different runtime is not a collision
});

test('sanitizePrompt strips terminal control characters before a launch reaches readline', () => {
  assert.equal(T.sanitizePrompt('read this\nthen\tcontinue\u001b[31m'), 'read this then continue [31m');
  assert.equal(T.sanitizePrompt('x'.repeat(17000)).length, 16000);
  const src = fs.readFileSync(require.resolve('../lib/terminal'), 'utf8');
  assert.match(src, /const cleanPrompt = sanitizePrompt\(prompt\);/);
  assert.match(src, /codexLaunchCmd\(cleanPrompt, cm\.model\)/);
  assert.match(src, /launchCmd\(uuid, cleanPrompt,/);
});

test('clampDims coerces to sane integer bounds', () => {
  assert.deepEqual(T.clampDims(120, 40), { cols: 120, rows: 40 });
  assert.deepEqual(T.clampDims(5, 9999), { cols: 20, rows: 200 });   // clamped
  assert.deepEqual(T.clampDims('abc', null), { cols: 80, rows: 24 }); // fallback
});

test('tmuxNewArgs passes cwd as ONE argv token (no shell interpretation)', () => {
  const evil = '/tmp/a b; rm -rf /';
  const args = T.tmuxNewArgs({ id: 'cd1', cwd: evil, cols: 100, rows: 30 });
  assert.deepEqual(args, ['new-session', '-d', '-s', 'cd1', '-x', '100', '-y', '30', '-c', evil]);
  assert.equal(args.filter((a) => a === evil).length, 1);   // intact, single token
});

test('label is stored as a tmux user option, not the session target', () => {
  assert.deepEqual(T.tmuxSetNameArgs('cd1', 'My Bot'), ['set-option', '-t', 'cd1', '@cd_name', 'My Bot']);
});

test('autonomous marker builder writes @cd_autonomous', () => {
  assert.deepEqual(T.tmuxSetAutonomousArgs('cd1'), ['set-option', '-t', 'cd1', '@cd_autonomous', '1']);
});

test('attach/kill/resize/list arg builders', () => {
  assert.deepEqual(T.tmuxAttachArgs('cd1'), ['attach-session', '-t', 'cd1']);
  assert.deepEqual(T.tmuxKillArgs('cd1'), ['kill-session', '-t', 'cd1']);
  assert.deepEqual(T.tmuxResizeArgs('cd1', 100, 30), ['resize-window', '-t', 'cd1', '-x', '100', '-y', '30']);
  assert.ok(T.tmuxListArgs().includes('list-sessions'));
});

test('parseSessions reads our sessions and ignores foreign tmux sessions', () => {
  const out = [
    'cd9z7q3\tsample project debug\t/home/you/ws/projects/networking\t1780000000\t1',
    'cdabc12\t\t/home/you\t1780000100\t0',
    'someones-other-session\tx\t/tmp\t1780000200\t0',   // not ours
  ].join('\n');
  const s = T.parseSessions(out);
  assert.equal(s.length, 2);
  assert.equal(s[0].id, 'cd9z7q3');
  assert.equal(s[0].name, 'sample project debug');
  assert.equal(s[0].cwd, '/home/you/ws/projects/networking');
  assert.equal(s[0].attached, true);
  assert.equal(s[1].attached, false);
});

test('isEphemeralLabel flags "zz " test artifacts but not real tabs', () => {
  assert.equal(T.isEphemeralLabel('zz closetab selftest'), true);
  assert.equal(T.isEphemeralLabel('zz closetab delay'), true);
  assert.equal(T.isEphemeralLabel('ZZ Something'), true);           // case-insensitive
  assert.equal(T.isEphemeralLabel('sample project debug'), false);
  assert.equal(T.isEphemeralLabel('zzz-not-a-space'), false);       // needs the space after "zz"
  assert.equal(T.isEphemeralLabel(''), false);
  assert.equal(T.isEphemeralLabel(null), false);
});

test('parseSessions drops interrupted-test artifacts ("zz …") so they never become a tab', () => {
  const out = [
    'cd9z7q3\tsample project debug\t/home/you/ws\t1780000000\t1',
    'cdleak01\tzz closetab selftest\t/tmp\t1780000100\t0\taaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'cdleak02\tzz closetab delay\t/tmp\t1780000200\t0\tbbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
  ].join('\n');
  const s = T.parseSessions(out);
  assert.equal(s.length, 1);                 // only the real tab survives
  assert.equal(s[0].id, 'cd9z7q3');
  assert.equal(s.some((x) => /^zz /i.test(x.name)), false);
});

test('tmuxArgs prepends -L only when SYSMON_TMUX_SOCKET is set (prod default = untouched)', () => {
  const prev = process.env.SYSMON_TMUX_SOCKET;
  try {
    delete process.env.SYSMON_TMUX_SOCKET;
    assert.deepEqual(T.tmuxArgs(['list-sessions']), ['list-sessions']);   // prod: no socket flag
    process.env.SYSMON_TMUX_SOCKET = 'cdtest';
    assert.deepEqual(T.tmuxArgs(['new-session', '-d', '-s', 'cd1']),
      ['-L', 'cdtest', 'new-session', '-d', '-s', 'cd1']);
  } finally {
    if (prev === undefined) delete process.env.SYSMON_TMUX_SOCKET; else process.env.SYSMON_TMUX_SOCKET = prev;
  }
});

test('parseSessions reads the @cd_local brain marker (and defaults false when absent)', () => {
  const out = [
    'cdlocal1\tlocal code\t/home/you/ws\t1780000000\t0\taaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\t1',
    'cdcloud1\tcloud tab\t/home/you/ws\t1780000001\t0\tffffffff-bbbb-cccc-dddd-eeeeeeeeeeee\t',
    'cdold1\tpre-feature tab\t/home/you\t1780000002\t0',   // 5-field line from an old session
  ].join('\n');
  const s = T.parseSessions(out);
  assert.equal(s.length, 3);
  assert.equal(s[0].local, true);
  assert.equal(s[1].local, false);
  assert.equal(s[2].local, false);
  // The marker builder writes exactly what LIST_FORMAT reads back.
  assert.deepEqual(T.tmuxSetLocalArgs('cd1'), ['set-option', '-t', 'cd1', '@cd_local', '1']);
});

test('launchCmd: picker model injects --model for local tabs only (default & cloud unchanged)', () => {
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const glm = T.launchCmd(uuid, '', true, 'glm-4.7-flash');
  assert.ok(glm.includes('claude-local'), 'local bin');
  assert.ok(glm.includes('--model glm-4.7-flash'), 'model flag injected');
  // default local tab: NO --model flag → wrapper default (ornith:9b since the 2026-07-10 promotion)
  assert.ok(!T.launchCmd(uuid, '', true).includes('--model'));
  assert.ok(!T.launchCmd(uuid, '', true, null).includes('--model'));
  assert.ok(!T.launchCmd(uuid, '', true, 'ornith:9b').includes('--model'), 'ornith is the new default → no flag');
  // baseline is now an EXPLICIT non-default pick → it injects --model
  assert.ok(T.launchCmd(uuid, '', true, 'qwen3-coder:30b').includes('--model qwen3-coder:30b'), 'explicit baseline injects --model');
  // cloud tabs never carry a local model flag, whatever a caller passes
  assert.ok(!T.launchCmd(uuid, '', false, 'glm-4.7-flash').includes('--model'));
  // the guard lives next to the interpolation: a non-allowlisted tag never reaches the launch string
  const evil = T.launchCmd(uuid, '', true, "x'; rm -rf /");
  assert.ok(!evil.includes('--model') && !evil.includes('rm -rf'));
});

test('launchCmd: autonomous Claude scrubs the mint-token while every other launch stays byte-identical', () => {
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const autonomous = T.launchCmd(uuid, 'p', false, null, true);
  const normal = T.launchCmd(uuid, 'p', false, null, false);
  const local = T.launchCmd(uuid, 'p', true, null, true);
  const home = process.env.HOME || require('node:os').homedir();
  const headNormal = `env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_TMPDIR -u AI_AGENT CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 PATH=${home}/.claude/command-deck/bin:"$PATH" BROWSER=${home}/.claude/command-deck/bin/xdg-open ${T.CLAUDE_BIN} --effort max --session-id ${uuid} 'p'`;

  assert.match(autonomous, /-u COMMAND_DECK_AUTONOMOUS_TOKEN/);
  assert.match(autonomous, /--dangerously-skip-permissions/);
  assert.equal(normal.includes('COMMAND_DECK_AUTONOMOUS_TOKEN'), false);
  assert.equal(normal, headNormal, 'normal Claude launch remains byte-identical to HEAD');
  assert.equal(local.includes('--dangerously-skip-permissions'), false);
  assert.equal(local.includes('COMMAND_DECK_AUTONOMOUS_TOKEN'), false);
  assert.ok(autonomous.startsWith('env -u '));
  assert.ok(autonomous.indexOf('-u COMMAND_DECK_AUTONOMOUS_TOKEN') < autonomous.indexOf('='),
    'token scrub is an env -u flag, before NAME=VALUE operands');
});

test('normalizeLocalModel: allowlist-only (the tag is typed into the pane shell)', () => {
  assert.deepEqual(T.normalizeLocalModel(''), { ok: true, model: null });
  assert.deepEqual(T.normalizeLocalModel(undefined), { ok: true, model: null });
  assert.deepEqual(T.normalizeLocalModel('ornith:9b'), { ok: true, model: null });   // new default (2026-07-10) → store nothing
  assert.deepEqual(T.normalizeLocalModel('qwen3-coder:30b'), { ok: true, model: 'qwen3-coder:30b' });   // baseline now an explicit non-default pick
  assert.deepEqual(T.normalizeLocalModel('glm-4.7-flash'), { ok: true, model: 'glm-4.7-flash' });
  assert.deepEqual(T.normalizeLocalModel('qwen3-coder-next'), { ok: true, model: 'qwen3-coder-next' });
  assert.equal(T.normalizeLocalModel("x'; rm -rf /").ok, false);
  assert.equal(T.normalizeLocalModel('llama3.3:70b').ok, false);   // real tag, but not a picker tier
});

test('parseSessions reads @cd_local_model (null when absent, on old lines, and on cloud tabs)', () => {
  const out = [
    'cdglm1\tglm tab\t/home/you/ws\t1780000000\t0\taaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\t1\tglm-4.7-flash',
    'cdbase1\tbaseline tab\t/home/you/ws\t1780000001\t0\tffffffff-bbbb-cccc-dddd-eeeeeeeeeeee\t1\t',
    'cdold1\tpre-picker local tab\t/home/you\t1780000002\t0\tbbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee\t1',
    'cdcloud1\tcloud tab\t/home/you\t1780000003\t0\tcccccccc-bbbb-cccc-dddd-eeeeeeeeeeee\t\tglm-4.7-flash',
  ].join('\n');
  const s = T.parseSessions(out);
  assert.equal(s[0].localModel, 'glm-4.7-flash');
  assert.equal(s[1].localModel, null);
  assert.equal(s[2].localModel, null);
  assert.equal(s[3].localModel, null);   // model marker without the local flag is ignored
  // marker builder ↔ LIST_FORMAT round-trip
  assert.deepEqual(T.tmuxSetLocalModelArgs('cd1', 'glm-4.7-flash'), ['set-option', '-t', 'cd1', '@cd_local_model', 'glm-4.7-flash']);
});

// ---- Codex runtime (third launch type, alongside cloud-claude and claude-local) ----
// LIST_FORMAT field order: name, label, cwd, created, attached, uuid, localFlag, localModel,
// codexFlag, codexModel, codexUuid, shellFlag, panePid  (pane_pid stays LAST). Codex uses
// @cd_codex_uuid for its self-minted session id — kept SEPARATE from @cd_uuid so the Claude
// telemetry path is never handed a codex uuid.
test('parseSessions reads @cd_codex markers (flag, model, captured uuid); codex is not local', () => {
  const cxUuid = '019f3ac3-585e-7d23-990d-01e10eb50fe6';
  const out = [
    `cdcx1\tcodex tab\t/home/you/ws\t1780000000\t0\t\t\t\t1\tgpt-5.4-mini\t${cxUuid}\t\t4321`,
    'cdcx2\tcodex default\t/home/you/ws\t1780000001\t0\t\t\t\t1\t\t\t\t4322',
    'cdcloud1\tcloud tab\t/home/you/ws\t1780000002\t0\taaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\t\t\t\t\t\t\t4323',
  ].join('\n');
  const s = T.parseSessions(out);
  assert.equal(s[0].codex, true);
  assert.equal(s[0].codexModel, 'gpt-5.4-mini');
  assert.equal(s[0].codexUuid, cxUuid);
  assert.equal(s[0].local, false);              // a codex tab is never local
  assert.equal(s[0].uuid, null);                // codex uuid lives in codexUuid, NOT the claude @cd_uuid slot
  assert.equal(s[0].panePid, 4321);             // pane_pid still parses from the new last position
  assert.equal(s[1].codex, true);
  assert.equal(s[1].codexModel, null);          // default codex model → no marker stored
  assert.equal(s[1].codexUuid, null);           // uuid not captured yet (rollout appears after first turn)
  assert.equal(s[2].codex, false);              // cloud tab
  assert.deepEqual(T.tmuxSetCodexArgs('cd1'), ['set-option', '-t', 'cd1', '@cd_codex', '1']);
  assert.deepEqual(T.tmuxSetCodexUuidArgs('cd1', cxUuid), ['set-option', '-t', 'cd1', '@cd_codex_uuid', cxUuid]);
});

test('parseSessions ignores codex model/uuid without the codex flag', () => {
  const out = 'cdx\tt\t/x\t1780000000\t0\t\t\t\t\tgpt-5.4-mini\t019f3ac3-585e-7d23-990d-01e10eb50fe6\t\t9';
  const s = T.parseSessions(out);
  assert.equal(s[0].codex, false);
  assert.equal(s[0].codexModel, null);
  assert.equal(s[0].codexUuid, null);
});

// ---- Plain-terminal runtime (fourth launch type: a bare shell, no agent) ----
test('parseSessions reads the @cd_shell marker (plain-terminal lane); shell is neither local nor codex', () => {
  const out = [
    // field order: …codexModel, codexUuid, shellFlag, panePid (pane_pid stays LAST)
    'cdsh1\tplain term\t/home/you/ws\t1780000000\t0\t\t\t\t\t\t\t1\t555',
    'cdcloud9\tcloud tab\t/home/you/ws\t1780000001\t0\taaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\t\t\t\t\t\t\t556',
    'cdold9\tpre-shell tab\t/home/you\t1780000002\t0',   // old short line → false, never invented
  ].join('\n');
  const s = T.parseSessions(out);
  assert.equal(s[0].shell, true);
  assert.equal(s[0].local, false);
  assert.equal(s[0].codex, false);
  assert.equal(s[0].uuid, null);                // a shell tab has no conversation uuid, ever
  assert.equal(s[0].panePid, 555);              // pid still parses from the (new) last position
  assert.equal(s[1].shell, false);
  assert.equal(s[2].shell, false);
  // marker builder ↔ LIST_FORMAT round-trip, same contract as @cd_local/@cd_codex
  assert.deepEqual(T.tmuxSetShellArgs('cd1'), ['set-option', '-t', 'cd1', '@cd_shell', '1']);
});

test('parseSessions reads @cd_autonomous only from its marker and preserves old pane_pid lines', () => {
  const current = ['cdauto1', 'autonomous tab', '/tmp', '1780000000', '0', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '', '', '', '', '', '', '1', '4321'].join('\t');
  const old = ['cdoldauto', 'old tab', '/tmp', '1780000001', '0', 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', '', '', '', '', '', '', '4322'].join('\t');
  const s = T.parseSessions([current, old].join('\n'));
  assert.equal(s[0].autonomous, true);
  assert.equal(s[0].panePid, 4321);
  assert.equal(s[1].autonomous, false);
  assert.equal(s[1].panePid, 4322);
});

test('normalizeCodexModel: Astra inherits config; an explicit former default stays pinned', () => {
  assert.deepEqual(T.normalizeCodexModel(''), { ok: true, model: null });
  assert.deepEqual(T.normalizeCodexModel(undefined), { ok: true, model: null });
  assert.deepEqual(T.normalizeCodexModel('gpt-6-astra'), { ok: true, model: null });
  assert.deepEqual(T.normalizeCodexModel('gpt-5.6-sol'), { ok: true, model: 'gpt-5.6-sol' });
  assert.deepEqual(T.normalizeCodexModel('gpt-5.6-terra'), { ok: true, model: 'gpt-5.6-terra' });
  assert.deepEqual(T.normalizeCodexModel('gpt-5.6-luna'), { ok: true, model: 'gpt-5.6-luna' });
  // gpt-5.5 was the default until 2026-07-16; the config default moved under it, so an explicit
  // 5.5 pick must now PIN (-c) — "no marker" would silently run terra while the tab claims 5.5.
  assert.deepEqual(T.normalizeCodexModel('gpt-5.5'), { ok: true, model: 'gpt-5.5' });
  assert.equal(T.normalizeCodexModel('gpt-5.4-mini').ok, false);                           // dropped: luna covers the light tier (no live tab stored it)
  assert.equal(T.normalizeCodexModel('o3').ok, false);                                     // real-ish but not allowlisted
  assert.equal(T.normalizeCodexModel('codex-auto-review').ok, false);                      // review-only, excluded
  assert.equal(T.normalizeCodexModel('gpt-5.6-terra"; rm -rf /').ok, false);
});

test('codexLaunchCmd: always --no-alt-screen, codex bin, no --session-id/--effort', () => {
  const plain = T.codexLaunchCmd('', null);
  assert.ok(/\bcodex\b/.test(plain), 'codex bin');
  assert.ok(plain.includes('--no-alt-screen'), 'inline mode forced → tmux scrollback works');
  assert.ok(!plain.includes('--session-id'), 'codex has no --session-id to pin');
  assert.ok(!plain.includes('--effort'), 'no claude effort knob on codex');
  assert.ok(!plain.includes('-c '), 'default model → no -c override');
  assert.ok(!T.codexLaunchCmd('', 'gpt-6-astra').includes('-c '));
  assert.ok(T.codexLaunchCmd('', 'gpt-5.6-sol').includes('model="gpt-5.6-sol"'));
  const luna = T.codexLaunchCmd('', 'gpt-5.6-luna');
  assert.ok(luna.includes('model="gpt-5.6-luna"'), 'non-default model → -c model override');
  const prior = T.codexLaunchCmd('', 'gpt-5.5');
  assert.ok(prior.includes('model="gpt-5.5"'), 'prior default now pins explicitly');
  const withPrompt = T.codexLaunchCmd('fix the bug', null);
  assert.ok(withPrompt.includes("'fix the bug'"), 'starting prompt shell-quoted as one token');
  const evil = T.codexLaunchCmd('', 'gpt-5.6-terra"; rm -rf /');   // not allowlisted → never interpolated
  assert.ok(!evil.includes('rm -rf'), 'guard at the interpolation, not only the API boundary');
});

test('Codex hook enrichment stays gated when 0.144.6 requires broad trust bypass', () => {
  assert.deepEqual(T.CODEX_HOOK_ENRICHMENT, {
    enabled: false,
    verifiedVersion: '0.144.6',
    reason: 'scoped-hooks-require-broad-trust-bypass',
  });
  assert.equal(T.codexHookLaunchArgs({
    tabId: 'cdtelemetry01',
    generationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    journalDir: '/tmp/codex-hooks',
  }), null);
  for (const command of [T.codexLaunchCmd('', null), T.codexResumeCmd('019f3ac3-585e-7d23-990d-01e10eb50fe6')]) {
    assert.doesNotMatch(command, /codex-hook-writer/);
    assert.doesNotMatch(command, /dangerously-bypass-hook-trust/);
  }
});

test('codex default + allowlist track the box truth sources (config.toml model; models_cache slugs)', (t) => {
  // The backend-default path types NO `-c model=` override — its meaning is literally "whatever
  // ~/.codex/config.toml pins". Re-derive that claim from the truth sources so config churn cannot
  // make an explicit request for the former default silently disappear.
  const home = process.env.HOME || require('node:os').homedir();
  const cfg = `${home}/.codex/config.toml`, cache = `${home}/.codex/models_cache.json`;
  if (!fs.existsSync(cfg) || !fs.existsSync(cache)) return t.skip('no codex install on this box');
  // Top-level `model = "…"` only (preamble before the first [section]) — profile/section models
  // don't shape a CD launch, which never passes --profile.
  const preamble = fs.readFileSync(cfg, 'utf8').split(/^\[/m)[0];
  const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(preamble);
  if (m) {
    assert.equal(T.CODEX_MODEL_DEFAULT, m[1],
      'backend default must equal the config.toml model — the default path types no -c override');
  }
  const visible = new Set((JSON.parse(fs.readFileSync(cache, 'utf8')).models || [])
    .filter((x) => x && x.visibility !== 'hide').map((x) => x.slug));
  for (const tag of T.CODEX_MODELS) {
    assert.ok(visible.has(tag), `allowed model '${tag}' is not a visible slug in models_cache.json`);
  }
});

test('codex bin: resolved path must exist on this box, or be a bare PATH name', () => {
  // 2026-07-16 incident: codex 0.144 replaced the npm-global wrapper with a standalone install
  // (~/.local/bin/codex symlink → ~/.codex/packages/...), so the old hardcoded default 404'd IN THE
  // PANE — send-keys "succeeded", bash printed "No such file or directory", and the tab sat as a
  // bare shell. A /\bcodex\b/ shape check can't catch a dead path; this asserts against the disk.
  const bin = T.codexLaunchCmd('', null).split(' --no-alt-screen')[0].split(' ').pop();
  assert.ok(bin === 'codex' || fs.existsSync(bin),
    `codex bin '${bin}' does not exist on disk and is not a bare PATH-resolved name`);
});

test('codexResumeCmd: resume <uuid> in inline mode; bad uuid degrades to a fresh launch', () => {
  const uuid = '019f3ac3-585e-7d23-990d-01e10eb50fe6';
  const cmd = T.codexResumeCmd(uuid);
  assert.ok(cmd.includes('--no-alt-screen'));
  assert.ok(cmd.includes(`resume ${uuid}`), 'resumes the captured session by id');
  const bad = T.codexResumeCmd('not-a-uuid');
  assert.ok(!bad.includes('resume not-a-uuid'), 'a corrupt uuid is never typed as a resume target');
  assert.ok(bad.includes('--no-alt-screen'), 'still a valid fresh codex launch');
});

test('tmuxSetEscapeArgs lowers escape-time globally (responsive ESC/arrows on slow links)', () => {
  assert.deepEqual(T.tmuxSetEscapeArgs(), ['set-option', '-g', 'escape-time', '10']);
});

test('tuneSocket disables Nagle (TCP_NODELAY) on the terminal transport', () => {
  let called = null;
  const fake = { setNoDelay: (v) => { called = v; } };
  assert.equal(T.tuneSocket(fake), fake);   // returns the socket for chaining
  assert.equal(called, true);
  // resilient: never throws on a socket without setNoDelay (half-open / stub)
  assert.doesNotThrow(() => T.tuneSocket({}));
  assert.doesNotThrow(() => T.tuneSocket(null));
});

// ── "jump to previous input" (session-bar button) ──────────────────────────────
// Claude's TUI renders every SUBMITTED user message at column 0 as "❯ <text>"; the
// live input box is a bare "❯ " (no text). The regex anchors to line-start and requires
// a non-space after the prompt so it matches real inputs but skips the empty box AND a
// stray ❯ appearing mid-line in Claude's output. (tmux copy-mode honours this regex —
// verified live.)
test('PROMPT_SEARCH_RE matches a submitted ❯ input but skips the empty box and mid-line ❯', () => {
  const re = new RegExp(T.PROMPT_SEARCH_RE);
  assert.equal(re.test('❯ continue'), true);                    // real submitted input
  assert.equal(re.test('❯ Analyze the architecture'), true);
  assert.equal(re.test('❯ '), false);                           // live input box — must be skipped
  assert.equal(re.test('❯'), false);                            // bare prompt, no space
  assert.equal(re.test('reply with an inline ❯ symbol'), false);// mid-line ❯ — not at column 0
});

test('tmuxPrevInputArgs builds a copy-mode backward search with the regex as ONE argv token', () => {
  const args = T.tmuxPrevInputArgs('cd1');
  assert.deepEqual(args, ['send-keys', '-t', 'cd1', '-X', 'search-backward', '^❯ [^ ]']);
  assert.equal(args.filter((a) => a === T.PROMPT_SEARCH_RE).length, 1);   // single token, no shell splitting
});

// ---- intervention surface: respond to a blocked agent from the cockpit ----
test('sanitizeResponse removes control chars, trims, and clamps length', () => {
  assert.equal(T.sanitizeResponse('yes, proceed'), 'yes, proceed');
  const out = T.sanitizeResponse('a\x1b b\x00c\r\nd');
  assert.equal(/[\x00-\x1f\x7f]/.test(out), false);   // no control chars survive (can't corrupt the TUI)
  assert.equal(T.sanitizeResponse('  spaced  '), 'spaced');
  assert.equal(T.sanitizeResponse('x'.repeat(5000)).length, 4000);
  assert.equal(T.sanitizeResponse(''), '');
  assert.equal(T.sanitizeResponse(null), '');
});

test('tmuxSendLiteralArgs sends the response as ONE literal argv token (no shell, no key-name lookup)', () => {
  const evil = 'rm -rf / ; echo $(whoami)';
  const args = T.tmuxSendLiteralArgs('cd1', evil);
  assert.deepEqual(args, ['send-keys', '-t', 'cd1', '-l', '--', evil]);
  assert.equal(args[args.length - 1], evil);          // verbatim single token → execFile, never a shell
});

test('tmuxEnterArgs submits with a standalone Enter (sent separately to dodge the composer race)', () => {
  assert.deepEqual(T.tmuxEnterArgs('cd1'), ['send-keys', '-t', 'cd1', 'Enter']);
});

test('tmux status/mode style args theme the well chrome, scoped to ONE session (never -g)', () => {
  assert.deepEqual(T.tmuxStatusStyleArgs('cd1'), ['set-option', '-t', 'cd1', 'status-style', 'bg=#243228,fg=#b9d9c4']);
  assert.deepEqual(T.tmuxModeStyleArgs('cd1'), ['set-option', '-t', 'cd1', 'mode-style', 'bg=#bfea4b,fg=#17211a']);
  assert.equal(T.tmuxStatusStyleArgs('cd1').includes('-g'), false);   // must never leak onto foreign sessions
});

// ---- honest resume outcomes (NEW-cmddeck-4) --------------------------------
// resumeSession returns a REASON instead of a bare boolean so resumeSaved can log an honest
// per-session outcome. A bad uuid is rejected BEFORE any tmux is touched (deterministic here).
test('resumeSession reports reason "bad-uuid" and spawns no tmux for an invalid uuid', async () => {
  assert.deepEqual(await T.resumeSession({ id: 'cdabc12', uuid: 'not-a-uuid' }), { ok: false, reason: 'bad-uuid' });
  assert.deepEqual(await T.resumeSession({ id: 'not-a-cd-id', uuid: '11111111-1111-1111-1111-111111111111' }), { ok: false, reason: 'bad-uuid' });
  assert.deepEqual(await T.resumeSession(null), { ok: false, reason: 'bad-uuid' });
});

// ---- admission gate (NEW-cmddeck-5) ----------------------------------------
test('admissionDecision refuses at the session cap and under the memory floor, else admits', () => {
  assert.deepEqual(T.admissionDecision({ liveCount: 12, memMb: 99999, max: 12, floor: 8000 }), { ok: false, error: 'session cap' });
  assert.deepEqual(T.admissionDecision({ liveCount: 99, memMb: 99999, max: 12, floor: 8000 }), { ok: false, error: 'session cap' });
  assert.deepEqual(T.admissionDecision({ liveCount: 3, memMb: 500, max: 12, floor: 8000 }), { ok: false, error: 'low memory' });
  assert.deepEqual(T.admissionDecision({ liveCount: 3, memMb: 99999, max: 12, floor: 8000 }), { ok: true });
  assert.deepEqual(T.admissionDecision({ liveCount: 3, memMb: null, max: 12, floor: 8000 }), { ok: true });   // unreadable mem → fail open
});

test('admissionDecision reads env bounds (SYSMON_MAX_SESSIONS / SYSMON_MEM_FLOOR_MB), respecting 0', () => {
  const prevMax = process.env.SYSMON_MAX_SESSIONS, prevFloor = process.env.SYSMON_MEM_FLOOR_MB;
  process.env.SYSMON_MAX_SESSIONS = '2'; process.env.SYSMON_MEM_FLOOR_MB = '16000';
  try {
    assert.equal(T.admissionDecision({ liveCount: 2, memMb: 99999 }).error, 'session cap');   // cap 2
    assert.equal(T.admissionDecision({ liveCount: 0, memMb: 15000 }).error, 'low memory');     // floor 16000
    assert.equal(T.admissionDecision({ liveCount: 0, memMb: 99999 }).ok, true);
  } finally {
    if (prevMax == null) delete process.env.SYSMON_MAX_SESSIONS; else process.env.SYSMON_MAX_SESSIONS = prevMax;
    if (prevFloor == null) delete process.env.SYSMON_MEM_FLOOR_MB; else process.env.SYSMON_MEM_FLOOR_MB = prevFloor;
  }
});

// Required by the item: an over-cap createSession refuses with {ok:false,error:"session cap"} and
// creates NO tmux session. Cap 0 forces refusal regardless of the box's live count; the gate runs
// before any tmux new-session, so this is side-effect-free alongside the live server.
test('createSession refuses over the cap with {ok:false,error:"session cap"} (no session spawned)', async () => {
  const prev = process.env.SYSMON_MAX_SESSIONS;
  process.env.SYSMON_MAX_SESSIONS = '0';
  try {
    const r = await T.createSession({ label: 'zz cap selftest', cwd: '/tmp' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'session cap');
    assert.equal(r.capped, true);
  } finally {
    if (prev == null) delete process.env.SYSMON_MAX_SESSIONS; else process.env.SYSMON_MAX_SESSIONS = prev;
  }
});

test('createSession rejects autonomous non-Claude runtimes and missing cwd before spawning', async () => {
  const prevMax = process.env.SYSMON_MAX_SESSIONS;
  const prevFloor = process.env.SYSMON_MEM_FLOOR_MB;
  const prevSocket = process.env.SYSMON_TMUX_SOCKET;
  process.env.SYSMON_MAX_SESSIONS = '9999';
  process.env.SYSMON_MEM_FLOOR_MB = '0';
  process.env.SYSMON_TMUX_SOCKET = `cdautoguard${process.pid}`;
  try {
    T.invalidateSessions();
    for (const flags of [{ local: true }, { codex: true }, { shell: true }]) {
      assert.deepEqual(await T.createSession({ label: 'autonomous guard', cwd: '/tmp', autonomous: true, ...flags }),
        { ok: false, error: 'autonomous is a claude-only capability' });
    }
    assert.deepEqual(await T.createSession({ label: 'autonomous missing cwd', cwd: `/tmp/cd-autonomous-missing-${process.pid}`, autonomous: true }),
      { ok: false, error: 'autonomous session requires an existing cwd' });
  } finally {
    T.invalidateSessions();
    if (prevMax == null) delete process.env.SYSMON_MAX_SESSIONS; else process.env.SYSMON_MAX_SESSIONS = prevMax;
    if (prevFloor == null) delete process.env.SYSMON_MEM_FLOOR_MB; else process.env.SYSMON_MEM_FLOOR_MB = prevFloor;
    if (prevSocket == null) delete process.env.SYSMON_TMUX_SOCKET; else process.env.SYSMON_TMUX_SOCKET = prevSocket;
  }
});

test('integration: autonomous create stamps the marker, skip-permissions launch, and registry', { skip: process.env.SYSMON_INTEGRATION === '1' ? false : 'set SYSMON_INTEGRATION=1 to run (spawns a real tmux session)' }, async (t) => {
  const { execFile } = require('node:child_process');
  const registry = require('../lib/registry');
  const prevMax = process.env.SYSMON_MAX_SESSIONS;
  const prevFloor = process.env.SYSMON_MEM_FLOOR_MB;
  const prevRegistry = process.env.COMMAND_DECK_REGISTRY;
  const prevSocket = process.env.SYSMON_TMUX_SOCKET;
  const socket = `cdauto${process.pid}${Date.now().toString(36)}`;
  const registryFile = `/tmp/cd-autonomous-create-${process.pid}-${Date.now()}.json`;
  const tmux = (args) => new Promise((resolve) => {
    execFile('tmux', ['-L', socket, ...args], (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
  let id = '';
  process.env.SYSMON_MAX_SESSIONS = '9999';
  process.env.SYSMON_MEM_FLOOR_MB = '0';
  process.env.COMMAND_DECK_REGISTRY = registryFile;
  process.env.SYSMON_TMUX_SOCKET = socket;
  try {
    T.invalidateSessions();
    const created = await T.createSession({ label: 'autonomous create probe', cwd: '/tmp', autonomous: true });
    if (!created || !created.ok) return t.skip('tmux unavailable');
    id = created.session.id;
    assert.equal(created.session.autonomous, true);
    const live = (await T.listSessions()).find((s) => s.id === id);
    assert.ok(live && live.autonomous, '@cd_autonomous round-trips through tmux');
    const cap = await tmux(['capture-pane', '-p', '-J', '-S', '-', '-t', id]);   // -J joins soft-wrapped lines: an 80-col pane splits the long launch line otherwise
    assert.match(cap.stdout, /--dangerously-skip-permissions/, 'the fresh Claude launch carries skip-permissions');
    assert.equal(registry.readAll().find((s) => s.id === id).autonomous, true, 'registry persists autonomous:true');
  } finally {
    if (id) await T.killSession(id);
    await tmux(['kill-server']);
    T.invalidateSessions();
    try { fs.rmSync(registryFile, { force: true }); } catch {}
    if (prevMax == null) delete process.env.SYSMON_MAX_SESSIONS; else process.env.SYSMON_MAX_SESSIONS = prevMax;
    if (prevFloor == null) delete process.env.SYSMON_MEM_FLOOR_MB; else process.env.SYSMON_MEM_FLOOR_MB = prevFloor;
    if (prevRegistry == null) delete process.env.COMMAND_DECK_REGISTRY; else process.env.COMMAND_DECK_REGISTRY = prevRegistry;
    if (prevSocket == null) delete process.env.SYSMON_TMUX_SOCKET; else process.env.SYSMON_TMUX_SOCKET = prevSocket;
  }
});

test('integration: unlabelled tabs get minted runtime·minute names, distinct from each other', { skip: process.env.SYSMON_INTEGRATION === '1' ? false : 'set SYSMON_INTEGRATION=1 to run (spawns real tmux sessions)' }, async (t) => {
  const { execFile } = require('node:child_process');
  const registry = require('../lib/registry');
  const prevMax = process.env.SYSMON_MAX_SESSIONS;
  const prevFloor = process.env.SYSMON_MEM_FLOOR_MB;
  const prevRegistry = process.env.COMMAND_DECK_REGISTRY;
  const prevSocket = process.env.SYSMON_TMUX_SOCKET;
  const socket = `cdmint${process.pid}${Date.now().toString(36)}`;
  const registryFile = `/tmp/cd-mint-${process.pid}-${Date.now()}.json`;
  const tmux = (args) => new Promise((resolve) => {
    execFile('tmux', ['-L', socket, ...args], (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
  });
  const ids = [];
  process.env.SYSMON_MAX_SESSIONS = '9999';
  process.env.SYSMON_MEM_FLOOR_MB = '0';
  process.env.COMMAND_DECK_REGISTRY = registryFile;
  process.env.SYSMON_TMUX_SOCKET = socket;
  try {
    T.invalidateSessions();
    // Plain-shell tabs: a bare bash pane, so this proves the naming without launching an agent.
    const first = await T.createSession({ cwd: '/tmp', shell: true });
    if (!first || !first.ok) return t.skip('tmux unavailable');
    ids.push(first.session.id);
    assert.match(first.session.name, /^Shell · \d{2}:\d{2}$/, 'no label mints "Shell · HH:MM"');
    const second = await T.createSession({ cwd: '/tmp', shell: true });
    assert.equal(second.ok, true);
    ids.push(second.session.id);
    assert.notEqual(second.session.name, first.session.name, 'a same-minute sibling is still distinguishable');
    assert.match(second.session.name, /^Shell · \d{2}:\d{2}( v2)?$/);
    // A typed label is untouched, and the minted name reaches both tmux and the durable registry.
    const named = await T.createSession({ cwd: '/tmp', shell: true, label: 'zz mint typed' });
    assert.equal(named.session.name, 'zz mint typed');
    ids.push(named.session.id);
    const live = await T.listSessions();
    assert.equal(live.find((s) => s.id === first.session.id).name, first.session.name, 'minted name round-trips through tmux');
    assert.equal(registry.readAll().find((s) => s.id === first.session.id).label, first.session.name, 'registry persists the minted name');
    assert.equal(live.filter((s) => s.name === 'session').length, 0, 'nothing is called the literal "session"');
  } finally {
    for (const id of ids) await T.killSession(id);
    await tmux(['kill-server']);
    T.invalidateSessions();
    try { fs.rmSync(registryFile, { force: true }); } catch {}
    if (prevMax == null) delete process.env.SYSMON_MAX_SESSIONS; else process.env.SYSMON_MAX_SESSIONS = prevMax;
    if (prevFloor == null) delete process.env.SYSMON_MEM_FLOOR_MB; else process.env.SYSMON_MEM_FLOOR_MB = prevFloor;
    if (prevRegistry == null) delete process.env.COMMAND_DECK_REGISTRY; else process.env.COMMAND_DECK_REGISTRY = prevRegistry;
    if (prevSocket == null) delete process.env.SYSMON_TMUX_SOCKET; else process.env.SYSMON_TMUX_SOCKET = prevSocket;
  }
});

test('killSession forgets only sessions tmux confirms gone', async () => {
  const childProcess = require('node:child_process');
  const registry = require('../lib/registry');
  const terminalPath = require.resolve('../lib/terminal');
  const dir = fs.mkdtempSync('/tmp/cd-autonomous-kill-');
  const prevRegistry = process.env.COMMAND_DECK_REGISTRY;
  const prevSocket = process.env.SYSMON_TMUX_SOCKET;
  const originalExecFile = childProcess.execFile;
  let live = false;
  process.env.COMMAND_DECK_REGISTRY = `${dir}/sessions.json`;
  delete process.env.SYSMON_TMUX_SOCKET;
  childProcess.execFile = (_file, args, _opts, done) => {
    const failed = Object.assign(new Error('tmux failed'), { code: 1 });
    if (args[0] === 'kill-session') return process.nextTick(() => done(failed, '', 'kill failed'));
    if (args[0] === 'has-session') return process.nextTick(() => done(live ? null : failed, '', live ? '' : 'no session'));
    return process.nextTick(() => done(failed, '', 'unexpected tmux call'));
  };
  try {
    delete require.cache[terminalPath];
    const fresh = require('../lib/terminal');
    registry.upsert({ id: 'cdkilldead', label: 'dead', cwd: '/tmp' });
    assert.deepEqual(await fresh.killSession('cdkilldead'), { ok: true });
    assert.equal(registry.readAll().some((s) => s.id === 'cdkilldead'), false);
    live = true;
    registry.upsert({ id: 'cdkilllive', label: 'live', cwd: '/tmp' });
    assert.deepEqual(await fresh.killSession('cdkilllive'), { ok: false, error: 'kill failed' });
    assert.equal(registry.readAll().some((s) => s.id === 'cdkilllive'), true);
  } finally {
    childProcess.execFile = originalExecFile;
    delete require.cache[terminalPath];
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (prevRegistry == null) delete process.env.COMMAND_DECK_REGISTRY; else process.env.COMMAND_DECK_REGISTRY = prevRegistry;
    if (prevSocket == null) delete process.env.SYSMON_TMUX_SOCKET; else process.env.SYSMON_TMUX_SOCKET = prevSocket;
  }
});

// resumeSaved reports VERIFIED-live tabs, not launches issued. 2026-09-01 12:29 reboot: tmux's socket
// dir was gone, `new-session` still exited 0 for every saved tab, none stayed up, and the self-heal
// loop logged "re-revived 7/7" every 15s for ~20 minutes — its 0-revived backoff keys on this count
// and never engaged. A tab counts only if tmux still lists it after the settle window.
test('resumeSaved counts a tab only when tmux still lists it after the settle window', async () => {
  const childProcess = require('node:child_process');
  const registry = require('../lib/registry');
  const terminalPath = require.resolve('../lib/terminal');
  const dir = fs.mkdtempSync('/tmp/cd-resume-verify-');
  const prev = {};
  for (const k of ['COMMAND_DECK_REGISTRY', 'SYSMON_TMUX_SOCKET', 'COMMAND_DECK_RESUME_STAGGER_MS', 'COMMAND_DECK_RESUME_VERIFY_MS', 'SYSMON_MEM_FLOOR_MB']) prev[k] = process.env[k];
  const originalExecFile = childProcess.execFile;
  process.env.COMMAND_DECK_REGISTRY = `${dir}/sessions.json`;
  delete process.env.SYSMON_TMUX_SOCKET;
  process.env.COMMAND_DECK_RESUME_STAGGER_MS = '1';
  process.env.COMMAND_DECK_RESUME_VERIFY_MS = '1';
  process.env.SYSMON_MEM_FLOOR_MB = '0';
  // Fake tmux: every command "succeeds"; list-sessions answers from `listing`. With `sticks` off a
  // launch never shows up (the reboot failure); with it on, new-session makes the tab appear.
  const uuid = '22222222-2222-2222-2222-222222222222';
  const row = (id) => `${id}\tverify probe\t/tmp\t1700000000\t0\t${uuid}\t\t\t\t\t\t\t\t123\n`;
  let listing = '', sticks = false, launches = 0;
  childProcess.execFile = (_file, args, _opts, done) => {
    if (args[0] === 'new-session') { launches++; if (sticks) listing = row(args[3]); }
    if (args[0] === 'list-sessions') return process.nextTick(() => done(null, listing, ''));
    return process.nextTick(() => done(null, '', ''));
  };
  try {
    delete require.cache[terminalPath];
    const fresh = require('../lib/terminal');
    registry.upsert({ id: 'cdverifydead', label: 'verify probe', cwd: '/tmp', uuid, createdAt: Date.now() });
    const dead = await fresh.resumeSaved();
    assert.equal(launches, 1, 'the saved tab was launched');
    assert.deepEqual({ resumed: dead.resumed, issued: dead.issued, total: dead.total, verified: dead.verified },
      { resumed: 0, issued: 1, total: 1, verified: true }, 'a launch that never appears in tmux is not a revived tab');
    assert.match(fresh.resumeSummary(dead), /1 launched but not live/);
    sticks = true;
    fresh.invalidateSessions();
    const alive = await fresh.resumeSaved();
    assert.equal(launches, 2);
    assert.deepEqual({ resumed: alive.resumed, issued: alive.issued, verified: alive.verified }, { resumed: 1, issued: 1, verified: true });
    assert.equal(fresh.resumeSummary(alive), '');
  } finally {
    childProcess.execFile = originalExecFile;
    delete require.cache[terminalPath];
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
});

// ── self-heal watchdog decision (total-death only) ──────────────────────────
// Pure gate for the reboot-recovery watchdog: after a mid-life tmux-server death re-revive
// saved tabs, but ONLY on TRUSTWORTHY TOTAL death — a transient tmux probe error (trustworthy
// false) must not be read as "down", partial loss (>=1 live) must be ignored, a resume already
// in flight (healing) must not double-run, and an unrevivable registry (backoff) must not loop.
// Mirrors admissionDecision: pure inputs -> boolean; the impure watchdog feeds it real counts.
const heal = (o) => T.shouldSelfHeal({ savedCount: 5, liveCount: 0, trustworthy: true, healing: false, backoff: false, ...o });
test('shouldSelfHeal fires on trustworthy total death (saved tabs, zero live, server truly gone)', () => {
  assert.equal(heal({}), true);
});
test('shouldSelfHeal does NOT fire on a transient tmux error (untrustworthy zero — server may be up)', () => {
  assert.equal(heal({ trustworthy: false }), false);
});
test('shouldSelfHeal holds while any tab is still live (partial loss is NOT healed)', () => {
  assert.equal(heal({ liveCount: 1 }), false);
});
test('shouldSelfHeal does nothing when there are no saved tabs to revive', () => {
  assert.equal(heal({ savedCount: 0 }), false);
});
test('shouldSelfHeal is re-entrancy-guarded while a resume is already in flight', () => {
  assert.equal(heal({ healing: true }), false);
});
test('shouldSelfHeal backs off after an unproductive heal (nothing was revivable)', () => {
  assert.equal(heal({ backoff: true }), false);
});

test('parseSessions reads #{pane_pid} (now the 14th/last field) for per-session resource attribution', () => {
  // Field order after adding the codex + shell + autonomous markers: …uuid, localFlag, localModel, codexFlag,
  // codexModel, codexUuid, shellFlag, autonomousFlag, panePid — pane_pid stays LAST (single-pane sessions expand
  // it to the pane's root pid). Seven empty inter-fields sit between the uuid and the pid here.
  const out = [
    'cdp1\ttab\t/home/you/ws\t1780000000\t0\taaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\t\t\t\t\t\t\t\t12345',
    'cdp2\told tab\t/home/you\t1780000001\t0',                                             // pre-v2 short line
    'cdp3\tgarbage\t/home/you\t1780000002\t0\tbbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee\t\t\t\t\t\t\t\tnotapid',
  ].join('\n');
  const s = T.parseSessions(out);
  assert.equal(s[0].panePid, 12345);
  assert.equal(s[1].panePid, null);          // short line → no invented pid
  assert.equal(s[2].panePid, null);          // non-numeric → null
  assert.ok(T.LIST_FORMAT.includes('#{pane_pid}'), 'format string carries the field');
  assert.ok(T.LIST_FORMAT.includes('#{@cd_autonomous}\t#{pane_pid}'), 'autonomous marker precedes pane_pid');
  assert.ok(T.LIST_FORMAT.trim().endsWith('#{pane_pid}'), 'pane_pid stays the LAST field');
});
