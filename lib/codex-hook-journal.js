'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fieldMeta } = require('./codex-telemetry');

const JOURNAL_MAX_BYTES = 1024 * 1024;
const OVERFLOW_RESERVE_BYTES = 512;
const RECORD_MAX_BYTES = 8192;
const JOURNAL_DIR_MAX_BYTES = 32 * 1024 * 1024;
const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAB_RE = /^cd[a-z0-9]{6,30}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KINDS = new Set([
  'session_start', 'permission_request', 'question_request', 'tool_start', 'tool_end',
  'subagent_start', 'subagent_stop', 'stop', 'plan', 'read', 'plugin', 'mcp',
  'hook_error', 'overflow',
]);

function validIdentity(identity) {
  return !!identity && UUID_RE.test(String(identity.sessionId || ''))
    && TAB_RE.test(String(identity.tabId || ''))
    && UUID_RE.test(String(identity.generationId || ''));
}

function sameIdentity(a, b) {
  return validIdentity(a) && validIdentity(b)
    && a.sessionId === b.sessionId && a.tabId === b.tabId && a.generationId === b.generationId;
}

function journalPath(root, identity) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !validIdentity(identity)) return null;
  return path.join(root, identity.sessionId, `${identity.generationId}.jsonl`);
}

function text(value, max) {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').slice(0, max) : undefined;
}

function cleanPlan(plan) {
  if (!Array.isArray(plan)) return undefined;
  return plan.slice(0, 100).map((item) => ({
    step: text(item && (item.step || item.subject), 500) || '',
    status: text(item && item.status, 40) || 'pending',
  })).filter((item) => item.step);
}

function cleanOptions(options) {
  if (!Array.isArray(options)) return undefined;
  return options.slice(0, 8).map((option) => typeof option === 'string'
    ? text(option, 200)
    : text(option && (option.label || option.value), 200)).filter(Boolean);
}

function sanitizeRecord(raw) {
  if (!raw || raw.v !== 1 || !validIdentity(raw) || !KINDS.has(raw.kind)
    || !Number.isSafeInteger(raw.seq) || raw.seq < 1) return null;
  const at = text(raw.at, 40);
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const out = {
    v: 1, sessionId: raw.sessionId, tabId: raw.tabId, generationId: raw.generationId,
    seq: raw.seq, at, kind: raw.kind,
  };
  for (const [key, max] of Object.entries({
    requestId: 128, toolCallId: 128, toolName: 200, subagentId: 128, agentType: 200,
    status: 40, source: 40, question: 500, filePath: 2048, pluginId: 200,
    mcpServer: 200, mcpTool: 200, warning: 500,
  })) {
    const value = text(raw[key], max);
    if (value !== undefined && (!key.endsWith('Id') || ID_RE.test(value))) out[key] = value;
  }
  const options = cleanOptions(raw.options);
  if (options) out.options = options;
  const plan = cleanPlan(raw.plan);
  if (plan) out.plan = plan;
  if (raw.truncated === true) out.truncated = true;
  return out;
}

function lastSequence(file) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    const lines = data.trimEnd().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    return Number.isSafeInteger(last.seq) && last.seq > 0 ? last.seq : 0;
  } catch { return 0; }
}

function appendOverflowOnce(file, raw, size) {
  const marker = `${file}.overflow`;
  let markerFd;
  try { markerFd = fs.openSync(marker, 'wx', 0o600); }
  catch { return { ok: false, overflow: true }; }
  try {
    const overflow = sanitizeRecord({
      v: 1, sessionId: raw.sessionId, tabId: raw.tabId, generationId: raw.generationId,
      seq: raw.seq, at: raw.at, kind: 'overflow', truncated: true,
    });
    const line = Buffer.from(`${JSON.stringify(overflow)}\n`);
    if (size + line.length <= JOURNAL_MAX_BYTES) fs.appendFileSync(file, line, { flag: 'a', mode: 0o600 });
    return { ok: false, overflow: true };
  } finally {
    try { fs.closeSync(markerFd); } catch {}
  }
}

