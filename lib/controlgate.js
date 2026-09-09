'use strict';

// Control-plane guard gate: the ONE implementation of the write-plane litany
// (loopback → ctype → origin → body-read → size → abort → parse) behind a fail-closed
// policy registry. Spec: docs/superpowers/specs/2026-07-17-controlgate-design.md.
// Layer 0 (global Host pin) and layer 0b (funnel gate) run UPSTREAM in server.js —
// this module never re-checks them and no policy can disable them.
const { isLoopback, sameSiteKnownHost } = require('./originguard');

// Moved verbatim from server.js — the write plane's only body reader. The finish() latch
// resolves exactly ONE of {body}/{tooLarge}/{aborted}, which is why gate check order between
// tooLarge and aborted is unobservable (spec ledger L4).
function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    const chunks = [];
    let len = 0, done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    req.on('data', (c) => {
      if (done) return;
      len += c.length;                                   // c is a Buffer → real byte count
      if (len > limit) { finish({ tooLarge: true }); return; }   // stop buffering; clean 413 follows
      chunks.push(c);
    });
    req.on('end', () => finish({ body: Buffer.concat(chunks).toString('utf8') }));
    req.on('aborted', () => finish({ aborted: true }));
    req.on('error', () => finish({ aborted: true }));
  });
}

const LOOPBACK_MSG = Object.freeze(Object.assign(Object.create(null), {
  control: 'control is loopback-only — reach it via the SSH tunnel or tailscale serve',
  openurl: 'loopback only',
}));

// The ONLY approved write-plane policies — a new endpoint adds a reviewed row here, never an
// inline literal. Null-prototype + frozen: inherited Object keys ('constructor') must not
// satisfy the lookup. origin:true = same-site + REQUIRED Origin against the live dashboard
// host set (CSRF defense: a browser always attaches Origin to a same-origin POST, so the real
// UI is unaffected; header-less curl and cross-origin pages are blocked).
const POLICIES = Object.freeze(Object.assign(Object.create(null), {
  dashboardControl: Object.freeze({ loopback: 'control', requireJson: true,  origin: true,  parse: 'json', limit: 4096,             tooLargeMsg: 'request body too large' }),
  openurl:          Object.freeze({ loopback: 'openurl', requireJson: false, origin: false, parse: 'raw',  limit: 4096,             tooLargeMsg: 'request body too large' }),
  openurlAck:       Object.freeze({ loopback: 'openurl', requireJson: false, origin: false, parse: 'json', limit: 4096,             tooLargeMsg: 'request body too large' }),
  termBody:         Object.freeze({ loopback: false,     requireJson: false, origin: false, parse: 'json', limit: 4096,             tooLargeMsg: 'request body too large' }),
  termNotes:        Object.freeze({ loopback: false,     requireJson: false, origin: false, parse: 'json', limit: 300 * 1024,       tooLargeMsg: 'notes too large' }),
  termUpload:       Object.freeze({ loopback: false,     requireJson: false, origin: false, parse: 'json', limit: 34 * 1024 * 1024, tooLargeMsg: 'file too large' }),
}));

function createControlGate({ sendJson, dashboardHosts }) {
  // guardedControlBody(req, res, name) → { ok:true, payload } | { ok:false }.
  // ok:false ⇒ a response was already sent OR the connection aborted — caller just returns.
  // payload is the parsed value AS-IS (may be null/false/0/'' — each route's own falsy
  // semantics, including control's null→TypeError→dispatcher-500, are preserved).
  async function guardedControlBody(req, res, name) {
    if (!Object.hasOwn(POLICIES, name)) throw new Error(`unknown control policy "${name}"`);
    const pol = POLICIES[name];
    if (pol.loopback && !isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: LOOPBACK_MSG[pol.loopback] });
      return { ok: false };
    }
    if (pol.requireJson) {
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ctype !== 'application/json') {
        sendJson(res, 415, { ok: false, error: 'must be application/json' });
        return { ok: false };
      }
    }
    if (pol.origin && !sameSiteKnownHost(req.headers, dashboardHosts(), { requireOrigin: true })) {
      sendJson(res, 403, { ok: false, error: 'cross-origin, rebinding, or origin-less control blocked' });
      return { ok: false };
    }
    const body = await readBody(req, pol.limit);
    if (body.tooLarge) { sendJson(res, 413, { ok: false, error: pol.tooLargeMsg }); return { ok: false }; }
    if (body.aborted) return { ok: false };
    if (pol.parse === 'raw') return { ok: true, payload: { raw: body.body || '' } };
    let payload = {};
    try { payload = JSON.parse(body.body || '{}'); } catch {}
    return { ok: true, payload };
  }
  return { guardedControlBody };
}

module.exports = { createControlGate, readBody, POLICIES };
