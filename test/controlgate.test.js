'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createControlGate, POLICIES, readBody } = require('../lib/controlgate');

function fakeReq({ method = 'POST', remote = '127.0.0.1', headers = {}, body = '', aborted = false } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.socket = { remoteAddress: remote };
  process.nextTick(() => {
    if (aborted) { req.emit('aborted'); return; }
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}
function fakeRes() { return { code: null, obj: null }; }
const sendJson = (res, code, obj) => { res.code = code; res.obj = obj; };
let hostsCalls = 0;
const dashboardHosts = () => { hostsCalls++; return new Set(['127.0.0.1:3000']); };
const { guardedControlBody } = createControlGate({ sendJson, dashboardHosts });

const GOODHEADERS = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };

test('registry is fail-closed: unknown + inherited names throw (F1+G3)', async () => {
  for (const name of ['nope', 'constructor', 'toString', undefined]) {
    await assert.rejects(() => guardedControlBody(fakeReq({}), fakeRes(), name), /unknown control policy/);
  }
});

test('registry shape: frozen, null-prototype, exactly the six approved policies', () => {
  assert.equal(Object.getPrototypeOf(POLICIES), null);
  assert.ok(Object.isFrozen(POLICIES));
  assert.deepEqual(Object.keys(POLICIES).sort(),
    ['dashboardControl', 'openurl', 'openurlAck', 'termBody', 'termNotes', 'termUpload']);
});

test('loopback gate: control message + [L3] openurl message', async () => {
  let res = fakeRes();
  let g = await guardedControlBody(fakeReq({ remote: '10.0.0.5', headers: GOODHEADERS }), res, 'dashboardControl');
  assert.deepEqual(g, { ok: false });
  assert.equal(res.code, 403);
  assert.equal(res.obj.error, 'control is loopback-only — reach it via the SSH tunnel or tailscale serve');
  res = fakeRes();
  g = await guardedControlBody(fakeReq({ remote: '10.0.0.5' }), res, 'openurlAck');
  assert.deepEqual(g, { ok: false });
  assert.equal(res.code, 403);
  assert.equal(res.obj.error, 'loopback only');       // [L3] flip: was bare {ok:false} inline
});

test('ctype gate: normalization + 415 string (L2 canonical)', async () => {
  const cases = [
    ['application/json', true], ['application/json; charset=utf-8', true],
    ['Application/JSON', true], [' application/json ', true],
    ['application/problem+json', false], ['text/plain', false], ['', false],
  ];
  for (const [ct, pass] of cases) {
    const res = fakeRes();
    const headers = { ...GOODHEADERS };
    if (ct === '') delete headers['content-type']; else headers['content-type'] = ct;
    const g = await guardedControlBody(fakeReq({ headers, body: '{}' }), res, 'dashboardControl');
    if (pass) assert.equal(g.ok, true, `ctype ${JSON.stringify(ct)} should pass`);
    else { assert.deepEqual(g, { ok: false }); assert.equal(res.code, 415); assert.equal(res.obj.error, 'must be application/json'); }
  }
});

test('origin gate: absent origin 403; valid origin passes; hosts provider called per request', async () => {
  const before = hostsCalls;
  let res = fakeRes();
  const h = { host: '127.0.0.1:3000', 'content-type': 'application/json' };   // no origin
  let g = await guardedControlBody(fakeReq({ headers: h, body: '{}' }), res, 'dashboardControl');
  assert.deepEqual(g, { ok: false });
  assert.equal(res.code, 403);
  assert.equal(res.obj.error, 'cross-origin, rebinding, or origin-less control blocked');
  g = await guardedControlBody(fakeReq({ headers: GOODHEADERS, body: '{}' }), fakeRes(), 'dashboardControl');
  assert.equal(g.ok, true);
  assert.ok(hostsCalls >= before + 2, 'dashboardHosts() consulted per request');
});

test('limits: default 4096 boundary exact; custom notes/upload limits + messages', async () => {
  let res = fakeRes();
  let g = await guardedControlBody(fakeReq({ headers: GOODHEADERS, body: 'x'.repeat(4096) }), res, 'dashboardControl');
  assert.equal(g.ok, true, '4096 bytes exactly is allowed');
  res = fakeRes();
  g = await guardedControlBody(fakeReq({ headers: GOODHEADERS, body: 'x'.repeat(4097) }), res, 'dashboardControl');
  assert.deepEqual(g, { ok: false });
  assert.equal(res.code, 413); assert.equal(res.obj.error, 'request body too large');
  res = fakeRes();
  g = await guardedControlBody(fakeReq({ body: 'x'.repeat(300 * 1024 + 1) }), res, 'termNotes');
  assert.equal(res.code, 413); assert.equal(res.obj.error, 'notes too large');
  res = fakeRes();
  g = await guardedControlBody(fakeReq({ body: 'x'.repeat(300 * 1024 + 1) }), res, 'termUpload');
  assert.equal(g.ok, true, 'upload limit is 34MB — 300KB passes');
});

test('aborted: {ok:false} with NO response written', async () => {
  const res = fakeRes();
  const g = await guardedControlBody(fakeReq({ aborted: true }), res, 'termBody');
  assert.deepEqual(g, { ok: false });
  assert.equal(res.code, null, 'nothing sendable on abort');
});

test('parse json: value rides AS-IS incl. falsy (F4); malformed/empty → {}', async () => {
  const cases = [['null', null], ['false', false], ['0', 0], ['""', ''], ['[1]', [1]], ['{"a":1}', { a: 1 }], ['not json', {}], ['', {}]];
  for (const [body, expected] of cases) {
    const g = await guardedControlBody(fakeReq({ body }), fakeRes(), 'termBody');
    assert.equal(g.ok, true);
    assert.deepEqual(g.payload, expected, `body ${JSON.stringify(body)}`);
  }
});

test('parse raw: openurl policy returns {raw} untouched', async () => {
  const g = await guardedControlBody(fakeReq({ body: 'url=x&y=z' }), fakeRes(), 'openurl');
  assert.deepEqual(g, { ok: true, payload: { raw: 'url=x&y=z' } });
});

test('readBody export: one-shot latch — tooLarge and aborted are exclusive (L4 basis)', async () => {
  const req = fakeReq({ body: 'x'.repeat(10) });
  const r = await readBody(req, 4);
  assert.deepEqual(r, { tooLarge: true });
  req.emit('aborted');                                     // late event after latch: ignored
});
