'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
    reclaimMalformed: options.reclaimMalformed,
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

function darwinFixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-reg-darwin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, 'sessions.json');
  fs.writeFileSync(registry, '{"version":1,"sessions":[]}');
  const io = Object.create(fs);
  const procReads = [];
  io.readFileSync = (file, ...args) => {
    if (String(file).startsWith('/proc/')) {
      procReads.push(file);
      throw Object.assign(new Error('Darwin has no /proc'), { code: 'ENOENT' });
    }
    return fs.readFileSync(file, ...args);
  };
  const calls = [];
  const signals = [];
  let now = 100_000;
  const lock = createRegistryLock({
    fs: io, platform: 'darwin', pid: 100, token: () => 'mine',
    now: () => now, sleep: (ms) => { now += ms; }, timeoutMs: 20, retryMs: 10,
    warn: () => {},
    execFileSync: (command, args, config) => {
      calls.push({ command, args, config });
      if (command === '/usr/sbin/sysctl') {
        assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']);
        if (options.bootError) throw Object.assign(new Error('boot unavailable'), { code: options.bootError });
        return options.bootOutput ?? 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\n';
      }
      assert.equal(command, '/bin/ps');
      assert.deepEqual(args, ['-p', args[1], '-o', 'lstart=']);
      if (args[1] === '100') return options.selfStart ?? 'Tue Sep 29 12:34:56 2026\n';
      assert.equal(args[1], '200');
      if (options.ownerError) throw Object.assign(new Error('owner start unavailable'), { code: options.ownerError });
      return options.ownerStart ?? 'Tue Sep 29 11:00:00 2026\n';
    },
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (options.killError) throw Object.assign(new Error('owner probe failed'), { code: options.killError });
      return true;
    },
  });
  return { registry, lockPath: `${registry}.lock`, lock, calls, signals, procReads };
}

function darwinOwner(fields = {}) {
  return owner('owner', { bootId: 'darwin:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', startTicks: 'darwin:Tue Sep 29 11:00:00 2026', ...fields });
}

test('Darwin lock acquires with native boot and process start identity without /proc', (t) => {
  const f = darwinFixture(t);
  assert.equal(f.lock.withLock(f.registry, (lease) => {
    const record = JSON.parse(fs.readFileSync(f.lockPath, 'utf8'));
    assert.equal(record.bootId, 'darwin:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.equal(record.startTicks, 'darwin:Tue Sep 29 12:34:56 2026');
    return lease.owns();
  }), true);
  assert.deepEqual(f.procReads, []);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.equal(f.calls.length, 2);
  for (const { config } of f.calls) {
    assert.equal(config.env.LC_ALL, 'C');
    assert.equal(config.env.TZ, 'UTC');
    assert.ok(config.timeout > 0 && config.timeout <= 1000);
    assert.ok(config.maxBuffer > 0 && config.maxBuffer <= 8192);
  }
});

test('Darwin dead-owner recovery requires ESRCH when process start lookup fails', (t) => {
  const f = darwinFixture(t, { ownerError: 'ETIMEDOUT', killError: 'ESRCH' });
  fs.writeFileSync(f.lockPath, darwinOwner());
  assert.equal(f.lock.withLock(f.registry, (lease) => lease.owns()), true);
  assert.ok(f.signals.some(([pid, signal]) => pid === 200 && signal === 0));
});

test('Darwin retains a live or ambiguous owner when process start lookup fails', async (t) => {
  for (const killError of [undefined, 'EPERM', 'EIO']) {
    await t.test(killError || 'live', (t) => {
      const f = darwinFixture(t, { ownerError: 'ETIMEDOUT', killError });
      const before = darwinOwner();
      fs.writeFileSync(f.lockPath, before);
      let entered = false;
      assert.equal(f.lock.withLock(f.registry, () => { entered = true; return true; }), false);
      assert.equal(entered, false);
      assert.equal(fs.readFileSync(f.lockPath, 'utf8'), before);
    });
  }
});

test('Darwin reclaims a reused pid only when native process start identity differs', (t) => {
  const f = darwinFixture(t, { ownerStart: 'Tue Sep 29 12:00:00 2026\n' });
  fs.writeFileSync(f.lockPath, darwinOwner());
  assert.equal(f.lock.withLock(f.registry, (lease) => lease.owns()), true);
});

test('Darwin retains the verified live native owner', (t) => {
  const f = darwinFixture(t);
  const before = darwinOwner();
  fs.writeFileSync(f.lockPath, before);
  assert.equal(f.lock.withLock(f.registry, () => true), false);
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), before);
});