function appendHookRecord(file, raw) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !raw || !validIdentity(raw)) return { ok: false };
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
  catch { return { ok: false }; }
  const lock = `${file}.lock`;
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch { return { ok: false }; }
  try {
    const seq = Number.isSafeInteger(raw.seq) && raw.seq > 0 ? raw.seq : lastSequence(file) + 1;
    const record = sanitizeRecord({ ...raw, seq });
    if (!record) return { ok: false };
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    if (line.length > RECORD_MAX_BYTES) return { ok: false };
    let size = 0;
    try { size = fs.statSync(file).size; } catch (error) { if (!error || error.code !== 'ENOENT') return { ok: false }; }
    if (size + line.length > JOURNAL_MAX_BYTES - OVERFLOW_RESERVE_BYTES) return appendOverflowOnce(file, record, size);
    fs.appendFileSync(file, line, { flag: 'a', mode: 0o600 });
    return { ok: true };
  } catch { return { ok: false }; }
  finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

function invalidJournal(identity, warning) {
  return { valid: false, identity, records: [], warnings: [warning], coverageSince: null };
}

function readHookJournal(file, identity) {
  if (!validIdentity(identity) || typeof file !== 'string' || !path.isAbsolute(file)) return invalidJournal(identity, 'invalid hook identity');
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) { return invalidJournal(identity, error && error.code === 'ENOENT' ? 'hook journal unavailable' : 'hook journal unreadable'); }
  if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) return invalidJournal(identity, 'hook journal exceeds cap');
  let data;
  try { data = fs.readFileSync(file, { encoding: 'utf8', flag: 'r' }); }
  catch { return invalidJournal(identity, 'hook journal unreadable'); }
  if (!data || !data.endsWith('\n')) return invalidJournal(identity, 'hook journal has torn record');
  const records = [];
  let previous = 0;
  for (const line of data.slice(0, -1).split('\n')) {
    let raw;
    try { raw = JSON.parse(line); } catch { return invalidJournal(identity, 'hook journal has invalid json'); }
    const record = sanitizeRecord(raw);
    if (!record || !sameIdentity(record, identity)) return invalidJournal(identity, 'hook journal identity or schema mismatch');
    if (record.seq <= previous) return invalidJournal(identity, 'hook journal sequence anomaly');
    if (record.kind === 'overflow') return invalidJournal(identity, 'hook journal overflowed');
    previous = record.seq;
    records.push(record);
  }
  if (!records.length) return invalidJournal(identity, 'hook journal empty');
  return { valid: true, identity: { ...identity }, records, warnings: [], coverageSince: records[0].at };
}

function meta(source = 'unavailable', completeness = 'unavailable', observedAt = null, coverageSince = null) {
  return fieldMeta(source, completeness, observedAt, coverageSince);
}

