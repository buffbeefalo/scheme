'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { analyzeTranscript } = require('../lib/telemetry');
const { analyzeCodexRollout } = require('../lib/codex-telemetry');

function renderer() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/vendor/terminal-ui.js'), 'utf8');
  const context = {
    window: {}, document: { documentElement: { dataset: {} } },
    localStorage: { getItem: () => null }, matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    setInterval: () => {},
  };
  // Exercise the actual rail without starting a server, browser timers, or any agent.
  // This seam exists only in the evaluated test copy of the bundle.
  const marker = '  window.CommandDeckTerminal =';
  assert.ok(source.includes(marker));
  vm.runInNewContext(source.replace(marker, `
    els.railBody = { innerHTML: '' };
    window.renderTelemetry = (tel) => { renderRail(tel); return els.railBody.innerHTML; };
${marker}`), context);
  return context.window.renderTelemetry;
}

const codex = (approval, sandbox) => ({ ...analyzeCodexRollout([
  { type: 'turn_context', payload: { approval_policy: approval, sandbox_policy: sandbox } },
]), runtime: 'codex' });
const claude = (mode) => ({ ...analyzeTranscript(mode == null ? [] : [{ permissionMode: mode }]), runtime: 'claude' });

test('missing Claude mode remains unknown while an explicitly observed default is retained', () => {
  const render = renderer();
  const missing = render(claude(null));
  assert.match(missing, /not reported/i);
  assert.doesNotMatch(missing, />default</);
  const reported = render(claude('default'));
  assert.match(reported, /default/);
});

test('Codex approval prompts and sandbox restrictions remain separate observations', () => {
  const render = renderer();
  const readOnly = render(codex('never', { type: 'read-only' }));
  assert.match(readOnly, /never/);
  assert.match(readOnly, /read-only/);
  assert.match(readOnly, /approval/i);
  assert.match(readOnly, /sandbox/i);
  assert.doesNotMatch(readOnly, /unrestricted|full access/i);
  const full = render(codex('never', { type: 'danger-full-access' }));
  assert.match(full, /danger-full-access/);
  assert.notEqual(full, readOnly);
});

test('bypass mode does not hide a pending question or turn it into approval', () => {
  const render = renderer();
  const html = render({ ...claude('bypassPermissions'), needsInput: true, needsInputKind: 'question',
    pendingAsk: { questions: [{ question: 'Which project?', options: [] }] } });
  assert.match(html, /bypassPermissions/);
  assert.match(html, /Which project\?/);
  assert.match(html, /blocked on you/);
});

test('malformed evidence is unknown and arbitrary sandbox payloads never appear in the rail', () => {
  const render = renderer();
  for (const malformed of [null, {}, [], 42, true]) {
    const html = render({ runtime: 'codex', approvalPolicy: malformed,
      sandbox: { type: malformed, writable_roots: ['/private/fixture-only'], token: 'fixture-only-value' } });
    assert.match(html, /not reported/i);
    assert.doesNotMatch(html, /fixture-only|object Object/);
  }
  assert.match(render({ runtime: 'claude', automode: { unexpected: true } }), /not reported/i);
});

test('unfamiliar values are escaped and bounded without gaining known permission semantics', () => {
  const render = renderer();
  const value = '<img src=x onerror="fixture()">' + 'z'.repeat(5000);
  const html = render({ runtime: 'codex', approvalPolicy: value, sandbox: { type: value } });
  assert.doesNotMatch(html, /<img|z{300}/);
  assert.match(html, /unrecognized/i);
  assert.doesNotMatch(html, /self-approval|unrestricted/i);
});

test('session switches clear approval evidence and shell/conflict rails have no agent permissions', () => {
  const render = renderer();
  render(codex('never', { type: 'danger-full-access' }));
  const missing = render(claude(null));
  assert.doesNotMatch(missing, /never|danger-full-access|bypassPermissions/);
  assert.match(missing, /not reported/i);
  for (const runtime of ['shell', 'conflict']) {
    const html = render({ runtime, approvalPolicy: 'never', automode: 'bypassPermissions' });
    assert.doesNotMatch(html, /approval|permission|sandbox/i);
  }
});

test('rendering leaves telemetry evidence unchanged', () => {
  const render = renderer();
  const tel = codex('on-request', { type: 'workspace-write', writable_roots: ['/private/example'] });
  const before = JSON.stringify(tel);
  render(tel);
  assert.equal(JSON.stringify(tel), before);
});

test('recognized Claude badges and a pending plan remain visible', () => {
  const render = renderer();
  for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'auto']) {
    const html = render(claude(mode));
    assert.ok(html.includes('class="cd-mode ' + mode + '"'));
  }
  const plan = render({ ...claude('plan'), needsInput: true, needsInputKind: 'plan', pendingAsk: { plan: 'Build the project' } });
  assert.match(plan, /plan approval/);
  assert.match(plan, /Build the project/);
  assert.match(plan, /blocked on you/);
});
