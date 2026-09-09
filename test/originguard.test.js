'use strict';

// The terminal control plane can spawn Claude Code (RCE), so the same-origin /
// anti-rebinding guard is load-bearing: these cases are the security contract.
//   node --test test/originguard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isLoopback, sameSiteLoopback, sameSiteKnownHost, dashboardHostSet, terminalHostSet, classifyServeConfig, funnelStateAfter } = require('../lib/originguard');
const PORT = 3000;

// NEW-cmddeck-1: the three fleet write routes (/api/control, /api/push, /api/fleet/pause POST)
// gate on isLoopback(req) exactly like /api/term/* — `if (!isLoopback(req)) return 403`. A direct
// LAN/tailscale-IP socket is refused; a loopback socket (SSH tunnel or tailscale-serve proxy, both
// re-originated from 127.0.0.1) passes the gate. READ views stay open to the LAN.
test('isLoopback admits loopback sockets and refuses LAN sockets (control-plane 403 gate)', () => {
  const req = (addr) => ({ socket: { remoteAddress: addr } });
  // loopback → passes the gate (no 403): the only reachability the write routes now allow
  assert.equal(isLoopback(req('127.0.0.1')), true);
  assert.equal(isLoopback(req('::1')), true);
  assert.equal(isLoopback(req('::ffff:127.0.0.1')), true);
  // non-loopback → gate is false → /api/control (etc.) returns 403
  assert.equal(isLoopback(req('192.168.1.50')), false);   // direct LAN device
  assert.equal(isLoopback(req('10.0.0.105')), false);
  assert.equal(isLoopback(req('100.64.0.16')), false);   // DIRECT tailscale IP (not via serve proxy)
  assert.equal(isLoopback(req('')), false);
  assert.equal(isLoopback({}), false);                    // malformed req (no socket) → refuse
});

test('allows the genuine same-origin UI (Host pinned, Origin one of ours or absent)', () => {
  assert.equal(sameSiteLoopback({ host: 'localhost:3000' }, PORT), true);                                  // same-origin GET (no Origin)
  assert.equal(sameSiteLoopback({ host: 'localhost:3000', origin: 'http://localhost:3000' }, PORT), true);  // POST / WS from our page
  assert.equal(sameSiteLoopback({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }, PORT), true);
});

test('blocks a cross-origin request from a malicious site (drive-by fetch / WS)', () => {
  assert.equal(sameSiteLoopback({ host: 'localhost:3000', origin: 'http://evil.example' }, PORT), false);
  assert.equal(sameSiteLoopback({ host: 'localhost:3000', origin: 'https://evil.example:3000' }, PORT), false);
  assert.equal(sameSiteLoopback({ host: 'localhost:3000', origin: 'null' }, PORT), false);                  // opaque/sandboxed origin
});

test('blocks DNS-rebinding (Host is the attacker hostname, not loopback)', () => {
  assert.equal(sameSiteLoopback({ host: 'attacker.example:3000' }, PORT), false);
  assert.equal(sameSiteLoopback({ host: 'attacker.example:3000', origin: 'http://attacker.example:3000' }, PORT), false);
});

test('blocks LAN access to the terminal plane (it is loopback-only)', () => {
  assert.equal(sameSiteLoopback({ host: '10.0.0.105:3000' }, PORT), false);
  assert.equal(sameSiteLoopback({ host: '' }, PORT), false);
  assert.equal(sameSiteLoopback({}, PORT), false);
});

test('requireOrigin: state-changing POST / WS must carry a valid same-origin Origin', () => {
  // read-only GET (default): an origin-less same-origin request is fine
  assert.equal(sameSiteLoopback({ host: 'localhost:3000' }, PORT), true);
  // POST / WS: origin-less is REJECTED (a real browser always sends Origin on these)
  assert.equal(sameSiteLoopback({ host: 'localhost:3000' }, PORT, { requireOrigin: true }), false);
  // POST / WS with our own Origin: allowed
  assert.equal(sameSiteLoopback({ host: 'localhost:3000', origin: 'http://localhost:3000' }, PORT, { requireOrigin: true }), true);
  // POST / WS cross-origin: still rejected
  assert.equal(sameSiteLoopback({ host: 'localhost:3000', origin: 'http://evil.example' }, PORT, { requireOrigin: true }), false);
});

