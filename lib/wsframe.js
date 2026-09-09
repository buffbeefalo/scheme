'use strict';

// Minimal RFC 6455 WebSocket frame codec — pure, no sockets. Enough to hand-roll
// a server-side WS for the terminal bridge without adding the `ws` dependency:
// the dashboard stays npm-free. server.js owns the handshake + socket plumbing;
// this owns the bytes.
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODES = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// Sec-WebSocket-Accept = base64(sha1(clientKey + GUID)).
function acceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(String(secWebSocketKey) + GUID).digest('base64');
}

// Server→client frame (FIN set, never masked).
function encodeFrame(opcode, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload == null ? '' : payload);
  const len = p.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, p]);
}

// Decode ONE frame from the front of `buf`. Returns null if the buffer doesn't
// yet hold a whole frame (caller accumulates and retries). Unmasks client frames.
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset)); offset += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;
  const raw = buf.subarray(offset, offset + len);
  const payload = Buffer.allocUnsafe(len);
  if (masked) for (let i = 0; i < len; i++) payload[i] = raw[i] ^ maskKey[i & 3];
  else raw.copy(payload);
  return { fin, opcode, masked, payload, bytesConsumed: offset + len };
}

module.exports = { acceptKey, encodeFrame, decodeFrame, OPCODES };
