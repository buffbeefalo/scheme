"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { isUtf8 } = require('node:buffer');
const { Writable, PassThrough } = require('node:stream');
const codec = require('../lib/wsframe');
const pressure = require('../lib/backpressure');

// Exercise the actual bridge with controllable transport endpoints; no live tmux state.
function harness({ blocked = false, nativeChild = null, socket: nativeSocket = null, timers = { setTimeout, clearTimeout } } = {}) {
  const socket = nativeSocket || new EventEmitter();
  if (!nativeSocket) {
    socket.output = []; socket.paused = false; socket.ended = false;
    socket.write = b => { socket.output.push(b); return true; };
    socket.pause = () => { socket.paused = true; };
    socket.resume = () => { socket.paused = false; };
    socket.end = () => { socket.ended = true; socket.emit('close'); };
    socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  }
  let release;
  const received = [];
  const stdin = new Writable({ highWaterMark: 1, write(b, _e, cb) {
    received.push(b.toString()); if (blocked) release = cb; else cb();
  } });
  let attempts = 0;
  const write = stdin.write.bind(stdin);
  stdin.write = (...args) => { attempts++; return write(...args); };
  const child = nativeChild || Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const resizes = [];
  const terminal = { TMUX_BIN: 'tmux', tmuxArgs: a => a, tmuxAttachArgs: id => ['attach', id], shquote: s => s,
    createAttachmentResizer: () => ({ close() {}, resize: async (c,r) => resizes.push([c,r]) }) };
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const start = source.indexOf('function bridgeSession('), end = source.indexOf("\nprocess.on('unhandledRejection'", start);
  const bridge = vm.runInNewContext(source.slice(start, end) + '\nbridgeSession', {
    ...codec, ...pressure, terminal, spawn: () => child, ptyArgs: () => [], process, Buffer, isUtf8, ...timers,
    MAX_WS_BUFFER: 1024 * 1024, MAX_WS_INBOUND: 1024 * 1024,
  });
  bridge(socket, 'cdtest');
  return { socket, child, received, resizes, attempts: () => attempts,
    release: () => { blocked = false; release(); }, send: b => socket.emit('data', b) };
}
function frame(op, payload, fin = true) {
  const b = codec.encodeFrame(op, payload); b[0] = (fin ? 128 : 0) | op;
  const header = b.length - Buffer.byteLength(payload);
  b[1] |= 128; const key=Buffer.from([1,2,3,4]);
  const body=Buffer.from(b.subarray(header)); for(let i=0;i<body.length;i++) body[i]^=key[i%4];
  return Buffer.concat([b.subarray(0,header),key,body]);
}
const data = text => frame(codec.OPCODES.TEXT, JSON.stringify({t:'d', d:text}));
const turn = () => new Promise(resolve => setImmediate(resolve));

test('terminal stdin errors close the attachment without an unhandled error', () => {
  const h = harness();
  assert.doesNotThrow(() => h.child.stdin.emit('error', Object.assign(new Error('closed pipe'), {code:'EPIPE'})));
  assert.equal(h.socket.ended, true);
});
test('a closed attachment ignores already queued input', () => {
  const h = harness(); h.socket.emit('end'); h.send(data('late'));
  assert.equal(h.attempts(), 0);
});
test('coalesced input pauses at stdin backpressure and resumes buffered frames in order', async () => {
  const h = harness({blocked:true});
  h.send(Buffer.concat([data('first'),data('second'),data('third')]));
  assert.equal(h.socket.paused, true);
  assert.equal(h.attempts(), 1);
  h.release(); await turn();
  assert.deepEqual(h.received, ['first','second','third']);
  assert.equal(h.socket.paused, false);
});
test('fragmented JSON and UTF-8 are delivered once, with interleaved ping', async () => {
  const h = harness(); const p = Buffer.from(JSON.stringify({t:'d',d:'hello 雪'}));
  const split = p.indexOf(Buffer.from('雪')) + 1;
  h.send(frame(codec.OPCODES.TEXT,p.subarray(0,split),false));
  h.send(frame(codec.OPCODES.PING,'p'));
  h.send(frame(codec.OPCODES.CONT,p.subarray(split),true)); await turn();
  assert.deepEqual(h.received,['hello 雪']);
  assert.equal(codec.decodeFrame(h.socket.output[0]).opcode,codec.OPCODES.PONG);
});
test('orphan continuation, nested data, and fragmented control close the connection', () => {
  for (const frames of [
    [frame(codec.OPCODES.CONT,'{}')],
    [frame(codec.OPCODES.TEXT,'{',false),frame(codec.OPCODES.TEXT,'{}')],
    [frame(codec.OPCODES.PING,'p',false)],
  ]) { const h = harness(); h.send(Buffer.concat(frames)); assert.equal(h.socket.ended,true); }
});
test('fragmented message size is bounded across frames', () => {
  const h = harness();
  for(let i=0;i<20;i++) h.send(frame(i ? codec.OPCODES.CONT : codec.OPCODES.TEXT,'x'.repeat(65536),false));
  assert.equal(h.socket.ended,true);
});


