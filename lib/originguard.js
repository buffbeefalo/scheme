'use strict';

// Same-origin / anti-DNS-rebinding guard for the LOOPBACK terminal control plane.
//
// The terminal can spawn Claude Code (= RCE as the user), so a loopback remote-addr
// check is NOT sufficient on its own: a web page the user opens in their browser can
// issue requests to http://localhost:<port> (the packets legitimately come FROM
// 127.0.0.1), and a hostname rebound to 127.0.0.1 can do the same. WebSockets aren't
// constrained by the same-origin policy at all. So we additionally:
//   1. Pin the Host header to a loopback name we serve on  → defeats DNS rebinding
//      (a rebinding attack carries Host: attacker.example, not localhost).
//   2. Reject any *present* Origin that isn't one of ours  → defeats drive-by fetch
//      and cross-origin WebSocket handshakes (browsers always send Origin on those).
// A read-only same-origin GET from the real dashboard omits Origin but always carries
// Host: localhost:<port>, so it passes. STATE-CHANGING requests (POST) and the attach
// WebSocket are different: a real browser ALWAYS sends Origin on those (even
// same-origin), so callers pass { requireOrigin: true } and we FAIL CLOSED on an
// absent Origin — an origin-less POST/WS to the RCE surface is never the genuine UI.
// Pure (operates on a headers object) so it is unit-tested without booting the server.

// Socket-level loopback check: the connection's remote address is a local interface. The only
// non-local path that still passes is `tailscale serve`, whose proxy re-originates the request
// FROM 127.0.0.1 (see the host-set notes below). Pure (reads req.socket.remoteAddress) so the
// control-plane gate is unit-tested without booting the server. Callers 403 when this is false.
function isLoopback(req) {
  const a = (req && req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase();
}

function allowedHosts(port) {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

function sameSiteLoopback(headers, port, opts) {
  const requireOrigin = !!(opts && opts.requireOrigin);
  const allow = allowedHosts(port);
  const host = normalizeHost(headers && headers.host);
  if (!allow.has(host)) return false;                       // Host pinning -> blocks rebinding / LAN host
  const origin = headers && headers.origin;
  if (origin != null && origin !== '') {                    // Origin present -> must be one of ours
    try { return allow.has(normalizeHost(new URL(origin).host)); } catch { return false; }
  }
  return !requireOrigin;                                    // no Origin: ok for read-only GET, REJECTED for POST/WS
}

function sameSiteKnownHost(headers, allowed, opts) {
  const requireOrigin = !!(opts && opts.requireOrigin);
  const allow = new Set([...allowed].map(normalizeHost).filter(Boolean));
  const host = normalizeHost(headers && headers.host);
  if (!allow.has(host)) return false;
  const origin = headers && headers.origin;
  if (origin != null && origin !== '') {
    try { return allow.has(normalizeHost(new URL(origin).host)); } catch { return false; }
  }
  return !requireOrigin;
}

// ── host-set builders (tailscale-serve aware) ────────────────────────────────
// `tailscale serve` terminates HTTPS on the tailnet (only the box's own cert can
// do that for its MagicDNS name) and re-originates the request FROM 127.0.0.1 —
// so it passes the socket-level isLoopback gate, and the browser's Host/Origin
// arrive as the PORTLESS dns name (browsers omit :443 on default-port HTTPS).
// That portless form is the ONLY bare entry we ever trust: every direct path
// (LAN IP, tailscale IP, hostname:3000) always carries an explicit port, and a
// rebinding attacker can neither serve a page from our MagicDNS origin nor make
// a browser send that Host without controlling the name + its tailnet cert.

function fmtHostPort(addr, port) {
  const a = String(addr || '').trim();
  if (!a) return '';
  return a.includes(':') && !a.startsWith('[') ? `[${a}]:${port}` : `${a}:${port}`;
}

// Hosts the full dashboard (read-only views + bot control plane) may be served on.
function dashboardHostSet({ port, addrs = [], tsIp = '', tsDns = '', extra = '' }) {
  const out = allowedHosts(port);
  for (const a of addrs) { const h = fmtHostPort(a, port); if (h) out.add(h); }
  const ip = fmtHostPort(tsIp, port);
  if (ip) out.add(ip);
  const dns = normalizeHost(tsDns);
  if (dns) {
    out.add(dns);                                           // via tailscale serve (default-port HTTPS)
    out.add(`${dns}:${port}`);                              // direct hostname:port
    const short = dns.split('.')[0];                        // MagicDNS short name (search-domain form)
    if (short && short !== 'localhost') out.add(`${short}:${port}`);
  }
  for (const h of String(extra).split(',')) {               // operator overrides (env)
    const host = normalizeHost(h);
    if (!host) continue;
    if (host.includes(':')) out.add(host);                  // explicit port → verbatim
    else { out.add(host); out.add(`${host}:${port}`); }     // hostname → trust both forms
  }
  return out;
}

// Hosts the TERMINAL control plane (RCE surface) may be addressed by. Checked only
// AFTER isLoopback(socket) passes, so the sole non-local path that can present the
// tailnet name is tailscaled's own serve proxy. Deliberately no env override and no
// LAN entries: direct LAN/tailscale-IP connections must keep failing this gate.
function terminalHostSet({ port, tsDns = '' }) {
  const out = allowedHosts(port);
  const dns = normalizeHost(tsDns);
  if (dns) out.add(dns);
  return out;
}

function funnelVerdict(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'unknown';
  let sawFunnel = false;
  if ('AllowFunnel' in cfg) {
    const af = cfg.AllowFunnel;
    if (af === null || typeof af !== 'object' || Array.isArray(af)) return 'unknown';
    for (const val of Object.values(af)) {
      if (typeof val !== 'boolean') return 'unknown';
      if (val) sawFunnel = true;
    }
  }
  if ('Foreground' in cfg) {
    const fg = cfg.Foreground;
    if (fg === null || typeof fg !== 'object' || Array.isArray(fg)) return 'unknown';
    for (const child of Object.values(fg)) {
      const verdict = funnelVerdict(child);
      if (verdict === 'unknown') return 'unknown';
      if (verdict === 'funnel') sawFunnel = true;
    }
  }
  return sawFunnel ? 'funnel' : 'clear';
}

function classifyServeConfig(jsonTextOrNull) {
  if (jsonTextOrNull == null) return 'unknown';
  let cfg;
  try { cfg = JSON.parse(jsonTextOrNull); } catch { return 'unknown'; }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return 'unknown';
  return funnelVerdict(cfg);
}

// Funnel-state transition: retain across a BRIEF probe outage (anti-flap, per spec), but
// fail closed under SUSTAINED failure so a stuck `clear` can't leave the RCE surface public.
// Pure → unit-tested without booting the server. verdict ∈ 'clear'|'funnel'|'unknown'.
function funnelStateAfter(prevState, misses, verdict, maxMisses) {
  if (verdict !== 'unknown') return { state: verdict, misses: 0 };
  const m = (Number.isFinite(misses) ? misses : 0) + 1;
  return { state: m >= maxMisses ? 'unknown' : prevState, misses: m };
}

module.exports = { isLoopback, normalizeHost, allowedHosts, sameSiteLoopback, sameSiteKnownHost, dashboardHostSet, terminalHostSet, classifyServeConfig, funnelStateAfter };
