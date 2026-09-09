'use strict';

// RFC 6455 WebSocket frame codec — pure functions, no sockets. Lets us hand-roll
// a minimal WS server (no `ws` dep) for the terminal bridge and test it directly.
//   node --test test/wsframe.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptKey, encodeFrame, decodeFrame, OPCODES } = require('../lib/wsframe');

// Build a masked client→server frame (clients MUST mask per RFC 6455).
function maskedFrame(opcode, payload, key = Buffer.from([0x37, 0xfa, 0x21, 0x3d])) {
  const p = Buffer.from(payload);
  const masked = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ key[i % 4];
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | p.length]);
  else { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  return Buffer.concat([head, key, masked]);
}

test('acceptKey matches the RFC 6455 worked example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame: short text payload (<126) — FIN|opcode, len, bytes', () => {
  assert.deepEqual([...encodeFrame(OPCODES.TEXT, Buffer.from('hi'))], [0x81, 0x02, 0x68, 0x69]);
});

test('encodeFrame: 126..65535 payload uses the 16-bit length form', () => {
  const f = encodeFrame(OPCODES.TEXT, Buffer.alloc(200, 0x61));
  assert.equal(f[0], 0x81);
  assert.equal(f[1], 126);
  assert.equal(f.readUInt16BE(2), 200);
  assert.equal(f.length, 4 + 200);
});

test('encodeFrame: server frames are NOT masked (mask bit clear)', () => {
  assert.equal((encodeFrame(OPCODES.TEXT, Buffer.from('x'))[1] & 0x80), 0);
});

test('decodeFrame: unmasks a client text frame and reports bytes consumed', () => {
  const buf = maskedFrame(OPCODES.TEXT, 'hello');
  const r = decodeFrame(buf);
  assert.equal(r.opcode, OPCODES.TEXT);
  assert.equal(r.fin, true);
  assert.equal(r.payload.toString(), 'hello');
  assert.equal(r.bytesConsumed, buf.length);
});

test('decodeFrame: returns null when the buffer is incomplete', () => {
  assert.equal(decodeFrame(maskedFrame(OPCODES.TEXT, 'hello').subarray(0, 4)), null);
});

test('decodeFrame: handles 16-bit length payloads', () => {
  const r = decodeFrame(maskedFrame(OPCODES.TEXT, 'b'.repeat(300)));
  assert.equal(r.payload.length, 300);
  assert.equal(r.payload.toString(), 'b'.repeat(300));
});

test('decodeFrame: reads a CLOSE control frame', () => {
  assert.equal(decodeFrame(maskedFrame(OPCODES.CLOSE, '')).opcode, OPCODES.CLOSE);
});

test('decodeFrame: leaves trailing bytes of a second frame for the next read', () => {
  const two = Buffer.concat([maskedFrame(OPCODES.TEXT, 'aa'), maskedFrame(OPCODES.TEXT, 'bbb')]);
  const r1 = decodeFrame(two);
  assert.equal(r1.payload.toString(), 'aa');
  const r2 = decodeFrame(two.subarray(r1.bytesConsumed));
  assert.equal(r2.payload.toString(), 'bbb');
});
