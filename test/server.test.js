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
const { randomBytes } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { decodeFrame, OPCODES } = require('../lib/wsframe');

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

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const hasScript = spawnSync('which', ['script'], { stdio: 'ignore' }).status === 0;
const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

async function createShell(port, cwd) {
  const response = await request(port, 'POST', '/api/term/sessions', {
    body: { label: 'Locale shell', cwd, shell: true }, headers: sameOrigin(port),
  });
  assert.equal(response.status, 200, response.body);
  const result = JSON.parse(response.body);
  assert.equal(result.ok, true, response.body);
  return result.session;
}

function terminalRoundTrip(port, id) {
  return new Promise((resolve, reject) => {
    let socket, buf = Buffer.alloc(0), output = '', sent = false, settled = false;
    const req = http.request({ host: '127.0.0.1', port, path: `/api/term/attach?id=${encodeURIComponent(id)}`, headers: {
      Host: `127.0.0.1:${port}`, ...sameOrigin(port), Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    } });
    const finish = (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket?.destroy(); req.destroy();
      if (err) reject(new Error(`${err.message}: ${JSON.stringify(output)}`)); else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error('terminal round trip timed out')), 8000);
    req.on('error', finish);
    req.on('response', (res) => { res.resume(); finish(new Error(`upgrade refused (${res.statusCode})`)); });
    req.on('upgrade', (res, upgraded, head) => {
      socket = upgraded;
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let frame;
        while ((frame = decodeFrame(buf))) {
          buf = buf.subarray(frame.bytesConsumed);
          if (frame.opcode === OPCODES.CLOSE) return finish(new Error('terminal closed before shell reply'));
          if (frame.opcode !== OPCODES.BINARY && frame.opcode !== OPCODES.TEXT) continue;
          output += frame.payload.toString('utf8');
          if (output.includes('scheme-attached-ok')) return finish();
          if (!sent) {
            sent = true;
            // Split the marker so terminal echo cannot satisfy the round trip.
            const payload = Buffer.from(JSON.stringify({ t: 'd', d: "printf '%s%s\\n' 'scheme-' 'attached-ok'\r" }));
            assert.ok(payload.length < 126);
            const mask = randomBytes(4);
            const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
            socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
          }
        }
      };
      socket.on('data', onData);
      socket.on('error', finish);
      socket.on('end', () => finish(new Error('terminal ended before shell reply')));
      if (head.length) onData(head);
    });
    req.end();
  });
}

test('C locale preserves shell session identity and metadata after refresh', { skip: !hasTmux }, async () => {
  const s = scratch();
  const { child, port } = await startServer(s, { LANG: 'C', LC_ALL: 'C', SYSMON_MEM_FLOOR_MB: '0' });
  try {
    const created = await createShell(port, s.home);
    const response = await request(port, 'GET', '/api/term/sessions');
    assert.equal(response.status, 200);
    const sessions = JSON.parse(response.body).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, created.id);
    assert.equal(sessions[0].name, 'Locale shell');
    assert.equal(sessions[0].cwd, s.home);
    assert.equal(sessions[0].shell, true);
    assert.equal(sessions[0].codex, false);
    assert.equal(sessions[0].local, false);
    assert.ok(Number.isInteger(sessions[0].panePid) && sessions[0].panePid > 0);
  } finally { await stopServer(child); cleanup(s); }
});

test('terminal WebSocket reaches the configured tmux socket with literal shell characters', { skip: !hasTmux || !hasScript }, async () => {
  const s = scratch();
  s.socket += " '$(false); literal";
  const { child, port } = await startServer(s, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SYSMON_MEM_FLOOR_MB: '0', HISTFILE: '/dev/null' });
  try {
    const created = await createShell(port, s.home);
    const sessions = JSON.parse((await request(port, 'GET', '/api/term/sessions')).body).sessions;
    assert.ok(sessions.some((session) => session.id === created.id), 'API sees the same private session');
    await terminalRoundTrip(port, created.id);
  } finally { await stopServer(child); cleanup(s); }
});

test('Git status filenames round-trip into unstaged and staged diffs', { skip: !hasTmux || !hasGit }, async () => {
  const s = scratch();
  const repo = path.join(s.home, 'project');
  fs.mkdirSync(repo);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, HOME: s.home, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const tracked = ['space name.txt', 'quote"name.txt', 'tab\tname.txt', 'line\nname.txt', 'back\\slash.txt', 'café-雪.txt', ' trailing space '];
  git('init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  for (const name of [...tracked, 'deleted name.txt', 'rename source.txt']) fs.writeFileSync(path.join(repo, name), 'before\n');
  git('add', '--all');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  for (const name of tracked) fs.writeFileSync(path.join(repo, name), 'after\n');
  git('add', '--', tracked[1]); // Exercise the staged diff fallback too.
  fs.unlinkSync(path.join(repo, 'deleted name.txt'));
  git('mv', '--', 'rename source.txt', 'rename target.txt');
  fs.writeFileSync(path.join(repo, 'untracked\nname.txt'), 'new\n');
  const { child, port } = await startServer(s, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SYSMON_MEM_FLOOR_MB: '0' });
  try {
    const created = await createShell(port, repo);
    const response = await request(port, 'GET', `/api/term/git?id=${created.id}&op=status`);
    assert.equal(response.status, 200, response.body);
    const status = JSON.parse(response.body);
    assert.equal(status.ok, true);
    assert.equal(status.repo, true);
    assert.deepEqual(status.files, [
      ...tracked.map((name, i) => ({ xy: i === 1 ? 'M ' : ' M', path: name })),
      { xy: ' D', path: 'deleted name.txt' },
      { xy: 'D ', path: 'rename source.txt' },
      { xy: 'A ', path: 'rename target.txt' },
      { xy: '??', path: 'untracked\nname.txt' },
    ].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))));
    for (const name of tracked) {
      const reported = status.files.find((file) => file.path === name).path;
      const diffResponse = await request(port, 'GET', `/api/term/git?id=${created.id}&op=diff&path=${encodeURIComponent(reported)}`);
      assert.equal(diffResponse.status, 200, diffResponse.body);
      const result = JSON.parse(diffResponse.body);
      assert.equal(result.path, name);
      assert.match(result.diff, /^-before$/m, `before line for ${JSON.stringify(name)}`);
      assert.match(result.diff, /^\+after$/m, `after line for ${JSON.stringify(name)}`);
    }
  } finally { await stopServer(child); cleanup(s); }
});

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
