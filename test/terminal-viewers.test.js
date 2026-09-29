'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const platform of ['linux', 'darwin']) test(`resizing a narrow browser leaves a wide browser intact (${platform} discovery)`, { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-viewers-'));
  const socket = 'scheme-viewers-' + process.pid;
  process.env.SYSMON_TMUX_SOCKET = socket;
  process.env.TMUX_TMPDIR = dir;
  const tmux = args => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
  const children = [], attachments = [];
  t.after(() => {
    for (const attachment of attachments) attachment.close?.();
    for (const child of children) child.kill('SIGTERM');
    try { tmux(['kill-server']); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  try { tmux(['new-session', '-d', '-s', 'cdviewers', '-x', '120', '-y', '30']); }
  catch { return t.skip('tmux unavailable'); }
  tmux(['set-option', '-t', 'cdviewers', 'window-size', 'manual']);
  const terminal = require('../lib/terminal');
  if (platform !== 'linux') {
    const readdir = fs.readdirSync;
    fs.readdirSync = (file, ...args) => {
      if (/^\/proc\/\d+\/fdinfo$/.test(String(file))) throw new Error('proc is unavailable on this platform');
      return readdir(file, ...args);
    };
    t.after(() => { fs.readdirSync = readdir; });
  }
  const read = () => Object.fromEntries(tmux(['list-clients', '-t', 'cdviewers', '-F', '#{client_pid}|#{client_width}x#{client_height}'])
    .split('\n').filter(Boolean).map(row => row.split('|')));
  async function until(matches) {
    for (let i = 0; i < 100; i++) { const value = read(); if (matches(value)) return value; await sleep(25); }
    assert.fail('client geometry did not settle');
  }
  function attach() {
    const command = `tmux -L ${socket} attach-session -t cdviewers`;
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', 'sh', '-c', command] : ['-q', '-f', '-c', command, '/dev/null'];
    const child = spawn('script', args, { env: { ...process.env, TERM: 'xterm-256color' } });
    children.push(child); child.stdout.resume(); child.stderr.resume();
    const attachment = terminal.createAttachmentResizer ? terminal.createAttachmentResizer('cdviewers', child, { platform })
      : { resize: (cols, rows) => terminal.resize('cdviewers', cols, rows) };
    attachments.push(attachment);
    return attachment;
  }
  const wide = attach();
  const first = await until(value => Object.keys(value).length === 1);
  const firstPid = Object.keys(first)[0];
  await wide.resize(140, 40);
  await until(value => value[firstPid] === '140x40');
  const narrow = attach();
  const both = await until(value => Object.keys(value).length === 2);
  const secondPid = Object.keys(both).find(pid => pid !== firstPid);
  await narrow.resize(80, 24);
  await until(value => value[secondPid] === '80x24');
  assert.equal(read()[firstPid], '140x40');
  attachments[1].close?.();
  assert.equal((await narrow.resize(90, 30)).ok, false, 'departed viewer cannot resize a replacement');
});
