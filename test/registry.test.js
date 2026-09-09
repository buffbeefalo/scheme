'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Point the registry at a temp file BEFORE requiring it.
const TMP = path.join(os.tmpdir(), `cd-reg-test-${process.pid}.json`);
process.env.COMMAND_DECK_REGISTRY = TMP;
const reg = require('../lib/registry');
const reset = () => { try { fs.unlinkSync(TMP); } catch {} };

function seed(sessions = []) {
  fs.writeFileSync(TMP, JSON.stringify({ version: 1, sessions }, null, 2));
}

function writer(operation) {
  const script = path.join(__dirname, 'fixtures', 'registry-writer.js');
  const child = spawn(process.execPath, [script, JSON.stringify(operation)], {
    env: { ...process.env, COMMAND_DECK_REGISTRY: TMP },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyDone = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!readyDone && stdout.includes('ready\n')) { readyDone = true; resolveReady(); }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => { rejectReady(error); reject(error); });
    child.once('exit', (code, signal) => {
      if (!readyDone) rejectReady(new Error(`writer exited before ready: ${code || signal} ${stderr}`));
      if (code !== 0) return reject(new Error(`writer failed: ${code || signal} ${stderr}`));
      const lines = stdout.trim().split('\n');
      try { resolve(JSON.parse(lines.at(-1))); }
      catch { reject(new Error(`writer returned malformed output: ${stdout} ${stderr}`)); }
    });
  });
  return { child, ready, done };
}

async function runWriters(operations) {
  const workers = operations.map(writer);
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.end('go\n');
  return Promise.all(workers.map((worker) => worker.done));
}

test('readAll on missing file → []', () => {
  reset();
  assert.deepStrictEqual(reg.readAll(), []);
});

test('upsert adds, then updates by id (other fields preserved)', () => {
  reset();
  reg.upsert({ id: 'cd1', label: 'a', cwd: '/x', uuid: 'u1' });
  reg.upsert({ id: 'cd2', label: 'b', cwd: '/y', uuid: 'u2' });
  assert.strictEqual(reg.readAll().length, 2);
  reg.upsert({ id: 'cd1', label: 'a2' });
  const cd1 = reg.readAll().find((s) => s.id === 'cd1');
  assert.strictEqual(cd1.label, 'a2');
  assert.strictEqual(cd1.cwd, '/x');           // untouched field preserved
  assert.strictEqual(reg.readAll().length, 2); // still 2 (update, not insert)
});

test('setLabel changes only the label; false for unknown id', () => {
  reset();
  reg.upsert({ id: 'cd1', label: 'a', cwd: '/x', uuid: 'u1' });
  assert.strictEqual(reg.setLabel('cd1', 'renamed'), true);
  assert.strictEqual(reg.readAll()[0].label, 'renamed');
  assert.strictEqual(reg.setLabel('nope', 'x'), false);
});

test('remove deletes by id and is idempotent', () => {
  reset();
  reg.upsert({ id: 'cd1', label: 'a', cwd: '/x', uuid: 'u1' });
  reg.upsert({ id: 'cd2', label: 'b', cwd: '/y', uuid: 'u2' });
  reg.remove('cd1');
  assert.deepStrictEqual(reg.readAll().map((s) => s.id), ['cd2']);
  assert.strictEqual(reg.remove('cd1'), true);  // already gone → still ok
});

test('corrupt file → [] (never throws)', () => {
  fs.writeFileSync(TMP, '{ not json');
  assert.deepStrictEqual(reg.readAll(), []);
});

test('disk round-trip: versioned envelope, id persisted', () => {
  reset();
  reg.upsert({ id: 'cd9', label: 'persist', cwd: '/z', uuid: 'u9' });
  const raw = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.strictEqual(raw.version, 1);
  assert.strictEqual(raw.sessions[0].id, 'cd9');
});

test('reorder: rewrites order, ignores unknown ids, keeps unlisted at end', () => {
  reset();
  reg.upsert({ id: 'cd1', label: 'a' }); reg.upsert({ id: 'cd2', label: 'b' }); reg.upsert({ id: 'cd3', label: 'c' });
  reg.reorder(['cd3', 'cd1']);                       // cd2 unlisted → appended
  assert.deepStrictEqual(reg.readAll().map((s) => s.id), ['cd3', 'cd1', 'cd2']);
  reg.reorder(['cd2', 'cd3', 'cd1', 'ghost']);       // unknown id ignored
  assert.deepStrictEqual(reg.readAll().map((s) => s.id), ['cd2', 'cd3', 'cd1']);
  assert.strictEqual(reg.reorder('not-an-array'), false);
});

test('synchronized process creates preserve every session', async () => {
  reset();
  seed();
  const ids = Array.from({ length: 8 }, (_, i) => `cd-race-${i}`);
  const results = await runWriters(ids.map((id) => ({ type: 'upsert', meta: { id, label: id, cwd: '/tmp' } })));
  assert.equal(results.every((result) => result.ok), true);
  const saved = reg.readAll();
  assert.equal(saved.length, ids.length);
  assert.equal(new Set(saved.map((session) => session.id)).size, ids.length);
  assert.deepEqual(saved.map((session) => session.id).sort(), [...ids].sort());
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(TMP, 'utf8')));
});

test('synchronized reorder and label updates preserve all mutations', async () => {
  reset();
  const ids = Array.from({ length: 8 }, (_, i) => `cd-mix-${i}`);
  seed(ids.map((id) => ({ id, label: id, cwd: '/tmp' })));
  const wantedOrder = [...ids].reverse();
  const operations = ids.slice(0, 4).map((id, i) => ({ type: 'setLabel', id, label: `updated-${i}` }));
  operations.push({ type: 'reorder', ids: wantedOrder });
  const results = await runWriters(operations);
  assert.equal(results.every((result) => result.ok), true);
  const saved = reg.readAll();
  assert.deepEqual(saved.map((session) => session.id), wantedOrder);
  for (let i = 0; i < 4; i++) assert.equal(saved.find((session) => session.id === ids[i]).label, `updated-${i}`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(TMP, 'utf8')));
});

test.after(reset);