test('real asynchronous EPIPE closes only the terminal attachment', {timeout:3000}, async t => {
  const nativeChild=spawn(process.execPath,['-e',"require('fs').closeSync(0);process.stdout.write('ready');setInterval(()=>{},1000)"]);
  t.after(()=>nativeChild.kill('SIGKILL'));
  const ready=once(nativeChild.stdout,'data');
  const h=harness({nativeChild}); await ready;
  const error=once(nativeChild.stdin,'error'); h.send(data('closed pipe'));
  const [e]=await error; assert.equal(e.code,'EPIPE'); assert.equal(h.socket.ended,true);
});
test('client protocol violations and invalid UTF-8 close with a reason', () => {
  const rsv=frame(codec.OPCODES.TEXT,'{}'); rsv[0]|=64;
  for(const b of [codec.encodeFrame(codec.OPCODES.TEXT,'{}'),rsv,
    frame(codec.OPCODES.PING,'x'.repeat(126)),frame(codec.OPCODES.TEXT,Buffer.from([0xff]))]) {
    const h=harness();h.send(b);assert.equal(h.socket.ended,true);
    const close=h.socket.output.map(codec.decodeFrame).find(f=>f.opcode===codec.OPCODES.CLOSE);
    assert.ok([1002,1007].includes(close?.payload.readUInt16BE(0)));
  }
});
test('TCP chunking and a close during backpressure preserve teardown', async () => {
  const h=harness({blocked:true}), b=data('first');
  for(const byte of b) h.send(Buffer.from([byte]));
  assert.deepEqual(h.received,['first']); h.socket.emit('end'); h.send(data('late'));
  h.release();await turn();assert.deepEqual(h.received,['first']);assert.equal(h.socket.ended,true);
});

test('a real stalled child pipe drains ordered input without an unbounded queue', {timeout:5000}, async t => {
  const expected=64*8192;
  const nativeChild=spawn(process.execPath,['-e',`let bytes=0;process.on('SIGUSR1',()=>process.stdin.on('data',b=>{bytes+=b.length;if(bytes===${expected})process.stdout.write(String(bytes));}));process.stdout.write('ready');setInterval(()=>{},1000)`]);
  t.after(()=>nativeChild.kill('SIGKILL'));
  const ready=once(nativeChild.stdout,'data'); const h=harness({nativeChild}); await ready;
  const done=once(nativeChild.stdout,'data');
  h.send(Buffer.concat(Array.from({length:64},()=>data('x'.repeat(8192)))));
  assert.equal(h.socket.paused,true); assert.ok(nativeChild.stdin.writableLength<=1024*1024);
  nativeChild.kill('SIGUSR1');
  assert.equal(String((await done)[0]),String(expected));
  await turn(); assert.equal(h.socket.paused,false); assert.equal(h.socket.ended,false);
  h.socket.emit('end'); assert.equal(nativeChild.stdin.listenerCount('drain'),0);
});

test('a real non-reading viewer is forcibly disconnected after bounded graceful teardown', { timeout: 6000 }, async () => {
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) { const token = { ms, unref() {} }; pending.set(token, fn); return token; },
    clearTimeout(token) { pending.delete(token); },
  };
  const server = http.createServer();
  let peer, client, h;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    server.on('upgrade', (_request, socket) => {
      peer = socket;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      h = harness({ socket, timers });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const request = http.request({ host: '127.0.0.1', port: server.address().port,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
    const upgraded = once(request, 'upgrade');
    request.end();
    [, client] = await upgraded;
    client.pause(); client.on('error', () => {});
    for (let i = 0; i < 300; i++) {
      h.child.stdout.write(Buffer.alloc(65536, 120));
      await delay(5);
      if (h.child.stdout.isPaused() && peer.writableLength) {
        await delay(50);
        if (peer.writableLength) break;
      }
    }
    assert.ok(peer.writableLength > 0 && h.child.stdout.isPaused(), 'the real peer has stopped draining output');
    const stall = [...pending].find(([token]) => token.ms === 30000);
    assert.ok(stall, 'the stalled connection has a timeout');
    pending.delete(stall[0]); stall[1]();
    assert.equal(peer.writableEnded, true);
    const teardown = [...pending].find(([token]) => token.ms > 0 && token.ms <= 1000);
    assert.ok(teardown, 'graceful close must retain a bounded forced-disconnect deadline');
    const closed = once(peer, 'close');
    pending.delete(teardown[0]); teardown[1]();
    await closed;
    assert.equal(peer.destroyed, true);
    assert.equal(peer.writableLength, 0);
    assert.equal(pending.size, 0, 'socket close clears all timers');
  } finally {
    peer?.destroy(); client?.destroy();
    h?.child.stdin.destroy(); h?.child.stdout.destroy(); h?.child.stderr.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