function reconstructHookTelemetry(journal) {
  const fields = {};
  for (const key of ['needsInput', 'pendingBg', 'tasks', 'todos', 'readFiles', 'skills', 'plugins', 'mcp', 'codex']) fields[key] = meta();
  const t = {
    needsInput: null, needsInputKind: null, pendingAsk: null, pendingBg: null,
    tasks: null, todos: null, readFiles: null, skills: null, plugins: null, mcp: null, codex: null,
    telemetryMeta: { fields, warnings: [...((journal && journal.warnings) || [])] },
  };
  if (!journal || journal.valid !== true) return t;
  const requests = new Map(), agents = new Map(), reads = [], skills = new Set();
  let coverage = journal.coverageSince || null, started = false, latestPlan = null, latestPlanRecord = null;
  for (const record of journal.records) {
    if (record.kind === 'session_start') started = true;
    if (record.kind === 'permission_request' || record.kind === 'question_request') {
      const id = record.requestId || record.toolCallId;
      if (id) requests.set(id, record);
    }
    if (record.kind === 'tool_end') {
      for (const [id, request] of requests) {
        if (record.toolCallId && request.toolCallId === record.toolCallId) requests.delete(id);
      }
    }
    if (record.kind === 'stop') requests.clear();
    if (record.kind === 'subagent_start' && record.subagentId) agents.set(record.subagentId, record);
    if (record.kind === 'subagent_stop' && record.subagentId) agents.delete(record.subagentId);
    if (record.kind === 'plan' && Array.isArray(record.plan)) { latestPlan = record.plan; latestPlanRecord = record; }
    if (record.kind === 'read' && record.filePath && path.isAbsolute(record.filePath)) {
      reads.push(record.filePath);
      if (path.basename(record.filePath) === 'SKILL.md') skills.add(path.basename(path.dirname(record.filePath)));
    }
  }
  if (started) {
    const ask = [...requests.values()].at(-1) || null;
    // A surviving event proves a positive. Its absence in an advisory/partial
    // journal cannot prove a negative: another hook may not have been emitted.
    t.needsInput = ask ? true : null;
    t.needsInputKind = ask ? (ask.kind === 'question_request' ? 'question' : 'approval') : null;
    t.pendingAsk = ask ? {
      kind: t.needsInputKind, requestId: ask.requestId || ask.toolCallId,
      question: ask.question || '', options: ask.options || [],
    } : null;
    t.pendingBg = agents.size || null;
    fields.needsInput = meta('hook', 'partial', ask ? ask.at : journal.records.at(-1).at, coverage);
    fields.pendingBg = meta('hook', 'partial', journal.records.at(-1).at, coverage);
    t.codex = agents.size
      ? [...agents].map(([id, agent]) => ({ agent: agent.agentType || id, description: '', mode: 'background' }))
      : null;
    fields.codex = meta('hook', 'partial', journal.records.at(-1).at, coverage);
  }
  if (latestPlan) {
    t.tasks = latestPlan.map((step, index) => ({
      id: `${latestPlanRecord.toolCallId || latestPlanRecord.seq}:${index}`,
      subject: step.step, status: step.status,
    }));
    fields.tasks = meta('hook', 'complete', latestPlanRecord.at, coverage);
  }
  if (reads.length) {
    const seen = new Set();
    t.readFiles = [];
    for (let i = reads.length - 1; i >= 0 && t.readFiles.length < 10; i--) {
      if (!seen.has(reads[i])) { seen.add(reads[i]); t.readFiles.push(reads[i]); }
    }
    fields.readFiles = meta('hook', 'partial', journal.records.at(-1).at, coverage);
  }
  if (skills.size) {
    t.skills = [...skills];
    fields.skills = meta('derived', 'partial', journal.records.at(-1).at, coverage);
  }
  return t;
}

function walkJournalFiles(root) {
  const out = [];
  let sessions;
  try { sessions = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const session of sessions) {
    if (!session.isDirectory() || !UUID_RE.test(session.name)) continue;
    const dir = path.join(root, session.name);
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const generationId = file.name.slice(0, -6);
      if (!UUID_RE.test(generationId)) continue;
      const full = path.join(dir, file.name);
      try { const stat = fs.statSync(full); out.push({ file: full, stat, key: `${session.name}:${generationId}` }); } catch {}
    }
  }
  return out;
}

function pruneHookJournals(root, active = new Set(), now = Date.now()) {
  let files = walkJournalFiles(root);
  const remove = (entry) => { try { fs.unlinkSync(entry.file); return true; } catch { return false; } };
  for (const entry of files) {
    if (!active.has(entry.key) && now - entry.stat.mtimeMs > JOURNAL_RETENTION_MS) remove(entry);
  }
  files = walkJournalFiles(root).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.file.localeCompare(b.file));
  let bytes = files.reduce((sum, entry) => sum + entry.stat.size, 0);
  for (const entry of files) {
    if (bytes <= JOURNAL_DIR_MAX_BYTES) break;
    if (active.has(entry.key)) continue;
    if (remove(entry)) bytes -= entry.stat.size;
  }
  return { bytes, files: walkJournalFiles(root).length };
}

module.exports = {
  JOURNAL_MAX_BYTES, OVERFLOW_RESERVE_BYTES, RECORD_MAX_BYTES, JOURNAL_DIR_MAX_BYTES,
  JOURNAL_RETENTION_MS, validIdentity, sameIdentity, journalPath, sanitizeRecord,
  appendHookRecord, readHookJournal, reconstructHookTelemetry, pruneHookJournals,
};
