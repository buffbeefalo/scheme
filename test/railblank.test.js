'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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
  const destroy = body('destroy', 'pickedRuntime');
  assert.match(destroy, /else \{[\s\S]*?setTok\(null\);[\s\S]*?renderRail\(null\);/);
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