test('known-host guard allows real dashboard hosts and blocks DNS rebinding', () => {
  const allow = new Set(['localhost:3000', '127.0.0.1:3000', '10.0.0.105:3000', '100.64.0.11:3000']);
  assert.equal(sameSiteKnownHost(
    { host: '10.0.0.105:3000', origin: 'http://10.0.0.105:3000' },
    allow,
    { requireOrigin: true },
  ), true);
  assert.equal(sameSiteKnownHost(
    { host: 'LOCALHOST:3000', origin: 'http://localhost:3000' },
    allow,
    { requireOrigin: true },
  ), true);
  assert.equal(sameSiteKnownHost(
    { host: 'attacker.example:3000', origin: 'http://attacker.example:3000' },
    allow,
    { requireOrigin: true },
  ), false);
  assert.equal(sameSiteKnownHost(
    { host: '10.0.0.105:3000' },
    allow,
    { requireOrigin: true },
  ), false);
});

test('known-host guard blocks rebinding reads while preserving LAN dashboard GETs', () => {
  const allow = new Set(['localhost:3000', '127.0.0.1:3000', '10.0.0.105:3000']);
  assert.equal(sameSiteKnownHost({ host: '10.0.0.105:3000' }, allow), true);
  assert.equal(sameSiteKnownHost({ host: 'localhost:3000' }, allow), true);
  assert.equal(sameSiteKnownHost({ host: 'evil.example:3000' }, allow), false);
  assert.equal(sameSiteKnownHost({ host: '10.0.0.105:3000', origin: 'http://evil.example' }, allow), false);
});

// ── tailscale-serve support (phone access) ──────────────────────────────────────
// `tailscale serve` terminates HTTPS on the tailnet and re-originates the request
// from 127.0.0.1, so the browser sends Host/Origin as the PORTLESS MagicDNS name
// (browsers omit :443 on default-port HTTPS). The host sets must trust that form.
const TSDNS = 'spark.tailnet-redacted.ts.net';

test('dashboardHostSet trusts the tailnet name bare (serve on 443), :port (direct), and short form', () => {
  const set = dashboardHostSet({ port: 3000, addrs: ['10.0.0.105', 'fe80::1'], tsIp: '100.64.0.11', tsDns: TSDNS });
  assert.equal(set.has(TSDNS), true);                       // via tailscale serve
  assert.equal(set.has(`${TSDNS}:3000`), true);             // direct hostname:port
  assert.equal(set.has('spark:3000'), true);                // MagicDNS short name
  assert.equal(set.has('10.0.0.105:3000'), true);           // LAN iface, port-pinned
  assert.equal(set.has('[fe80::1]:3000'), true);            // v6 bracketed
  assert.equal(set.has('100.64.0.11:3000'), true);        // tailscale IP, port-pinned
  assert.equal(set.has('localhost:3000'), true);
  assert.equal(set.has('10.0.0.105'), false);               // bare form is ONLY for the tailnet dns name
  assert.equal(set.has('spark'), false);
});

test('dashboardHostSet: COMMAND_DECK_ALLOWED_HOSTS entries — portless trusted bare AND :port, ported kept verbatim', () => {
  const set = dashboardHostSet({ port: 3000, extra: 'deck.example, proxy.example:8443' });
  assert.equal(set.has('deck.example'), true);
  assert.equal(set.has('deck.example:3000'), true);
  assert.equal(set.has('proxy.example:8443'), true);
  assert.equal(set.has('proxy.example'), false);
});

