'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const audit = require('../lib/audit');

function tmpFile() {
  return path.join(os.tmpdir(), `cd-audit-${process.pid}-${Math.floor(Math.random() * 1e9)}.jsonl`);
}

test('formatEntry normalizes fields and stamps the injected time', () => {
  const e = audit.formatEntry({ actor: '127.0.0.1', action: 'control:restart', target: 'example-session', detail: 'ok', ok: true }, 1700000000000);
  assert.equal(e.ts, 1700000000000);
  assert.equal(e.actor, '127.0.0.1');
  assert.equal(e.action, 'control:restart');
  assert.equal(e.target, 'example-session');
  assert.equal(e.ok, true);
});

test('formatEntry defaults ok=true but honors an explicit false', () => {
  assert.equal(audit.formatEntry({ action: 'push' }, 1).ok, true);
  assert.equal(audit.formatEntry({ action: 'push', ok: false }, 1).ok, false);
});

test('formatEntry strips newlines and clamps long detail (no log injection)', () => {
  const e = audit.formatEntry({ action: 'x', detail: 'line1\nline2\ttab' + 'z'.repeat(500) }, 1);
  assert.equal(e.detail.includes('\n'), false);
  assert.equal(e.detail.includes('\t'), false);
  assert.ok(e.detail.length <= 200);
});

test('appendEntry then readRecent round-trips, newest first', () => {
  const file = tmpFile();
  try {
    assert.equal(audit.appendEntry({ action: 'control:stop', target: 'a' }, { file, at: 1 }), true);
    assert.equal(audit.appendEntry({ action: 'push', target: 'b' }, { file, at: 2 }), true);
    const rows = audit.readRecent(10, { file });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].target, 'b'); // newest first
    assert.equal(rows[1].target, 'a');
  } finally { try { fs.unlinkSync(file); } catch {} }
});

test('appendEntry is append-only — a second write keeps the first', () => {
  const file = tmpFile();
  try {
    audit.appendEntry({ action: 'one' }, { file, at: 1 });
    audit.appendEntry({ action: 'two' }, { file, at: 2 });
    const raw = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(raw.length, 2);
  } finally { try { fs.unlinkSync(file); } catch {} }
});

test('readRecent respects the limit', () => {
  const file = tmpFile();
  try {
    for (let i = 0; i < 5; i++) audit.appendEntry({ action: 'a' + i }, { file, at: i });
    assert.equal(audit.readRecent(3, { file }).length, 3);
  } finally { try { fs.unlinkSync(file); } catch {} }
});

test('readRecent on a missing file returns [] and never throws', () => {
  assert.deepEqual(audit.readRecent(10, { file: tmpFile() }), []);
});

test('readRecent skips corrupt lines instead of throwing', () => {
  const file = tmpFile();
  try {
    fs.writeFileSync(file, '{"action":"good","ts":1}\nnot-json\n{"action":"good2","ts":2}\n');
    const rows = audit.readRecent(10, { file });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, 'good2');
  } finally { try { fs.unlinkSync(file); } catch {} }
});
