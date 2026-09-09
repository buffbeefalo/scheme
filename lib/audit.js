'use strict';

const { homedir } = require('node:os');

// Append-only audit trail for privileged terminal actions: creation, closing and input.
// Keep a bounded who/what/when record without treating it as user authentication.
//
// "actor" is coarse by design: the dashboard has no auth/identity (loopback +
// same-origin only), so the best honest principal is the request's remote address.
// We record that truthfully rather than invent a user.
//
// Path overridable via COMMAND_DECK_AUDIT (used by tests). Every fn fails closed
// (never throws) so auditing can never take the control plane down.
const fs = require('fs');
const path = require('path');

function file() {
  return process.env.COMMAND_DECK_AUDIT
    || path.join(process.env.HOME || homedir(), '.claude', 'command-deck', 'audit.jsonl');
}

function clamp(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

// PURE: normalize one audit record. `at` is injectable epoch ms for deterministic tests.
function formatEntry(fields = {}, at = Date.now()) {
  return {
    ts: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
    actor: clamp(fields.actor || 'unknown', 64),
    action: clamp(fields.action || 'unknown', 64),
    target: clamp(fields.target, 80),
    detail: clamp(fields.detail, 200),
    ok: fields.ok !== false, // default true; only an explicit false is a failure
  };
}

// I/O: append one normalized entry as a JSONL line. opts.file overrides the path,
// opts.at overrides the timestamp. Never throws; returns true on success.
function appendEntry(fields, opts = {}) {
  try {
    const f = opts.file || file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(formatEntry(fields, opts.at)) + '\n');
    return true;
  } catch { return false; }
}

// I/O: read the most-recent `limit` entries, newest first. Missing/corrupt → [];
// corrupt individual lines are skipped, never fatal. Never throws.
function readRecent(limit = 200, opts = {}) {
  try {
    const f = opts.file || file();
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* skip corrupt line */ }
    }
    return out;
  } catch { return []; }
}

module.exports = { file, formatEntry, appendEntry, readRecent };
