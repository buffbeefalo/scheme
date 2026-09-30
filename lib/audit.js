'use strict';

const { homedir } = require('node:os');

// Bounded audit trail for privileged terminal actions: creation, closing and input.
// Keep a bounded who/what/when record without treating it as user authentication.
//
// "actor" is coarse by design: the dashboard has no auth/identity (loopback +
// same-origin only), so the best honest principal is the request's remote address.
// We record that truthfully rather than invent a user.
//
// Path overridable via COMMAND_DECK_AUDIT (used by tests). Logging is best effort:
// append failures are reported without interrupting an action that already ran.
const fs = require('fs');
const path = require('path');
const { redactSensitiveText } = require('./redact');
const { createRegistryLock } = require('./registry-lock');
const MAX_BYTES = 1024 * 1024;
const auditLock = createRegistryLock({ timeoutMs: 100 });

function file() {
  return process.env.COMMAND_DECK_AUDIT
    || path.join(process.env.HOME || homedir(), '.claude', 'command-deck', 'audit.jsonl');
}

function clamp(s, max) {
  const text = String(s == null ? '' : s);
  if (text.length > 2048) return '[omitted: oversized value]';
  return redactSensitiveText(text).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

// PURE: normalize one audit record. `at` is injectable epoch ms for deterministic tests.
function formatEntry(fields = {}, at = Date.now()) {
  return {
    ts: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
    actor: clamp(fields.actor || 'unknown', 64),
    action: clamp(fields.action || 'unknown', 64),
    target: clamp(fields.target, 80),
    detail: fields.action === 'term:respond' ? '[response omitted]' : clamp(fields.detail, 200),
    ok: fields.ok !== false, // default true; only an explicit false is a failure
  };
}

// I/O: append one normalized entry as a JSONL line. opts.file overrides the path,
// opts.at overrides the timestamp. Never throws; returns true on success.
function appendEntry(fields, opts = {}) {
  const f = opts.file || file();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(formatEntry(fields, opts.at)) + '\n';
    const ok = auditLock.withLock(f, owner => {
      let size = 0;
      try { size = fs.statSync(f).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (size + Buffer.byteLength(line) > MAX_BYTES) {
        const history = readTail(f, MAX_BYTES - Buffer.byteLength(line));
        const tmp = `${f}.${owner.token}.tmp`;
        try {
          fs.writeFileSync(tmp, history + line, { flag: 'wx', mode: 0o600 });
          if (!owner.owns()) return false;
          fs.renameSync(tmp, f);
        } finally { try { fs.unlinkSync(tmp); } catch {} }
      } else {
        const fd = fs.openSync(f, 'a', 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, line); }
        finally { fs.closeSync(fd); }
      }
      return true;
    });
    if (!ok) console.warn('[scheme] audit entry could not be saved');
    return ok;
  } catch {
    console.warn('[scheme] audit entry could not be saved');
    return false;
  }
}

function completeTail(bytes, start) {
  const text = bytes.toString('utf8');
  if (!start) return text;
  const boundary = text.indexOf('\n');
  return boundary < 0 ? '' : text.slice(boundary + 1);
}
function readTail(f, maxBytes = MAX_BYTES) {
  const fd = fs.openSync(f, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - maxBytes);
    const bytes = Buffer.alloc(Math.min(size, maxBytes));
    const count = fs.readSync(fd, bytes, 0, bytes.length, start);
    return completeTail(bytes.subarray(0, count), start);
  } finally { fs.closeSync(fd); }
}
function recent(text, limit) {
  const count = Math.max(0, Math.min(1000, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 200));
  const lines = text.split('\n').filter(Boolean), out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
    try {
      const row = JSON.parse(lines[i]);
      out.push(formatEntry(row, row.ts));
    } catch { /* skip torn lines */ }
  }
  return out;
}

// Legacy synchronous callers also read a bounded tail. HTTP uses the async form.
function readRecent(limit = 200, opts = {}) {
  try { return recent(readTail(opts.file || file()), limit); }
  catch { return []; }
}
async function readRecentAsync(limit = 200, opts = {}) {
  let handle;
  try {
    handle = await fs.promises.open(opts.file || file(), 'r');
    const size = (await handle.stat()).size, start = Math.max(0, size - MAX_BYTES);
    const bytes = Buffer.alloc(Math.min(size, MAX_BYTES));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    return recent(completeTail(bytes.subarray(0, bytesRead), start), limit);
  } catch { return []; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

module.exports = { file, formatEntry, appendEntry, readRecent, readRecentAsync };
