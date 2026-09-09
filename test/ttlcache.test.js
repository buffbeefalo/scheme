'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache } = require('../lib/ttlcache');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('fresh hit within TTL returns cached value without re-calling', async () => {
  let t = 0, calls = 0;
  const c = createTtlCache(async () => ({ ok: true, n: ++calls }), { ttlMs: 1000, now: () => t, cacheIf: (r) => r.ok });
  assert.deepEqual(await c.get(), { ok: true, n: 1 });
  t = 999;
  assert.deepEqual(await c.get(), { ok: true, n: 1 });
  t = 1000;
  assert.deepEqual(await c.get(), { ok: true, n: 2 });
  assert.equal(calls, 2);
});

test('single-flight: concurrent gets share one underlying call', async () => {
  let calls = 0;
  const d = deferred();
  const c = createTtlCache(() => { calls++; return d.promise; }, { ttlMs: 1000, now: () => 0 });
  const p1 = c.get(), p2 = c.get();
  d.resolve({ ok: true, v: 'x' });
  assert.deepEqual(await p1, { ok: true, v: 'x' });
  assert.deepEqual(await p2, { ok: true, v: 'x' });
  assert.equal(calls, 1);
});

test('cacheIf false: result returned but NOT cached — next get re-calls', async () => {
  let calls = 0;
  const c = createTtlCache(async () => ({ ok: false, n: ++calls }), { ttlMs: 1000, now: () => 0, cacheIf: (r) => r.ok });
  assert.deepEqual(await c.get(), { ok: false, n: 1 });
  assert.deepEqual(await c.get(), { ok: false, n: 2 });
  assert.equal(calls, 2);
});

test('rejection: never cached, error propagates, next get re-calls', async () => {
  let calls = 0;
  const c = createTtlCache(async () => { if (++calls === 1) throw new Error('boom'); return { ok: true, n: calls }; }, { ttlMs: 1000, now: () => 0 });
  await assert.rejects(c.get(), /boom/);
  assert.deepEqual(await c.get(), { ok: true, n: 2 });
});

test('invalidate: cached value dropped', async () => {
  let calls = 0;
  const c = createTtlCache(async () => ({ ok: true, n: ++calls }), { ttlMs: 1000, now: () => 0 });
  await c.get();
  c.invalidate();
  assert.deepEqual(await c.get(), { ok: true, n: 2 });
});

test('generation: get -> invalidate -> old call resolves -> result NOT cached', async () => {
  let calls = 0;
  const d = deferred();
  const fns = [() => { calls++; return d.promise; }, async () => ({ ok: true, n: ++calls })];
  const c = createTtlCache(() => fns.shift()(), { ttlMs: 1000, now: () => 0 });
  const p1 = c.get();
  c.invalidate();
  d.resolve({ ok: true, n: 'stale' });
  assert.deepEqual(await p1, { ok: true, n: 'stale' });
  assert.deepEqual(await c.get(), { ok: true, n: 2 });
});

test('generation: get -> invalidate -> second get BEFORE old resolves starts a NEW call', async () => {
  const d1 = deferred(), d2 = deferred();
  const fns = [() => d1.promise, () => d2.promise];
  let calls = 0;
  const c = createTtlCache(() => { calls++; return fns.shift()(); }, { ttlMs: 1000, now: () => 0 });
  const p1 = c.get();
  c.invalidate();
  const p2 = c.get();
  assert.equal(calls, 2);
  d2.resolve({ ok: true, v: 'fresh' });
  d1.resolve({ ok: true, v: 'stale' });
  assert.deepEqual(await p2, { ok: true, v: 'fresh' });
  assert.deepEqual(await p1, { ok: true, v: 'stale' });
  assert.deepEqual(await c.get(), { ok: true, v: 'fresh' });
});

test('freshness stamped at COMPLETION, and a backward clock step cannot extend the TTL', async () => {
  let t = 0, calls = 0;
  const d = deferred();
  const fns = [() => { calls++; return d.promise; }, async () => { calls++; return { ok: true, n: calls }; }];
  const c = createTtlCache(() => fns.shift()(), { ttlMs: 100, now: () => t });
  const p1 = c.get();
  t = 500;
  d.resolve({ ok: true, n: 1 });
  await p1;
  t = 599;
  assert.equal((await c.get()).n, 1);
  assert.equal(calls, 1);
  t = 0;
  await c.get();
  assert.equal(calls, 1);
});
