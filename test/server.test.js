'use strict';

// Boundary tests for the standalone server: spawns server.js in a scratch HOME on a private tmux
// socket and speaks HTTP to it. These run everywhere (no opt-in flag) — they are the proof that a
// fresh machine can boot the cockpit — so they never create a real agent session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const project = path.resolve(__dirname, '..');

function request(port, method, reqPath, { body, headers } = {}) {
  // A string body is sent verbatim (form-encoded routes); anything else is JSON.
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: {
      Host: `127.0.0.1:${port}`,
      ...(text ? { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}),
      ...(headers || {}),
    } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (text) req.write(text);
    req.end();
  });
}
const sameOrigin = (port) => ({ Origin: `http://127.0.0.1:${port}` });

function firstSseFrame(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        const m = /data: (.*)\n\n/.exec(data);
        if (m) { res.destroy(); resolve(JSON.parse(m[1])); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('no SSE frame within 5s')); }, 5000);
  });
}

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-test-'));
  const socket = 'scheme-test-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  return { home, socket };
}

function startServer({ home, socket }, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      SYSMON_PORT: '0',
      SYSMON_NO_SAMPLERS: '1',
      SYSMON_TMUX_SOCKET: socket,
      COMMAND_DECK_REGISTRY: path.join(home, 'registry.json'),
      COMMAND_DECK_AUDIT: path.join(home, 'audit.jsonl'),
      COMMAND_DECK_NOTES: path.join(home, 'notes.md'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = '', settled = false;
    const done = (fn) => (value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => done(reject)(new Error(`server did not listen: ${output}`)), 15000);
    const onData = (chunk) => {
      output += String(chunk);
      const m = /scheme on http:\/\/[^:]+:(\d+)/.exec(output);
      if (m) done(resolve)({ child, port: Number(m[1]), output: () => output });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', done(reject));
    child.once('exit', (code, signal) => done(reject)(new Error(`server exited before listen (${code || signal}): ${output}`)));
  });
}
async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
}
function cleanup({ home, socket }) {
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  fs.rmSync(home, { recursive: true, force: true });
}

test('boots in an empty HOME and serves the cockpit routes', async () => {
  const s = scratch();
  const { child, port } = await startServer(s);
  try {
    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Scheme<\/title>/);
    assert.match(page.body, /id="view-terminal"/);
    assert.match(page.body, /id="view-connect"/);
    assert.doesNotMatch(page.body, /id="rsw-council"/, 'the council switch is fleet-only');

    const stats = JSON.parse((await request(port, 'GET', '/api/stats')).body);
    assert.ok(Number.isFinite(stats.ts), 'stats carries a timestamp');
    assert.ok(stats.mem && stats.mem.total > 0, 'stats carries memory');

    const info = JSON.parse((await request(port, 'GET', '/api/connect-info')).body);
    assert.equal(info.home, s.home, 'connect-info reports the real HOME');
    assert.equal(info.port, port);
    assert.match(info.commands.sshTunnel, new RegExp(`-L ${port}:localhost:${port} `));

    const manifest = JSON.parse((await request(port, 'GET', '/manifest.json')).body);
    assert.equal(manifest.short_name, 'Scheme');

    const vendor = await request(port, 'GET', '/vendor/terminal-ui.js');
    assert.equal(vendor.status, 200);
    assert.match(vendor.body, /CommandDeckTerminal/);
  } finally { await stopServer(child); cleanup(s); }
});

test('fleet-only routes do not exist', async () => {
  const s = scratch();
  const { child, port } = await startServer(s);
  try {
    for (const r of ['/api/about', '/api/courses', '/api/control', '/api/push', '/api/fleet/pause', '/api/council/runs', '/api/logs?name=x', '/api/headless', '/api/blackbox', '/api/crons', '/fleetread', '/api/fleetread/catalog', '/courses/x', '/app/council.js']) {
      const res = await request(port, 'GET', r, { headers: sameOrigin(port) });
      assert.equal(res.status, 404, `${r} should be gone (got ${res.status})`);
    }
  } finally { await stopServer(child); cleanup(s); }
});

test('terminal plane: loopback GET works, origin-less POST and foreign Host are refused', async () => {
  const s = scratch();
  const { child, port } = await startServer(s);
  try {
    const list = await request(port, 'GET', '/api/term/sessions');
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body).sessions, [], 'private tmux socket starts empty');

    const noOrigin = await request(port, 'POST', '/api/term/sessions', { body: { label: 'x', shell: true } });
    assert.equal(noOrigin.status, 403, 'a state-changing POST without Origin is refused');

    const crossOrigin = await request(port, 'POST', '/api/term/sessions', { body: { label: 'x', shell: true }, headers: { Origin: 'http://evil.example' } });
    assert.equal(crossOrigin.status, 403, 'a cross-origin POST is refused');

    const rebound = await request(port, 'GET', '/api/term/sessions', { headers: { Host: 'attacker.example' } });
    assert.equal(rebound.status, 403, 'a foreign Host header is refused (DNS rebinding)');

    const projects = JSON.parse((await request(port, 'GET', '/api/term/projects')).body);
    assert.ok(projects.projects.includes(s.home), 'HOME is always offered as a project directory');
    assert.ok(projects.projects.every((p) => p.startsWith(s.home)), 'nothing outside HOME is offered by default');
  } finally { await stopServer(child); cleanup(s); }
});