test('terminalHostSet is the loopback trio + the bare tailnet name, NOTHING else', () => {
  assert.deepEqual(terminalHostSet({ port: 3000, tsDns: TSDNS }),
    new Set(['localhost:3000', '127.0.0.1:3000', '[::1]:3000', TSDNS]));
  // no tailscale identity → pure loopback (today's behavior, unchanged)
  assert.deepEqual(terminalHostSet({ port: 3000, tsDns: '' }),
    new Set(['localhost:3000', '127.0.0.1:3000', '[::1]:3000']));
});

test('a tailscale-serve shaped handshake passes the terminal gate; attack shapes still fail', () => {
  const allow = terminalHostSet({ port: 3000, tsDns: TSDNS });
  // genuine: phone browser on https://spark.tailnet-redacted.ts.net → WS/POST with portless Host+Origin
  assert.equal(sameSiteKnownHost({ host: TSDNS, origin: `https://${TSDNS}` }, allow, { requireOrigin: true }), true);
  // read-only GET from the same page (no Origin) is fine
  assert.equal(sameSiteKnownHost({ host: TSDNS }, allow), true);
  // drive-by page on a tailnet device: Origin is the attacker's, not ours
  assert.equal(sameSiteKnownHost({ host: TSDNS, origin: 'https://evil.example' }, allow, { requireOrigin: true }), false);
  // origin-less POST/WS to the RCE surface: never the genuine UI → fail closed
  assert.equal(sameSiteKnownHost({ host: TSDNS }, allow, { requireOrigin: true }), false);
  // DNS rebinding: Host is the attacker's hostname, not a trusted one
  assert.equal(sameSiteKnownHost({ host: 'evil.example', origin: `https://${TSDNS}` }, allow, { requireOrigin: true }), false);
  // wrong port on an otherwise-trusted name
  assert.equal(sameSiteKnownHost({ host: `${TSDNS}:8443`, origin: `https://${TSDNS}:8443` }, allow, { requireOrigin: true }), false);
});

test('classifyServeConfig finds Funnel at every documented serve-config depth', () => {
  assert.equal(classifyServeConfig('{"AllowFunnel":{"h:443":true}}'), 'funnel');
  assert.equal(classifyServeConfig('{"Foreground":{"https":{"Foreground":{"child":{"AllowFunnel":{"h:443":true}}}}}}'), 'funnel');
});

test('classifyServeConfig accepts only well-formed no-Funnel serve configs as clear', () => {
  assert.equal(classifyServeConfig('{"TCP":{"443":{"HTTPS":true}},"Web":{"h:443":{"Handlers":{}}}}'), 'clear');
  assert.equal(classifyServeConfig('{"AllowFunnel":{"h:443":false}}'), 'clear');
});

test('classifyServeConfig fails closed for unavailable, malformed, and structurally surprising configs', () => {
  for (const value of [null, '[]', '"x"', '42', '{', '{"AllowFunnel":true}', '{"AllowFunnel":["x"]}', '{"AllowFunnel":{"h":1}}', '{"Foreground":[]}']) {
    assert.equal(classifyServeConfig(value), 'unknown', String(value));
  }
});

test('funnelStateAfter retains a brief probe outage but fails closed under sustained failure', () => {
  assert.deepEqual(funnelStateAfter('unknown', 2, 'clear', 3), { state: 'clear', misses: 0 });
  assert.deepEqual(funnelStateAfter('clear', 2, 'funnel', 3), { state: 'funnel', misses: 0 });

  assert.deepEqual(funnelStateAfter('clear', 0, 'unknown', 3), { state: 'clear', misses: 1 });
  assert.deepEqual(funnelStateAfter('clear', 1, 'unknown', 3), { state: 'clear', misses: 2 });

  assert.deepEqual(funnelStateAfter('clear', 2, 'unknown', 3), { state: 'unknown', misses: 3 });
  assert.deepEqual(funnelStateAfter('unknown', 3, 'unknown', 3), { state: 'unknown', misses: 4 });

  assert.deepEqual(funnelStateAfter('unknown', 5, 'clear', 3), { state: 'clear', misses: 0 });
  assert.deepEqual(funnelStateAfter('clear', 0, 'unknown', 1), { state: 'unknown', misses: 1 });
});
