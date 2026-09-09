#!/usr/bin/env node
'use strict';
// Scheme — a self-hosted cockpit for driving Claude Code, Codex or a local LLM that runs on THIS
// machine from a browser on another one. This file is the whole server: static page, a Server-Sent
// Events feed (host vitals + per-session lights), the terminal control plane (/api/term/*) and the
// WebSocket that bridges the browser's xterm to a tmux-backed PTY.
//
// Security model (same as the fleet dashboard this was carved from):
//   * Every route is Host-pinned (lib/originguard) so a DNS-rebinding page cannot read it.
//   * The terminal plane (/api/term/* + the WebSocket) is LOOPBACK-SOCKET ONLY and requires a
//     same-origin Origin on state-changing requests. An SSH tunnel and `tailscale serve` both
//     terminate on 127.0.0.1, which is exactly how a remote machine is meant to reach it.
//   * If Tailscale Funnel (public internet exposure) is detected, the terminal plane is refused.
//     A machine without the `tailscale` binary cannot be Funnel-exposed, so it is treated as clear.
// The heavy lifting (tmux session lifecycle, transcript telemetry, guards, jailed file access) lives
// in ./lib — every module there is unit-tested on its own.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');

const metrics = require('./lib/metrics');
const terminal = require('./lib/terminal');
const { runtimeOf, runtimeConflict } = require('./lib/runtime');
const { analyzeTranscript } = require('./lib/telemetry');
const { analyzeCodexRollout, codexTranscriptPath, resolveCodexRollout } = require('./lib/codex-telemetry');
const { loadCodexTelemetry, codexJournalStatKey } = require('./lib/codex-telemetry-source');
const accountUsage = require('./lib/account-usage').createAccountUsageReader();
const { contextWindowFor } = require('./lib/ctxwindow');
const { probeDue } = require('./lib/tsretry');
const gitStatus = require('./lib/gitstatus').createGitStatus();
const { acceptKey, encodeFrame, decodeFrame, OPCODES } = require('./lib/wsframe');
const fsjail = require('./lib/fsjail');
const { isLoopback, sameSiteKnownHost, dashboardHostSet, terminalHostSet, classifyServeConfig, funnelStateAfter } = require('./lib/originguard');
const { createControlGate } = require('./lib/controlgate');
const funnelProbe = require('./lib/funnel-probe');
const claudeToggles = require('./lib/claude-toggles');
const audit = require('./lib/audit');
const idleclose = require('./lib/idleclose');
const { atomicWriteFile } = require('./lib/atomicfile');
const { boundedWrite, writeWithBackpressure } = require('./lib/backpressure');

// Scrub the CLAUDE_CODE_* leak from our OWN env before we spawn anything. If this server was
// started from inside a Claude Code session, every terminal it launches would otherwise inherit a
// stale session identity and boot as a nested child that writes no transcript (dead lights).
for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_TMPDIR', 'AI_AGENT', 'CODEX_COMPANION_SESSION_ID']) {
  delete process.env[k];
}

// ---- configuration (environment) ------------------------------------------
const HOME = process.env.HOME || os.homedir();
const SYSMON_PORT = String(process.env.SYSMON_PORT || '').trim();
const parsedPort = Number(SYSMON_PORT);
const PORT = SYSMON_PORT && Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 3000;
let boundPort = PORT;
const HOST = process.env.SYSMON_HOST || '127.0.0.1';   // loopback by default; remote access goes through a tunnel
const SAMPLE_MS = 2000;
const SLOW_MS = 5000;
const NCORES = os.cpus().length;
const CLK_TCK = numFromGetconf('CLK_TCK', 100);
const PAGE = numFromGetconf('PAGESIZE', 4096);
const IS_LINUX = process.platform === 'linux';
const auditActor = (req) => (req.socket && req.socket.remoteAddress) || 'unknown';

function numFromGetconf(key, fallback) {
  try { return Number(execFileSync('getconf', [key], { encoding: 'utf8' }).trim()) || fallback; }
  catch { return fallback; }
}
function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}
function onPath(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}

// ---- Tailscale Funnel guard --------------------------------------------------
// Funnel = the machine is reachable from the public internet. That must never carry a terminal.
// Anti-flap: a brief probe outage keeps the last verdict; sustained failure fails CLOSED. A box
// with no tailscale binary at all is permanently `clear` (nothing can Funnel-expose it).
const HAS_TAILSCALE = onPath('tailscale');
let _funnelState = HAS_TAILSCALE ? 'unknown' : 'clear';
let _funnelProbing = false;
let _funnelMisses = 0;
const FUNNEL_MAX_MISSES = Math.max(1, Number(process.env.COMMAND_DECK_FUNNEL_MAX_MISSES) || 3);
function terminalExposedByFunnel() { return _funnelState !== 'clear'; }
async function refreshFunnel() {
  if (!HAS_TAILSCALE || _funnelProbing) return;
  _funnelProbing = true;
  try {
    const { ok, stdout } = await funnelProbe.readServeConfig();
    const v = classifyServeConfig(ok ? stdout : null);
    const next = funnelStateAfter(_funnelState, _funnelMisses, v, FUNNEL_MAX_MISSES);
    _funnelState = next.state; _funnelMisses = next.misses;
  } catch {} finally { _funnelProbing = false; }
}