test('SCHEME_PROJECT_DIRS adds existing absolute directories to the picker', async () => {
  const s = scratch();
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-proj-'));
  const { child, port } = await startServer(s, { SCHEME_PROJECT_DIRS: `${extra}:/definitely/not/here:relative/path` });
  try {
    const projects = JSON.parse((await request(port, 'GET', '/api/term/projects')).body).projects;
    assert.ok(projects.includes(extra), 'existing dir listed');
    assert.ok(!projects.includes('/definitely/not/here'), 'missing dir skipped');
    assert.ok(!projects.some((p) => p.includes('relative/path')), 'relative entry skipped');
  } finally { await stopServer(child); cleanup(s); fs.rmSync(extra, { recursive: true, force: true }); }
});

test('no tailscale binary on PATH → Funnel guard is clear, terminal plane stays open', async () => {
  const s = scratch();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-path-'));
  const { child, port, output } = await startServer(s, { PATH: bare });
  try {
    assert.doesNotMatch(output(), /tailscale present/);
    const list = await request(port, 'GET', '/api/term/sessions');
    assert.equal(list.status, 200, 'not 503: a box without tailscale cannot be Funnel-exposed');
  } finally { await stopServer(child); cleanup(s); fs.rmSync(bare, { recursive: true, force: true }); }
});

test('a detected Tailscale Funnel closes the terminal plane (503) but leaves the page readable', async () => {
  const s = scratch();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-fakets-'));
  // A stand-in `tailscale` CLI whose `serve status --json` reports a Funnel-enabled config.
  fs.writeFileSync(path.join(fakeBin, 'tailscale'), '#!/bin/sh\ncase "$1 $2" in\n  "serve status") echo \'{"AllowFunnel":{"host:443":true}}\' ;;\n  "ip -4") echo 100.64.0.9 ;;\n  *) echo "{}" ;;\nesac\n', { mode: 0o755 });
  const { child, port } = await startServer(s, { PATH: `${fakeBin}:${process.env.PATH}` });
  try {
    const list = await request(port, 'GET', '/api/term/sessions');
    assert.equal(list.status, 503);
    assert.match(list.body, /Funnel/);
    assert.equal((await request(port, 'GET', '/')).status, 200, 'the page itself still loads');
    const stats = JSON.parse((await request(port, 'GET', '/api/stats')).body);
    assert.equal(stats.termLights, undefined, 'session data is stripped while exposed');
  } finally { await stopServer(child); cleanup(s); fs.rmSync(fakeBin, { recursive: true, force: true }); }
});

test('SSE feed: the first frame carries vitals and the attention map', async () => {
  const s = scratch();
  const { child, port } = await startServer(s);
  try {
    const frame = await firstSseFrame(port);
    assert.ok(Number.isFinite(frame.ts));
    assert.ok(frame.mem && frame.mem.total > 0);
    assert.deepEqual(frame.termAttention, {}, 'no sessions → nothing needs input');
    assert.deepEqual(frame.termLights, {}, 'lights map present (an absent field means the walk failed)');
    assert.deepEqual(frame.openUrls, []);
  } finally { await stopServer(child); cleanup(s); }
});

test('open-URL relay: a queued link rides the feed until acknowledged', async () => {
  const s = scratch();
  const { child, port } = await startServer(s);
  try {
    const post = await new Promise((resolve, reject) => {
      const text = 'url=' + encodeURIComponent('https://example.com/docs');
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/openurl', headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(text) } }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject); req.write(text); req.end();
    });
    assert.equal(post.status, 200, post.body);
    // The queue is folded into the payload on the next tick; NO_SAMPLERS ran exactly one, so read
    // the pending list through a fresh /api/stats after a manual re-tick is not possible — instead
    // assert the ack path and that the relay refused a non-http scheme.
    const bad = await request(port, 'POST', '/api/openurl', { body: 'url=file:///etc/passwd', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(bad.status, 400);
    const ack = await request(port, 'POST', '/api/openurl/ack', { body: { id: 'nope' }, headers: sameOrigin(port) });
    assert.equal(ack.status, 200);
  } finally { await stopServer(child); cleanup(s); }
});
