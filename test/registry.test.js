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

test('upsert refuses to replace corrupt or invalid registry data', async (t) => {
  for (const before of ['{ not json', '{"version":1,"sessions":{}}']) {
    await t.test(before, () => {
      fs.writeFileSync(TMP, before);
      const result = reg.upsert({ id: 'cd-new', label: 'new' });
      assert.deepStrictEqual({ result, saved: fs.readFileSync(TMP, 'utf8') }, {
        result: false,
        saved: before,
      });
    });
  }
});

test('registry mutations preserve data and report failure after a read error', async (t) => {
  const operations = {
    writeAll: () => reg.writeAll([{ id: 'cd-new', label: 'new' }]),
    upsert: () => reg.upsert({ id: 'cd-new', label: 'new' }),
    setLabel: () => reg.setLabel('cd-kept', 'renamed'),
    remove: () => reg.remove('cd-kept'),
    reorder: () => reg.reorder(['cd-kept']),
  };
  for (const code of ['EACCES', 'EMFILE', 'EIO']) {
    for (const [name, mutate] of Object.entries(operations)) {
      await t.test(`${name} after ${code}`, (t) => {
        seed([{ id: 'cd-kept', label: 'keep me' }]);
        const before = fs.readFileSync(TMP, 'utf8');
        const readFile = fs.readFileSync;
        const read = t.mock.method(fs, 'readFileSync', (file, ...args) => {
          if (file === TMP) throw Object.assign(new Error(`simulated ${code}`), { code });
          return readFile(file, ...args);
        });
        let result;
        try { result = mutate(); }
        finally { read.mock.restore(); }
        assert.deepStrictEqual({ result, saved: fs.readFileSync(TMP, 'utf8') }, {
          result: false,
          saved: before,
        });
      });
    }
  }
});

test('a successful registry save flushes its data before replacement and its directory after', (t) => {
  seed([{ id: 'cd-kept', label: 'before' }]);
  const operations = [];
  const key = (stat) => `${stat.dev}:${stat.ino}`;
  const flush = fs.fsyncSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', (fd) => {
    operations.push({ type: 'flush', key: key(fs.fstatSync(fd)) });
    return flush(fd);
  });
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === TMP) operations.push({ type: 'replace', key: key(fs.statSync(source)) });
    return rename(source, destination);
  });

  assert.strictEqual(reg.setLabel('cd-kept', 'saved'), true);
  const fileKey = key(fs.statSync(TMP));
  const directoryKey = key(fs.statSync(path.dirname(TMP)));
  const relevant = operations.filter((operation) => operation.key === fileKey || operation.key === directoryKey)
    .map((operation) => operation.type === 'replace' ? 'replace'
      : operation.key === directoryKey ? 'flush directory' : 'flush data');
  assert.deepStrictEqual(relevant, ['flush data', 'replace', 'flush directory']);
  assert.strictEqual(reg.readAll()[0].label, 'saved');
});

test('a failed data flush does not replace the previous registry', (t) => {
  seed([{ id: 'cd-kept', label: 'before' }]);
  const before = fs.readFileSync(TMP, 'utf8');
  const opened = new Map();
  const open = fs.openSync;
  const flush = fs.fsyncSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = open(file, ...args);
    opened.set(fd, String(file));
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd) => {
    if (opened.get(fd)?.startsWith(`${TMP}.`) && opened.get(fd).endsWith('.tmp')) {
      throw Object.assign(new Error('simulated registry flush failure'), { code: 'EIO' });
    }
    return flush(fd);
  });

  const result = reg.setLabel('cd-kept', 'must not be committed');
  assert.deepStrictEqual({ result, saved: fs.readFileSync(TMP, 'utf8') }, {
    result: false,
    saved: before,
  });
});