test('Darwin reclaims prior-boot identity even when the numeric pid is currently live', (t) => {
  const f = darwinFixture(t);
  fs.writeFileSync(f.lockPath, darwinOwner({ bootId: 'darwin:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  assert.equal(f.lock.withLock(f.registry, (lease) => lease.owns()), true);
});

test('Darwin refuses an unverifiable current identity instead of falling back to pid alone', async (t) => {
  for (const options of [{ bootError: 'EIO' }, { bootOutput: '' }, { bootOutput: 'not a boot UUID' }, { selfStart: '' }, { selfStart: 'unparseable' }]) {
    await t.test(JSON.stringify(options), (t) => {
      const f = darwinFixture(t, options);
      assert.equal(f.lock.withLock(f.registry, () => true), false);
      assert.equal(fs.existsSync(f.lockPath), false);
    });
  }
});

test('journal-style locks can retain old malformed metadata without changing registry recovery', (t) => {
  const f = fixture(t, { reclaimMalformed: false });
  fs.writeFileSync(f.lockPath, '');
  const old = new Date(f.now() - 30_001);
  fs.utimesSync(f.lockPath, old, old);
  assert.equal(f.lock.withLock(f.registry, () => true), false);
  assert.equal(fs.readFileSync(f.lockPath, 'utf8'), '');
});

test('asynchronous transaction retains its lease until its object result resolves', async (t) => {
  const f = fixture(t);
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const result = f.lock.withLockAsync(f.registry, async (lease) => {
    assert.equal(lease.owns(), true);
    await barrier;
    assert.equal(lease.owns(), true);
    return { ok: true, saved: 'value' };
  });
  assert.equal(fs.existsSync(f.lockPath), true);
  release();
  assert.deepEqual(await result, { ok: true, saved: 'value' });
  assert.equal(fs.existsSync(f.lockPath), false);
});

test('asynchronous callback rejection releases its own lease', async (t) => {
  const f = fixture(t);
  assert.equal(await f.lock.withLockAsync(f.registry, async () => {
    await Promise.resolve();
    throw new Error('write failed');
  }), false);
  assert.equal(fs.existsSync(f.lockPath), false);
  assert.match(f.warnings.join('\n'), /write failed/);
});

test('asynchronous transaction detects lost ownership and preserves the replacement', async (t) => {
  const f = fixture(t);
  assert.equal(await f.lock.withLockAsync(f.registry, async () => {
    await Promise.resolve();
    fs.writeFileSync(f.lockPath, owner('replacement'));
    return { ok: true };
  }), false);
  assert.equal(JSON.parse(fs.readFileSync(f.lockPath, 'utf8')).token, 'replacement');
});

test('an asynchronous owner and a waiting process preserve both updates', { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-reg-async-process-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, 'sessions.json');
  fs.writeFileSync(registry, '[]');
  const lock = createRegistryLock();
  let child;
  let done;
  let output = '';
  t.after(() => child?.kill());
  const script = `
    const fs = require('node:fs');
    const { createRegistryLock } = require(process.argv[1]);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const lock = createRegistryLock({
      timeoutMs: 2000,
      sleep: (ms) => { process.stdout.write('blocked\\n'); Atomics.wait(wait, 0, 0, ms); },
    });
    const ok = lock.withLock(process.argv[2], () => {
      const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
      data.push('child');
      fs.writeFileSync(process.argv[2], JSON.stringify(data));
      return true;
    });
    process.stdout.write(JSON.stringify({ ok }));
  `;
  const result = await lock.withLockAsync(registry, async (lease) => {
    child = spawn(process.execPath, ['-e', script, require.resolve('../lib/registry-lock'), registry], {
      env: { ...process.env, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('blocked\n')) resolve();
      });
      child.once('error', reject);
      child.once('exit', () => { if (!output.includes('blocked\n')) reject(new Error('contender did not wait for the async owner')); });
    });
    assert.equal(lease.owns(), true);
    const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
    data.push('parent');
    fs.writeFileSync(registry, JSON.stringify(data));
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(await done, 0);
  assert.equal(JSON.parse(output.trim().split('\n').at(-1)).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(registry, 'utf8')), ['parent', 'child']);
});