// ---- Tailscale identity (for the host allowlist + Connect panel) --------------
let _tsIp = null, _tsDns = null, _tsProbeAt = 0;
const _tsBootAt = Date.now();
function tailscaleIp() { return _tsIp || process.env.COMMAND_DECK_TSIP || ''; }
function tailscaleDnsName() { return _tsDns || ''; }
async function refreshTailscale() {
  if (!HAS_TAILSCALE || (_tsIp && _tsDns)) return;
  const now = Date.now();
  if (!probeDue({ now, lastProbeAt: _tsProbeAt, bootAt: _tsBootAt })) return;
  _tsProbeAt = now;
  if (!_tsIp) {
    const out = await run('tailscale', ['ip', '-4'], 3000);
    const ip = String(out || '').trim().split('\n')[0];
    if (ip) _tsIp = ip;
  }
  if (!_tsDns) {
    try {
      const out = await run('tailscale', ['status', '--json'], 3000);
      const j = JSON.parse(out);
      const dns = j && j.Self && String(j.Self.DNSName || '').replace(/\.$/, '').toLowerCase().trim();
      if (dns) _tsDns = dns;
    } catch {}
  }
}

// ---- host vitals ---------------------------------------------------------------
// Linux reads /proc directly; elsewhere the samplers return null and the page shows "—".
function readCpuRaw() {
  const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n').filter((l) => l.startsWith('cpu'));
  const parse = (l) => {
    const n = l.trim().split(/\s+/).slice(1).map(Number);
    const idle = (n[3] || 0) + (n[4] || 0);
    let total = 0;
    for (let i = 0; i < 8; i++) total += n[i] || 0;
    return { idle, total };
  };
  return { agg: parse(lines[0]), cores: lines.slice(1).map(parse) };
}
let prevCpu = null;
function cpuDelta() {
  if (!IS_LINUX) return null;
  try {
    const cur = readCpuRaw();
    const prev = prevCpu || cur;
    const pct = (p, c) => { const dt = c.total - p.total, di = c.idle - p.idle; return dt > 0 ? clamp((1 - di / dt) * 100) : 0; };
    const out = { overall: pct(prev.agg, cur.agg), cores: cur.cores.map((c, i) => pct(prev.cores[i] || c, c)) };
    prevCpu = cur;
    return out;
  } catch { return null; }
}
function readMem() {
  if (IS_LINUX) {
    try {
      const m = {};
      fs.readFileSync('/proc/meminfo', 'utf8').split('\n').forEach((l) => { const x = l.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = Number(x[2]) * 1024; });
      const total = m.MemTotal || 0;
      const avail = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0) + (m.Cached || 0) + (m.Buffers || 0);
      return { total, avail, used: total - avail, free: m.MemFree || 0, swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0) };
    } catch {}
  }
  const total = os.totalmem(), free = os.freemem();
  return { total, avail: free, used: total - free, free, swapTotal: 0, swapUsed: 0 };
}
// Per-process scan: only what the terminal rail needs (per-pane resource subtree).
let prevProc = new Map();
let lastProcTree = null;   // { at, byPid, children }
function scanProcs() {
  if (!IS_LINUX) return;
  const now = Date.now();
  let pids;
  try { pids = fs.readdirSync('/proc').filter((f) => /^\d+$/.test(f)); } catch { return; }
  const next = new Map();
  const byPid = new Map();
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rp = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, rp);
      const r = stat.slice(rp + 2).split(' ');
      const jiffies = (Number(r[11]) || 0) + (Number(r[12]) || 0);
      let memBytes = 0;
      try { memBytes = (Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) || 0) * PAGE; } catch {}
      const prev = prevProc.get(pid);
      let cpu = 0;
      if (prev) { const dt = (now - prev.t) / 1000; if (dt > 0) cpu = clamp((((jiffies - prev.jiffies) / CLK_TCK) / dt) * 100 / NCORES); }
      next.set(pid, { jiffies, t: now });
      byPid.set(Number(pid), { cpu, memBytes, comm, ppid: Number(r[1]) || 0 });
    } catch { /* process vanished */ }
  }
  prevProc = next;
  lastProcTree = { at: now, byPid, children: metrics.buildChildrenIndex(byPid) };
}
async function getGpu() {
  const out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit', '--format=csv,noheader,nounits'], 3000);
  if (!out.trim()) return null;
  const c = out.trim().split('\n')[0].split(',').map((s) => s.trim());
  const num = (v) => (/^-?[\d.]+$/.test(v) ? Number(v) : null);
  return { name: c[0], util: num(c[1]), memUsed: num(c[2]), memTotal: num(c[3]), temp: num(c[4]), powerDraw: num(c[5]), powerLimit: num(c[6]) };
}
const OLLAMA_URL = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
async function getOllama() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { models: [], total: 0 };
    return metrics.parseOllamaPs(await r.json(), readMem().total);
  } catch { return { models: [], total: 0 }; }
}
// Read the last `lines` lines of a (possibly huge) file by reading only the trailing `maxBytes`.
function readTail(file, lines = 25, maxBytes = 16384) {
  return new Promise((resolve) => {
    fs.open(file, 'r', (err, fd) => {
      if (err) return resolve('');
      fs.fstat(fd, (e2, st) => {
        if (e2) { fs.close(fd, () => {}); return resolve(''); }
        const start = Math.max(0, st.size - maxBytes);
        const len = st.size - start;
        if (len <= 0) { fs.close(fd, () => {}); return resolve(''); }
        const buf = Buffer.alloc(len);
        fs.read(fd, buf, 0, len, start, (e3, bytes) => {
          fs.close(fd, () => {});
          resolve(e3 ? '' : metrics.tailLines(buf.subarray(0, bytes).toString('utf8'), lines));
        });
      });
    });
  });
}
function clamp(n) { return Math.max(0, Math.min(100, n)); }
function round1(n) { return Math.round(n * 10) / 10; }