test('ownership lost before registry replacement preserves saved data and the new owner', (t) => {
  seed([{ id: 'cd-kept', label: 'before' }]);
  const before = fs.readFileSync(TMP, 'utf8');
  const flush = fs.fsyncSync;
  const open = fs.openSync;
  const opened = new Map();
  t.after(() => fs.rmSync(`${TMP}.lock`, { force: true }));
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = open(file, ...args);
    opened.set(fd, String(file));
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd) => {
    flush(fd);
    if (opened.get(fd)?.startsWith(`${TMP}.`) && opened.get(fd).endsWith('.tmp')) {
      const owner = JSON.parse(fs.readFileSync(`${TMP}.lock`, 'utf8'));
      fs.writeFileSync(`${TMP}.lock`, JSON.stringify({ ...owner, token: 'replacement' }));
    }
  });
  assert.strictEqual(reg.setLabel('cd-kept', 'must not replace'), false);
  assert.strictEqual(fs.readFileSync(TMP, 'utf8'), before);
  assert.strictEqual(JSON.parse(fs.readFileSync(`${TMP}.lock`, 'utf8')).token, 'replacement');
});

test('registry snapshots distinguish absence from a damaged existing file', () => {
  reset();
  assert.deepStrictEqual(reg.readSnapshot(), { ok: true, missing: true, sessions: [] });
  fs.writeFileSync(TMP, '{ damaged');
  const snapshot = reg.readSnapshot();
  assert.strictEqual(snapshot.ok, false);
  assert.strictEqual(snapshot.missing, false);
  assert.strictEqual(snapshot.sessions, null);
  assert.ok(snapshot.error instanceof Error);
  assert.strictEqual(reg.writeAll([]), false);
  assert.strictEqual(fs.readFileSync(TMP, 'utf8'), '{ damaged');
});

test('registry replacements are private files', () => {
  reset();
  assert.strictEqual(reg.upsert({ id: 'cd-private' }), true);
  assert.strictEqual(fs.statSync(TMP).mode & 0o777, 0o600);
});

test('invalid supplied entries cannot make a healthy registry unreadable', () => {
  seed([{ id: 'cd-kept', label: 'before' }]);
  const before = fs.readFileSync(TMP, 'utf8');
  const array = [];
  array.id = 'cd-array';
  assert.strictEqual(reg.upsert({ id: 42 }), false);
  assert.strictEqual(reg.writeAll([array]), false);
  assert.strictEqual(fs.readFileSync(TMP, 'utf8'), before);
  assert.strictEqual(reg.readSnapshot().ok, true);
});

test('exclusive registry temporary-file collision preserves both existing files', (t) => {
  seed([{ id: 'cd-kept', label: 'before' }]);
  const before = fs.readFileSync(TMP, 'utf8');
  const open = fs.openSync;
  let collision;
  t.after(() => { if (collision) fs.rmSync(collision, { force: true }); });
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(`${TMP}.`) && file.endsWith('.tmp')) {
      collision = file;
      const fd = open(file, 'wx', 0o600);
      fs.writeFileSync(fd, 'another writer owns these bytes');
      fs.closeSync(fd);
    }
    return open(file, ...args);
  });
  assert.strictEqual(reg.setLabel('cd-kept', 'must not replace'), false);
  assert.strictEqual(fs.readFileSync(TMP, 'utf8'), before);
  assert.strictEqual(fs.readFileSync(collision, 'utf8'), 'another writer owns these bytes');
});

test('directory flush ignores unsupported operations but reports other failures', async (t) => {
  for (const code of ['EINVAL', 'ENOTSUP', 'EIO']) {
    await t.test(code, (t) => {
      seed([{ id: 'cd-kept', label: 'before' }]);
      const flush = fs.fsyncSync;
      let attempted = false;
      t.mock.method(fs, 'fsyncSync', (fd) => {
        if (fs.fstatSync(fd).isDirectory()) {
          attempted = true;
          throw Object.assign(new Error(`simulated directory ${code}`), { code });
        }
        return flush(fd);
      });
      assert.strictEqual(reg.setLabel('cd-kept', 'saved'), code !== 'EIO');
      assert.strictEqual(attempted, true);
      assert.strictEqual(reg.readAll()[0].label, 'saved');
    });
  }
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
