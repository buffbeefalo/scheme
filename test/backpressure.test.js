'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { boundedWrite, writeWithBackpressure } = require('../lib/backpressure');

class Sink extends EventEmitter {
  constructor({ length = 0, accepted = true, growth = 0 } = {}) {
    super(); this.writableLength = length; this.accepted = accepted; this.growth = growth;
  }
  write() { this.writableLength += this.growth; return this.accepted; }
}

test('boundedWrite accepts a healthy stream and evicts a stream above the cap', () => {
  assert.deepEqual(boundedWrite(new Sink(), 'frame', 10), { ok: true, accepted: true, overflow: false });
  assert.deepEqual(boundedWrite(new Sink({ length: 11 }), 'frame', 10), { ok: false, accepted: false, overflow: true });
  assert.deepEqual(boundedWrite(new Sink({ growth: 11 }), 'frame', 10), { ok: false, accepted: true, overflow: true });
});

test('writeWithBackpressure pauses a source until socket drain', () => {
  const calls = [];
  const source = { pause: () => calls.push('pause'), resume: () => calls.push('resume'), destroyed: false };
  const sink = new Sink({ accepted: false });
  assert.equal(writeWithBackpressure(source, sink, 'frame', { maxBytes: 10 }), true);
  assert.deepEqual(calls, ['pause']);
  sink.emit('drain');
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('writeWithBackpressure closes on overflow without arming a drain resume', () => {
  let overflows = 0, paused = 0;
  const source = { pause: () => { paused++; }, resume: () => {}, destroyed: false };
  const sink = new Sink({ growth: 20, accepted: false });
  assert.equal(writeWithBackpressure(source, sink, 'frame', { maxBytes: 10, onOverflow: () => { overflows++; } }), false);
  assert.equal(overflows, 1);
  assert.equal(paused, 0);
});