// ---- per-session lights (one transcript walk per tick) + idle-tab reaper ------------
const lightsCollector = require('./lib/lights').createLightsCollector({
  statFile: (f) => fs.statSync(f),
  readTail,
  transcriptPath: terminal.transcriptPath,
  resolveCodexRollout,
  analyzeTranscript,
  analyzeCodexRollout,
  loadCodexTelemetry,
  codexJournalStatKey,
  backfillCodexUuid: (s, all) => terminal.backfillCodexUuid(s, all),
  contextWindowFor,
  warn: (m) => console.warn(m),
});
const IDLE_TMUX_FORMAT = '#{session_name}\t#{session_activity}\t#{session_created}\t#{pane_current_command}';
const idleCloser = idleclose.createIdleCloser({
  listSessions: () => terminal.listSessions(),
  tmuxActivity: async () => {
    const out = await run(terminal.TMUX_BIN, terminal.tmuxArgs(['list-sessions', '-F', IDLE_TMUX_FORMAT]), 5000);
    const map = {};
    for (const line of String(out || '').split('\n')) {
      const [id, activity, created, paneCmd] = line.split('\t');
      if (!id) continue;
      map[id] = { activity: Number(activity) * 1000 || null, created: Number(created) * 1000 || null, paneCmd: (paneCmd || '').trim() || null };
    }
    return map;
  },
  readTail: (f, bytes) => readTail(f, 400, bytes),
  transcriptFor: (s) => {
    if (s.shell) return null;
    if (s.codex) { const r = s.codexUuid ? resolveCodexRollout(s.codexUuid) : null; return r && r.path ? r.path : null; }
    return terminal.transcriptPath(s.cwd, s.uuid);
  },
  killSession: (id) => terminal.killSession(id),
  audit: (e) => audit.appendEntry(e),
});

