'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRegistryLock } = require('../lib/registry-lock');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-reg-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, 'sessions.json');
  fs.writeFileSync(registry, '{"version":1,"sessions":[]}');
  const identities = options.identities || new Map([[100, '11']]);
  const warnings = [];
  const tokens = [...(options.tokens || ['contender'])];
  let now = options.now || 100_000;
  const lock = createRegistryLock({
    fs,
    pid: 100,
    now: () => now,
    sleep: (ms) => { now += ms; },
    token: () => tokens.shift() || `token-${tokens.length}`,
    bootId: () => options.bootId === undefined ? 'boot-a' : options.bootId,
    processStartTicks: (pid) => identities.has(pid) ? identities.get(pid) : false,
    warn: (message) => warnings.push(message),
    timeoutMs: options.timeoutMs || 30,
    retryMs: 10,
    malformedStaleMs: 30_000,
  });
  return { dir, registry, lockPath: `${registry}.lock`, reclaimPath: `${registry}.lock.reclaim`, lock, identities, warnings, now: () => now };
}

function owner(token = 'owner', fields = {}) {
  return JSON.stringify({
    version: 1,
    token,
    pid: 200,
    bootId: 'boot-a',
    startTicks: '22',
    createdAt: 99_000,
    ...fields,
  });
}

test('new lock records complete owner identity and releases after success', (t) => {
  const f = fixture(t, { tokens: ['mine'] });
  let observed;
  assert.equal(f.lock.withLock(f.registry, (lease) => {
    observed = JSON.parse(fs.readFileSync(f.lockPath, 'utf8'));
    assert.equal(lease.token, 'mine');
    assert.equal(lease.owns(), true);
    return true;
  }), true);
  assert.deepEqual(observed, {
    version: 1,
    token: 'mine',
    pid: 100,
    bootId: 'boot-a',
    startTicks: '11',
    createdAt: 100_000,
  });
  assert.equal(fs.existsSync(f.lockPath), false);
});

test('verified live owner is never stolen and timeout leaves registry unchanged', (t) => {
  const identities = new Map([[100, '11'], [200, '22']]);
  const f = fixture(t, { identities });
  fs.writeFileSync(f.lockPath, owner());
  const before = fs.readFileSync(f.registry);
  let called = false;
  assert.equal(f.lock.withLock(f.registry, () => { called = true; return true; }), false);
  assert.equal(called, false);
  assert.deepEqual(fs.readFileSync(f.registry), before);
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath, 'utf8')).token, 'owner');
  assert.match(f.warnings.join('\n'), /timed out/i);
});

test('dead process owner is reclaimed', (t) => {
  const identities = new Map([[100, '11'], [200, false]]);
  const f = fixture(t, { identities });
  fs.writeFileSync(f.lockPath, owner());
  assert.equal(f.lock.withLock(f.registry, (lease) => lease.owns()), true);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.equal(fs.existsSync(f.reclaimPath), false);
});

test('prior-boot owner is reclaimed even when its numeric pid is live', (t) => {
  const identities = new Map([[100, '11'], [200, '22']]);
  const f = fixture(t, { identities });
  fs.writeFileSync(f.lockPath, owner('owner', { bootId: 'boot-old' }));
  assert.equal(f.lock.withLock(f.registry, () => true), true);
});

test('pid reuse is reclaimed when process start ticks differ', (t) => {
  const identities = new Map([[100, '11'], [200, '23']]);
  const f = fixture(t, { identities });
  fs.writeFileSync(f.lockPath, owner());
  assert.equal(f.lock.withLock(f.registry, () => true), true);
});

test('ambiguous process identity fails closed', (t) => {
  const identities = new Map([[100, '11'], [200, null]]);
  const f = fixture(t, { identities });
  fs.writeFileSync(f.lockPath, owner());
  assert.equal(f.lock.withLock(f.registry, () => true), false);
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath, 'utf8')).token, 'owner');
});

test('young malformed metadata is retained but old malformed metadata is reclaimed', (t) => {
  const young = fixture(t, { tokens: ['young-contender'] });
  fs.writeFileSync(young.lockPath, '{');
  fs.utimesSync(young.lockPath, new Date(young.now()), new Date(young.now()));
  assert.equal(young.lock.withLock(young.registry, () => true), false);
  assert.equal(fs.readFileSync(young.lockPath, 'utf8'), '{');

  const old = fixture(t, { tokens: ['old-contender'] });
  fs.writeFileSync(old.lockPath, '{');
  fs.utimesSync(old.lockPath, new Date(old.now() - 30_001), new Date(old.now() - 30_001));
  assert.equal(old.lock.withLock(old.registry, () => true), true);
  assert.equal(fs.existsSync(old.lockPath), false);
});

test('lost ownership makes the operation fail and release preserves the replacement lock', (t) => {
  const f = fixture(t, { tokens: ['mine'] });
  assert.equal(f.lock.withLock(f.registry, () => {
    fs.writeFileSync(f.lockPath, owner('replacement'));
    return true;
  }), false);
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath, 'utf8')).token, 'replacement');
});

test('missing current boot or process identity fails closed before lock creation', (t) => {
  const noBoot = fixture(t, { bootId: null });
  assert.equal(noBoot.lock.withLock(noBoot.registry, () => true), false);
  assert.equal(fs.existsSync(noBoot.lockPath), false);

  const noStart = fixture(t, { identities: new Map([[100, null]]) });
  assert.equal(noStart.lock.withLock(noStart.registry, () => true), false);
  assert.equal(fs.existsSync(noStart.lockPath), false);
});

test('metadata write failure removes the exclusively-created partial lock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-reg-lock-write-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, 'sessions.json');
  const lockPath = `${registry}.lock`;
  const failingFs = Object.create(fs);
  failingFs.writeFileSync = (target, ...args) => {
    if (typeof target === 'number') {
      const error = new Error('simulated metadata write failure');
      error.code = 'ENOSPC';
      throw error;
    }
    return fs.writeFileSync(target, ...args);
  };
  const lock = createRegistryLock({
    fs: failingFs,
    pid: 100,
    bootId: () => 'boot-a',
    processStartTicks: () => '11',
    token: () => 'mine',
    warn: () => {},
  });

  assert.equal(lock.withLock(registry, () => true), false);
  assert.equal(fs.existsSync(lockPath), false);
});
