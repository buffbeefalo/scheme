'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ui = fs.readFileSync('public/vendor/terminal-ui.js', 'utf8');
const body = (name, next) => {
  const start = ui.indexOf(`function ${name}`);
  const end = ui.indexOf(`\n  function ${next}`, start);
  assert.ok(start >= 0 && end > start, `${name} body is extractable`);
  return ui.slice(start, end);
};

test('setActive blanks rail instruments and immediately repolls', () => {
  const setActive = body('setActive', 'connect');
  assert.match(setActive, /applyRt\(s\);[\s\S]*?setTok\(null\);[\s\S]*?renderRail\(null\);/);
  assert.match(setActive, /pollTelemetry\(\);/);
});

test('pollTelemetry queues an immediate repoll behind an in-flight poll', () => {
  const poll = body('pollTelemetry', 'hideScroll');
  assert.match(poll, /if \(telInFlight\) \{\s*telQueued = true;\s*return;\s*\}/);
  assert.match(poll, /finally\s*\{[\s\S]*?telInFlight = false;[\s\S]*?telQueued[\s\S]*?\}/);
});

test('destroy blanks the instruments when the final tab closes', () => {
  const instruments = { runtime: 'codex', tokens: 1200, rail: 'stale activity' };
  const drafts = new Map([['cdexample', 'unsent work']]);
  const saved = new Map([['cd-active', 'cdexample']]);
  let closed = false, disposed = false, removed = false, polls = 0;
  const session = { id: 'cdexample',
    ws: { close() { closed = true; } },
    term: { dispose() { disposed = true; } },
    el: { remove() { removed = true; } } };
  const context = {
    S: new Map([[session.id, session]]), active: session.id,
    missingSessions: new Map(), sessionRevision: 0,
    followActiveTab: false, pendingWheel: 0, lastHist: 0, lastPos: 0, wheelRaf: null,
    els: { empty: { style: { display: 'none' } }, dims: { textContent: '80×24' } },
    localStorage: { removeItem: key => saved.delete(key) }, window: {},
    workspace: { dropSession: id => drafts.delete(id), sync() {} },
    stopSelectionScroll() {}, cancelKeybarTap() {}, paint() {}, scrollPillIntoView() {},
    requestAnimationFrame: callback => callback(), refreshAccountUsage() {},
    applyRt: value => { instruments.runtime = value; },
    setTok: value => { instruments.tokens = value; },
    renderRail: value => { instruments.rail = value; },
    pollTelemetry: () => { polls++; },
  };
  vm.runInNewContext(`${body('setActive', 'connect')}\n${body('destroy', 'pickedRuntime')}\ndestroy('cdexample');`, context);
  assert.deepEqual(instruments, { runtime: undefined, tokens: null, rail: null });
  assert.equal(context.active, null);
  assert.equal(context.S.size, 0);
  assert.equal(drafts.size, 0);
  assert.equal(saved.has('cd-active'), false);
  assert.equal(context.els.empty.style.display, 'flex');
  assert.equal(context.els.dims.textContent, '');
  assert.ok(closed && disposed && removed, 'the closed terminal is fully released');
  assert.equal(polls, 1);
});

test('setTok clears its stale title when telemetry is absent', () => {
  const setTok = body('setTok', 'setRailHTML');
  assert.match(setTok, /if \(!ctx\) \{[\s\S]*?els\.tok\.title = '';/);
});

test('pollTelemetry still gates all instrument writes to the active session', () => {
  const poll = body('pollTelemetry', 'hideScroll');
  assert.match(poll, /if \(x\.id === active\) \{[\s\S]*?setTok\(tel\);[\s\S]*?renderRail\(tel\);[\s\S]*?\}/);
  assert.doesNotMatch(poll, /renderAccountUsage|account-usage/);
});