// ---- project directories offered by the "New session" picker -------------------
// $HOME, the direct children of a few conventional code folders, plus SCHEME_PROJECT_DIRS
// (colon-separated absolute paths). Only directories that exist are listed.
async function listProjects() {
  const out = new Set([HOME]);
  const roots = ['projects', 'src', 'code', 'dev', 'repos', 'work'].map((d) => path.join(HOME, d));
  for (const sub of roots) {
    try { for (const d of fs.readdirSync(sub, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.')) out.add(path.join(sub, d.name)); } catch {}
  }
  for (const p of String(process.env.SCHEME_PROJECT_DIRS || '').split(':')) {
    const abs = p.trim();
    if (!abs || !path.isAbsolute(abs)) continue;
    try { if (fs.statSync(abs).isDirectory()) out.add(abs); } catch {}
  }
  return [...out].sort();
}
function parseGitStatus(out) {
  // -z leaves paths unquoted; --no-renames keeps one path per NUL-delimited record.
  return String(out || '').split('\0').filter(Boolean).slice(0, 400).map((l) => ({ xy: l.slice(0, 2), path: l.slice(3) }));
}

// ---- shared scratchpad (rail "Notes") ------------------------------------------
const NOTES_FILE = process.env.COMMAND_DECK_NOTES || path.join(HOME, '.claude', 'command-deck', 'notes.md');
const NOTES_MAX = 256 * 1024;
async function readNotes() {
  try {
    const [st, text] = await Promise.all([fs.promises.stat(NOTES_FILE), fs.promises.readFile(NOTES_FILE, 'utf8')]);
    return { ok: true, text, savedAt: Math.round(st.mtimeMs) };
  } catch { return { ok: true, text: '', savedAt: 0 }; }
}
async function saveNotes(text) {
  if (text.length > NOTES_MAX) return { ok: false, error: 'notes too large (256KB cap)' };
  try { await atomicWriteFile(NOTES_FILE, text); return { ok: true, savedAt: Date.now() }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ---- Connect panel: how to reach this machine from another one ------------------
const SSH_USER = (os.userInfo && os.userInfo().username) || process.env.USER || 'user';
function isTailscaleIpv4(ip) {
  const p = String(ip || '').split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a && a.family === 'IPv4' && !a.internal && !isTailscaleIpv4(a.address)) return a.address;
  }
  return '';
}
function buildConnectInfo() {
  const tsIp = tailscaleIp(), tsDns = tailscaleDnsName(), lan = lanIp();
  const sshHost = tsIp || lan || os.hostname();
  return {
    ok: true,
    host: os.hostname(),
    home: HOME,
    port: boundPort,
    sshUser: SSH_USER,
    tailscaleIp: tsIp || null,
    tailscaleDns: tsDns || null,
    lanIp: lan || null,
    urls: {
      tailscaleDns: tsDns ? `https://${tsDns}` : null,
      localhost: `http://localhost:${boundPort}`,
    },
    commands: {
      sshTunnel: `ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L ${boundPort}:localhost:${boundPort} ${SSH_USER}@${sshHost}`,
      tailscaleServe: `tailscale serve --bg --https=443 http://127.0.0.1:${boundPort}`,
    },
  };
}
function genConnectBat() {
  const host = tailscaleIp() || lanIp() || os.hostname();
  return [
    '@echo off',
    'REM ====================================================================',
    'REM  Scheme connector. Opens an SSH tunnel to the machine running Scheme',
    `REM  (${host}) and launches Scheme in your browser.`,
    'REM  Needs: your SSH key already set up on that machine (and Tailscale',
    'REM  running on both ends if you connect over Tailscale).',
    'REM  Close the "Scheme Tunnel" window to disconnect.',
    'REM ====================================================================',
    'title Scheme connector',
    `echo Connecting to Scheme on ${host} ...`,
    'echo.',
    '"%ProgramFiles%\\Tailscale\\tailscale.exe" up >nul 2>&1',
    `start "Scheme Tunnel (keep open)" cmd /k ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L ${boundPort}:localhost:${boundPort} ${SSH_USER}@${host}`,
    'timeout /t 3 /nobreak >nul',
    `start "" http://localhost:${boundPort}`,
    'echo.',
    'echo If the page does not load yet, wait for the tunnel window to finish connecting',
    'echo (first time it may ask to confirm the host - type yes), then refresh the browser.',
    'timeout /t 5 /nobreak >nul',
  ].join('\r\n') + '\r\n';
}

// ---- open-URL relay --------------------------------------------------------------
// An agent inside a session calls xdg-open; lib/terminal's shim POSTs the URL here and the page
// shows a click-to-open toast, so links open on YOUR device instead of the host's desktop.
const OPENURL_TTL = 90e3;
let pendingOpen = [];

// ---- tick: vitals + lights → SSE ---------------------------------------------------
let lastPayload = {};
let busy = false, slowBusy = false, _slowN = 0, _lightsTimed = false, _idleSwept = false;
let gpuCache = null, ollamaCache = { models: [], total: 0 };
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const cpu = cpuDelta();
    const mem = readMem();
    scanProcs();
    // Assemble the whole frame first, publish it once: a reader that arrives mid-tick (the SSE
    // handler's initial frame, /api/stats) must never see vitals without the session fields.
    const next = {
      ts: Date.now(), host: os.hostname(), uptime: os.uptime(), nCores: NCORES, load: os.loadavg(),
      cpu, mem, gpu: gpuCache, ollama: ollamaCache,
      openUrls: (pendingOpen = pendingOpen.filter((o) => Date.now() - o.ts < OPENURL_TTL)).map((o) => ({ id: o.id, url: o.url })),
    };
    try {
      const sessions = await terminal.listSessions();
      const t0 = Date.now();
      const { termLights, attention } = await lightsCollector.collect(sessions);
      if (!_lightsTimed) { _lightsTimed = true; console.log(`[scheme] lights walk: ${Date.now() - t0}ms over ${sessions.length} sessions`); }
      next.termLights = termLights;
      next.termAttention = attention;
    } catch { next.termAttention = {}; }   // no termLights field = "walk failed", clients fall back to polling
    lastPayload = next;
    broadcast(lastPayload);
  } catch (e) {
    console.error('[scheme] tick error:', e.message);
  } finally { busy = false; }
}
async function slowTick() {
  if (slowBusy) return;
  slowBusy = true; _slowN++;
  try {
    const [gpu, ollama] = await Promise.all([getGpu(), getOllama()]);
    gpuCache = gpu; ollamaCache = ollama;
    await refreshTailscale();
    await refreshFunnel();
    // Idle-tab sweep every 120 slow ticks (10 min); the first lands 10 min after boot.
    if (_slowN % 120 === 0) {
      try {
        const r = await idleCloser.sweep(lastPayload.termLights);
        if (!_idleSwept) {
          _idleSwept = true;
          console.log(`[scheme] idle-close: threshold ${idleclose.thresholdMs(process.env) / idleclose.HOUR_MS}h, swept ${r.scanned} sessions, closed ${r.closed.length}${r.skipped ? ` (skipped: ${r.skipped})` : ''}`);
        }
      } catch (e) { console.error('[scheme] idle-close sweep failed:', e && e.message || e); }
    }
  } catch (e) {
    console.error('[scheme] slow tick failed:', e && e.message || e);
  } finally { slowBusy = false; }
}

// ---- HTTP + SSE --------------------------------------------------------------------
const clients = new Set();
const MAX_SSE_BUFFER = 512 * 1024;
const MAX_WS_BUFFER = 1024 * 1024;
const MAX_WS_INBOUND = 1024 * 1024;
let lastBroadcast = 0;
function publicSafePayload(p) {
  return { ts: p.ts, host: p.host, uptime: p.uptime, nCores: p.nCores, load: p.load, cpu: p.cpu, mem: p.mem, gpu: p.gpu };
}
function broadcast(payload) {
  lastBroadcast = Date.now();
  const data = `data: ${JSON.stringify(terminalExposedByFunnel() ? publicSafePayload(payload) : payload)}\n\n`;
  for (const res of clients) {
    const result = boundedWrite(res, data, MAX_SSE_BUFFER);
    if (!result.ok) { clients.delete(res); try { res.end(); } catch {} }
  }
}
const PUBLIC = path.join(__dirname, 'public');
const INDEX = path.join(PUBLIC, 'index.html');
function sendJson(res, code, obj) {
  if (res.writableEnded || res.destroyed) return;
  try { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); } catch {}
}
function dashboardHosts() {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a && a.address && !a.internal) addrs.push(a.address);
  return dashboardHostSet({ port: boundPort, addrs, tsIp: tailscaleIp(), tsDns: tailscaleDnsName(), extra: process.env.COMMAND_DECK_ALLOWED_HOSTS || '' });
}
function terminalHosts() { return terminalHostSet({ port: boundPort, tsDns: tailscaleDnsName() }); }
const { guardedControlBody } = createControlGate({ sendJson, dashboardHosts });
function serveVendor(req, res) {
  const name = path.basename(req.url.split('?')[0]);   // basename → no path traversal
  const p = path.join(PUBLIC, 'vendor', name);
  fs.readFile(p, (err, b) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = name.endsWith('.css') ? 'text/css' : 'application/javascript';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
    res.end(b);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!sameSiteKnownHost(req.headers, dashboardHosts())) return sendJson(res, 403, { ok: false, error: 'untrusted dashboard host' });
    const route = req.url.split('?')[0];
    const funnelPublicRoute = route === '/' || route === '/index.html' || route === '/manifest.json' || route === '/icon.svg'
      || route === '/icon-alert.svg' || route === '/favicon.ico' || route.startsWith('/vendor/') || route === '/events' || route === '/api/stats';
    if (terminalExposedByFunnel() && !funnelPublicRoute) return sendJson(res, 503, { ok: false, error: 'public Funnel exposure is blocked' });

    if (route === '/' || route === '/index.html') {
      fs.readFile(INDEX, (err, buf) => {
        if (err) { res.writeHead(500); return res.end('index.html missing'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    } else if (route === '/manifest.json' || route === '/icon.svg' || route === '/icon-alert.svg' || route === '/favicon.ico') {
      const name = route === '/favicon.ico' ? 'icon.svg' : route.slice(1);
      fs.readFile(path.join(PUBLIC, name), (err, b) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': name === 'manifest.json' ? 'application/manifest+json' : 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
        res.end(b);
      });
    } else if (route.startsWith('/vendor/')) {
      serveVendor(req, res);
    } else if (route === '/connect.bat') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="scheme-connect.bat"', 'Cache-Control': 'no-store' });
      res.end(genConnectBat());
    } else if (req.method === 'GET' && route === '/api/connect-info') {
      return sendJson(res, 200, buildConnectInfo());
    } else if (route === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      if (lastPayload.ts) res.write(`data: ${JSON.stringify(terminalExposedByFunnel() ? publicSafePayload(lastPayload) : lastPayload)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (route === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(terminalExposedByFunnel() ? publicSafePayload(lastPayload) : lastPayload));
    } else if (route === '/api/audit') {
      let limit = 200;
      try { limit = Math.min(1000, Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('limit') || '200', 10) || 200)); } catch {}
      return sendJson(res, 200, { ok: true, ts: Date.now(), entries: audit.readRecent(limit) });
    } else if (req.method === 'POST' && route === '/api/openurl') {
      const g = await guardedControlBody(req, res, 'openurl'); if (!g.ok) return;
      let url = ''; try { url = new URLSearchParams(g.payload.raw).get('url') || ''; } catch {}
      if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { ok: false, error: 'only http(s) urls' });
      pendingOpen = pendingOpen.filter((o) => Date.now() - o.ts < OPENURL_TTL).slice(-9);
      pendingOpen.push({ id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url: url.slice(0, 2048), ts: Date.now() });
      return sendJson(res, 200, { ok: true });
    } else if (req.method === 'POST' && route === '/api/openurl/ack') {
      const g = await guardedControlBody(req, res, 'openurlAck'); if (!g.ok) return;
      const id = (g.payload != null && g.payload.id) || '';
      pendingOpen = pendingOpen.filter((o) => o.id !== id);
      return sendJson(res, 200, { ok: true });
    } else if (route === '/api/claude-toggles') {
      // Claude runtime switches: GET = derived booleans only (settings.json is never echoed);
      // POST flips one switch through the loopback + same-origin gate. New Claude sessions only.
      if (req.method === 'GET') return sendJson(res, 200, claudeToggles.readState());
      if (req.method === 'POST') {
        const g = await guardedControlBody(req, res, 'dashboardControl'); if (!g.ok) return;
        const name = String(g.payload.name || '');
        const r = await claudeToggles.setToggle(name, !!g.payload.on);
        audit.appendEntry({ actor: auditActor(req), action: `claude:${name}:${g.payload.on ? 'on' : 'off'}`, target: 'claude-config', detail: r.ok ? (r.warnings || []).join('; ') : (r.error || ''), ok: !!r.ok });
        return sendJson(res, r.ok ? 200 : (r.status || 400), r);
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    } else if (route.startsWith('/api/term/')) {
      // Terminal control plane — LOOPBACK SOCKETS ONLY (it spawns agents = code execution as you).
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'terminal is loopback-only — connect via the SSH tunnel or tailscale serve' });
      // Loopback alone is not enough: a page you open elsewhere could drive 127.0.0.1 from your
      // browser. Pin Host, reject cross-origin, and REQUIRE a same-origin Origin on every POST.
      if (!sameSiteKnownHost(req.headers, terminalHosts(), { requireOrigin: req.method === 'POST' })) return sendJson(res, 403, { ok: false, error: 'cross-origin, rebinding, or origin-less state-changing request blocked' });
      if (req.method === 'GET' && route === '/api/term/sessions') return sendJson(res, 200, { ok: true, sessions: await terminal.listSessions() });
      if (req.method === 'GET' && route === '/api/term/projects') return sendJson(res, 200, { ok: true, projects: await listProjects() });
      if (req.method === 'GET' && route === '/api/term/account-usage') {
        const usage = await accountUsage.get();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(usage));
      }
      if (req.method === 'GET' && route === '/api/term/telemetry') {
        let id = '', full = false;
        try { const q = new URL(req.url, 'http://x').searchParams; id = q.get('id') || ''; full = q.get('full') === '1'; } catch {}
        const sess = (await terminal.listSessions()).find((s) => s.id === id);
        if (!sess) return sendJson(res, 404, { ok: false, error: 'unknown session' });
        let tel, started;
        if (runtimeConflict(sess)) { tel = { runtime: 'conflict' }; started = true; }
        else {
          const rt = runtimeOf(sess);
          switch (rt) {
            case 'shell': tel = { runtime: 'shell' }; started = true; break;
            case 'codex': {
              const cfile = sess.codexUuid ? codexTranscriptPath(sess.codexUuid) : null;
              const ctext = cfile ? await readTail(cfile, full ? 40000 : 4000, (full ? 8 : 1) * 1024 * 1024) : '';
              tel = loadCodexTelemetry(sess, ctext); tel.runtime = 'codex'; started = !!ctext;
              break;
            }
            case 'claude': case 'local': {
              const file = terminal.transcriptPath(sess.cwd, sess.uuid);
              const text = file ? await readTail(file, full ? 40000 : 4000, (full ? 8 : 1) * 1024 * 1024) : '';
              tel = analyzeTranscript(text); tel.runtime = rt; tel.contextWindow = contextWindowFor(tel.model); started = !!text;
              break;
            }
            default: return sendJson(res, 500, { ok: false, error: 'unknown runtime' });
          }
        }
        tel.git = gitStatus.get(sess.cwd);
        const pt = lastProcTree;
        tel.proc = (pt && Date.now() - pt.at < 10000 && sess.panePid) ? metrics.subtreeStats(pt.byPid, pt.children, sess.panePid) : null;
        if (tel.proc) tel.proc.cpu = round1(tel.proc.cpu);
        return sendJson(res, 200, { ok: true, id, name: sess.name, cwd: sess.cwd, started, telemetry: tel });
      }
      if (req.method === 'POST' && route === '/api/term/sessions') {
        const g = await guardedControlBody(req, res, 'termBody'); if (!g.ok) return;
        const p = g.payload;
        const created = await terminal.createSession({ label: p.label, cwd: p.cwd, cols: p.cols, rows: p.rows, prompt: p.prompt, local: !!p.local, localModel: p.localModel, codex: !!p.codex, codexModel: p.codexModel, shell: !!p.shell });
        const runtimeTag = p.local ? ' [local]' : p.codex ? ' [codex]' : p.shell ? ' [shell]' : '';
        audit.appendEntry({ actor: auditActor(req), action: 'term:create', target: String(p.label || (created && created.id) || ''), detail: String(p.cwd || '') + runtimeTag, ok: !!(created && created.ok !== false) });
        return sendJson(res, created && created.capped ? 429 : 200, created);
      }
      if (req.method === 'POST' && (route === '/api/term/kill' || route === '/api/term/rename')) {
        const g = await guardedControlBody(req, res, 'termBody'); if (!g.ok) return;
        const p = g.payload;
        const r = route === '/api/term/kill' ? await terminal.killSession(String(p.id || '')) : await terminal.renameSession(String(p.id || ''), String(p.label || ''));
        if (route === '/api/term/kill') audit.appendEntry({ actor: auditActor(req), action: 'term:kill', target: String(p.id || ''), ok: r.ok });
        return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, error: r.ok ? undefined : (r.error || (r.stderr || '').trim() || 'terminal session operation failed') });
      }
      if (req.method === 'POST' && route === '/api/term/respond') {
        // Answer a session that is blocked on a question / plan approval without attaching the xterm.
        const g = await guardedControlBody(req, res, 'termBody'); if (!g.ok) return;
        const id = String(g.payload.id || '');
        const r = await terminal.respond(id, g.payload.text);
        audit.appendEntry({ actor: auditActor(req), action: 'term:respond', target: id, detail: terminal.sanitizeResponse(g.payload.text).slice(0, 80), ok: r.ok });
        return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, error: r.ok ? undefined : (r.error || 'respond failed') });
      }
      if (route === '/api/term/notes') {
        if (req.method === 'GET') return sendJson(res, 200, await readNotes());
        if (req.method === 'POST') {
          const g = await guardedControlBody(req, res, 'termNotes'); if (!g.ok) return;
          const r = await saveNotes(String(g.payload.text == null ? '' : g.payload.text));
          return sendJson(res, r.ok ? 200 : 400, r);
        }
      }
      if (req.method === 'POST' && route === '/api/term/reorder') {
        const g = await guardedControlBody(req, res, 'termBody'); if (!g.ok) return;
        const r = terminal.reorder(Array.isArray(g.payload.ids) ? g.payload.ids.map(String) : []);
        return sendJson(res, r.ok ? 200 : 400, { ok: r.ok });
      }
      if (req.method === 'GET' && route === '/api/term/scrollstate') {
        let id = ''; try { id = new URL(req.url, 'http://x').searchParams.get('id') || ''; } catch {}
        return sendJson(res, 200, await terminal.scrollState(id));
      }
      if (req.method === 'GET' && route === '/api/term/dump') {
        let id = ''; try { id = new URL(req.url, 'http://x').searchParams.get('id') || ''; } catch {}
        return sendJson(res, 200, await terminal.captureScrollback(id));
      }
      if (req.method === 'POST' && route === '/api/term/scroll') {
        const g = await guardedControlBody(req, res, 'termBody'); if (!g.ok) return;
        const r = await terminal.scrollOp(String(g.payload.id || ''), String(g.payload.op || ''), g.payload.n);
        return sendJson(res, r.ok ? 200 : 400, { ok: r.ok });
      }
      if (req.method === 'GET' && (route === '/api/term/fs' || route === '/api/term/find' || route === '/api/term/git')) {
        let q; try { q = new URL(req.url, 'http://x').searchParams; } catch { q = new URLSearchParams(); }
        const id = q.get('id') || '';
        const sess = (await terminal.listSessions()).find((s) => s.id === id);
        if (!sess) return sendJson(res, 404, { ok: false, error: 'unknown session' });
        if (!(await terminal.hasSession(sess.id))) return sendJson(res, 404, { ok: false, error: 'unknown session' });
        if (route === '/api/term/fs') { const r = fsjail.listDir(sess.cwd, q.get('rel') || ''); return sendJson(res, r.ok ? 200 : 400, r); }
        if (route === '/api/term/find') return sendJson(res, 200, { ok: true, matches: fsjail.findFiles(sess.cwd, q.get('q') || '') });
        // git: FIXED argv, cwd-jailed, diff path validated through fsjail. Read-only.
        const cwd = sess.cwd, op = q.get('op') || 'status', rel = q.get('path') || '';
        const isRepo = fs.existsSync(path.join(cwd, '.git'));
        if (op === 'status') {
          if (!isRepo) return sendJson(res, 200, { ok: true, repo: false, files: [] });
          const out = await run('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--no-renames', '-uall'], 4000);
          return sendJson(res, 200, { ok: true, repo: true, files: parseGitStatus(out) });
        }
        if (op === 'diff') {
          if (!isRepo) return sendJson(res, 400, { ok: false, error: 'not a git repo' });
          const abs = fsjail.jailResolve(cwd, rel);
          if (!abs) return sendJson(res, 400, { ok: false, error: 'path escapes the session directory' });
          let out = await run('git', ['-C', cwd, 'diff', '--no-color', '--', abs], 5000);
          if (!out) out = await run('git', ['-C', cwd, 'diff', '--no-color', '--staged', '--', abs], 5000);
          return sendJson(res, 200, { ok: true, path: rel, diff: String(out).slice(0, 200000) });
        }
        return sendJson(res, 400, { ok: false, error: 'bad op' });
      }
      if (req.method === 'POST' && route === '/api/term/upload') {
        const g = await guardedControlBody(req, res, 'termUpload'); if (!g.ok) return;
        const sess = (await terminal.listSessions()).find((s) => s.id === String(g.payload.id || ''));
        if (!sess) return sendJson(res, 404, { ok: false, error: 'unknown session' });
        if (!(await terminal.hasSession(sess.id))) return sendJson(res, 404, { ok: false, error: 'unknown session' });
        const r = fsjail.saveUpload(sess.cwd, g.payload.name, g.payload.data);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      return sendJson(res, 404, { ok: false, error: 'unknown terminal route' });
    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    console.error('[scheme] route error:', req.method, req.url, e && e.stack || e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' }); else { try { res.destroy(); } catch {} }
  }
});

// ---- terminal WebSocket bridge (loopback-only) ---------------------------------------
// Hand-rolled WS (lib/wsframe) bridging the browser to a PTY-backed `tmux attach`. util-linux
// `script` supplies the PTY on Linux, BSD `script` on macOS — no native node module. Closing the
// socket only DETACHES; the session keeps running in tmux and a reload re-attaches.
server.on('upgrade', (req, socket) => {
  if (req.url.split('?')[0] !== '/api/term/attach') return socket.destroy();
  if (!isLoopback(req)) return socket.destroy();
  if (terminalExposedByFunnel()) return socket.destroy();
  if (!sameSiteKnownHost(req.headers, terminalHosts(), { requireOrigin: true })) return socket.destroy();
  let id = '';
  try { id = new URL(req.url, 'http://x').searchParams.get('id') || ''; } catch {}
  const key = req.headers['sec-websocket-key'];
  if (!terminal.isSafeId(id) || !key) return socket.destroy();
  terminal.tuneSocket(socket);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  bridgeSession(socket, id);
});
function ptyArgs(cmd) {
  // util-linux: script -q -f -c "<cmd>" /dev/null ; BSD (macOS): script -q /dev/null <cmd...>
  return process.platform === 'darwin' ? ['-q', '/dev/null', 'sh', '-c', cmd] : ['-q', '-f', '-c', cmd, '/dev/null'];
}
function bridgeSession(socket, id) {
  const cmd = [terminal.TMUX_BIN, ...terminal.tmuxArgs(terminal.tmuxAttachArgs(id))].map(terminal.shquote).join(' ');
  const child = spawn('script', ptyArgs(cmd), { env: { ...process.env, TERM: 'xterm-256color' } });
  let alive = true;
  const closeAll = () => {
    if (!alive) return; alive = false;
    try { child.stdin.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    try { socket.end(); } catch {}
  };
  const toClient = (source, b) => writeWithBackpressure(source, socket, encodeFrame(OPCODES.BINARY, b), { maxBytes: MAX_WS_BUFFER, onOverflow: closeAll });
  child.stdout.on('data', (b) => toClient(child.stdout, b));
  child.stderr.on('data', (b) => toClient(child.stderr, b));
  child.on('exit', () => { try { socket.write(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0))); } catch {} closeAll(); });
  child.on('error', closeAll);
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    if (buf.length + chunk.length > MAX_WS_INBOUND) return closeAll();
    buf = Buffer.concat([buf, chunk]);
    let f;
    while ((f = decodeFrame(buf))) {
      buf = buf.subarray(f.bytesConsumed);
      if (f.opcode === OPCODES.CLOSE) return closeAll();
      if (f.opcode === OPCODES.PING) { try { socket.write(encodeFrame(OPCODES.PONG, f.payload)); } catch {} continue; }
      if (![OPCODES.TEXT, OPCODES.BINARY, OPCODES.CONT].includes(f.opcode)) continue;
      let m = null; try { m = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
      if (m && m.t === 'd' && typeof m.d === 'string') { try { child.stdin.write(m.d); } catch {} }
      else if (m && m.t === 'r') terminal.resize(id, m.c, m.r);
    }
  });
  socket.on('close', closeAll);
  socket.on('error', closeAll);
}

process.on('unhandledRejection', (e) => { console.error('[scheme] unhandledRejection:', e && e.stack || e); });
process.on('uncaughtExceptionMonitor', (e, origin) => { console.error('[scheme] uncaughtException:', origin, e && e.stack || e); });

server.listen(PORT, HOST, async () => {
  boundPort = server.address().port;
  await refreshFunnel().catch(() => {});
  console.log(`scheme on http://${HOST}:${boundPort}  (${os.hostname()}, ${NCORES} cores${HAS_TAILSCALE ? ', tailscale present' : ''})`);
  // SYSMON_NO_SAMPLERS=1 (tests): one tick so /api/stats has a payload, then no loops.
  tick();
  if (process.env.SYSMON_NO_SAMPLERS !== '1') {
    slowTick();
    setInterval(tick, SAMPLE_MS);
    setInterval(slowTick, SLOW_MS);
    setInterval(() => { if (clients.size && Date.now() - lastBroadcast > 1500) broadcast({ hb: Date.now() }); }, 2000);
  }
  // Bring back saved sessions after a reboot (no-op on a normal restart — tmux still holds them).
  terminal.resumeSaved()
    .then((r) => { if (r.issued) console.log(`[scheme] revived ${r.resumed}/${r.total} idle session(s)${terminal.resumeSummary(r)}`); })
    .catch((e) => console.error('[scheme] resumeSaved failed:', e.message));
  if (process.env.SYSMON_NO_SAMPLERS !== '1' && terminal.startSelfHealWatchdog()) console.log('[scheme] self-heal watchdog armed');
});
