'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { probeDue, FAST_MS, FAST_WINDOW_MS, SLOW_MS } = require('../lib/tsretry.js');

const BOOT = 1_000_000;

test('probeDue: a never-probed identity is due immediately', () => {
  assert.equal(probeDue({ now: BOOT, lastProbeAt: 0, bootAt: BOOT }), true);
});

test('probeDue: inside the boot window a miss retries after 10s, not 5 minutes (the 2026-09-01 blackout)', () => {
  const miss = BOOT + 500;   // the boot-time probe, before tailscaled has its identity
  assert.equal(probeDue({ now: miss + 5e3, lastProbeAt: miss, bootAt: BOOT }), false);
  assert.equal(probeDue({ now: miss + FAST_MS, lastProbeAt: miss, bootAt: BOOT }), true);
  assert.ok(FAST_MS <= 10e3, 'fast retry is at most 10s');
  assert.equal(SLOW_MS, 5 * 60e3, 'steady-state backoff stays at the historical 5 minutes');
});

test('probeDue: after the boot window a miss backs off to 5 minutes (no tailscale must not mean probing forever)', () => {
  const miss = BOOT + FAST_WINDOW_MS;
  assert.equal(probeDue({ now: miss + FAST_MS, lastProbeAt: miss, bootAt: BOOT }), false);
  assert.equal(probeDue({ now: miss + SLOW_MS - 1, lastProbeAt: miss, bootAt: BOOT }), false);
  assert.equal(probeDue({ now: miss + SLOW_MS, lastProbeAt: miss, bootAt: BOOT }), true);
});
