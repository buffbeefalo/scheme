'use strict';

const { homedir } = require('node:os');

// Account-level Claude Code + Codex quota reader. It consumes only local artifacts and
// returns a deliberately small, path-free shape for the loopback-only terminal route.
// Pure normalizers/selectors are exported for deterministic fixtures; filesystem I/O is
// bounded, asynchronous, cached, and never invokes a provider CLI or network endpoint.
const fs = require('node:fs');
const path = require('node:path');
const { parseCodexUsageObservation } = require('./codex-telemetry');

const STALE_MS = 15 * 60 * 1000;
const SWR_MS = 15 * 1000;
const MAX_CODEX_FILES = 16;
const MAX_CODEX_TAIL = 1024 * 1024;
const MAX_CLAUDE_RECORD = 64 * 1024;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const percent = (v) => finite(v) && v >= 0 && v <= 100 ? v : null;
function epochMs(v) {
  if (finite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}

function windowState({ reported, usedPercent, resetsAt }, providerState, now) {
  if (!reported || usedPercent == null) return 'not-reported';
  if (resetsAt && resetsAt <= now) return 'reset-passed';
  return providerState === 'fresh' ? 'fresh' : 'stale';
}

function finishWindows(windows, providerState, now) {
  return windows.map((w) => {
    const used = percent(w.usedPercent), resets = epochMs(w.resetsAt);
    const out = { key: String(w.key || '').slice(0, 32), label: String(w.label || '').slice(0, 40),
      state: windowState({ reported: w.reported !== false, usedPercent: used, resetsAt: resets }, providerState, now) };
    if (used != null) out.usedPercent = used;
    if (resets != null) out.resetsAt = resets;
    return out;
  });
}

function unavailableProvider(kind, absence) {
  const defs = kind === 'claude'
    ? [['five_hour', '5h'], ['seven_day', 'weekly'], ['scoped_weekly', 'Fable weekly']]
    : [['primary', 'primary'], ['secondary', 'secondary']];
  return { state: 'unavailable', observedAt: null, expiresAt: null, fallback: false, partial: true,
    absence: String(absence || 'unavailable').slice(0, 120), plan: null,
    limitId: null, poolLabel: null, poolChanged: false, previousLimitId: null,
    windows: defs.map(([key, label]) => ({ key, label, state: 'not-reported' })) };
}

function normalizeClaudeObservation(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !finite(raw.fetchedAtMs)) return null;
  const recognized = ['fiveHourPct', 'sevenDayPct', 'scopedPct'].some((k) => Object.prototype.hasOwnProperty.call(raw, k));
  if (!recognized) return null;
  const observedAt = raw.fetchedAtMs;
  const sourceExpiry = epochMs(raw.expiresAtMs != null ? raw.expiresAtMs : raw.expiresAt);
  const expiresAt = sourceExpiry || observedAt + STALE_MS;
  const state = now <= expiresAt ? 'fresh' : 'stale';
  const windows = [
    { key: 'five_hour', label: '5h', reported: percent(raw.fiveHourPct) != null,
      usedPercent: percent(raw.fiveHourPct), resetsAt: epochMs(raw.fiveHourResetsAtMs) },
    { key: 'seven_day', label: 'weekly', reported: percent(raw.sevenDayPct) != null,
      usedPercent: percent(raw.sevenDayPct), resetsAt: epochMs(raw.sevenDayResetsAtMs) },
    { key: 'scoped_weekly', label: `${String(raw.scopedName || 'Fable').slice(0, 28)} weekly`,
      reported: percent(raw.scopedPct) != null, usedPercent: percent(raw.scopedPct), resetsAt: null },
  ];
  return { state, observedAt, expiresAt, fallback: false,
    partial: windows.some((w) => !w.reported), absence: null, plan: null,
    windows: finishWindows(windows, state, now) };
}

// Mirrors usage-guard's account-global monotonic selection without splicing fields from
// different observations: current-window highest 5h usage wins, then newest timestamp.
function selectClaudeObservation(records, now = Date.now()) {
  const valid = records.filter((r) => r && finite(r.fetchedAtMs));
  const current = valid.filter((r) => percent(r.fiveHourPct) != null
    && epochMs(r.fiveHourResetsAtMs) > now);
  const pool = current.length ? current : valid;
  return pool.sort((a, b) => current.length
    ? percent(b.fiveHourPct) - percent(a.fiveHourPct) || b.fetchedAtMs - a.fetchedAtMs
    : b.fetchedAtMs - a.fetchedAtMs)[0] || null;
}

function selectCodexObservation(rows) {
  return rows.slice().sort((a, b) => b.observedAt - a.observedAt
    || b.fileMtime - a.fileMtime
    || String(a.filePath).localeCompare(String(b.filePath))
    || b.byteOffset - a.byteOffset)[0] || null;
}

// `previousLimitId` is the pool the last rendered observation was measured against.
// Codex can move an account between quota buckets (2026-08-06: 'codex' -> 'codex_bengalfox'
// / 'GPT-5.3-Codex-Spark', with its own resets_at). Across such a switch a percentage is not
// comparable to the previous one — 0% in a new bucket is a change of subject, not a drop in
// usage — so the provider names its pool and flags the discontinuity instead of quietly
// substituting one meter for another.
function normalizeCodexObservation(row, now = Date.now(), { previousLimitId = null } = {}) {
  if (!row || !finite(row.observedAt)) return null;
  const expiresAt = epochMs(row.expiresAt) || row.observedAt + STALE_MS;
  const state = now <= expiresAt ? 'fresh' : 'stale';
  const windows = Array.isArray(row.windows) ? row.windows : [];
  const normalized = finishWindows([
    windows.find((w) => w && w.key === 'primary') || { key: 'primary', label: 'primary', reported: false },
    windows.find((w) => w && w.key === 'secondary') || { key: 'secondary', label: 'secondary', reported: false },
  ], state, now);
  const limitId = typeof row.limitId === 'string' && row.limitId ? row.limitId.slice(0, 64) : null;
  const limitName = typeof row.limitName === 'string' && row.limitName ? row.limitName.slice(0, 64) : null;
  return { state, observedAt: row.observedAt, expiresAt, fallback: false,
    partial: !!row.partial || normalized.some((w) => w.state === 'not-reported'), absence: null,
    plan: row.plan || null,
    limitId,
    // Prefer the human name, fall back to the id, and claim nothing when neither exists.
    poolLabel: limitName || limitId,
    // Only a genuine id-to-different-id transition counts. A first observation
    // (previousLimitId null) or an unidentified pool must not manufacture a switch.
    poolChanged: Boolean(previousLimitId && limitId && previousLimitId !== limitId),
    previousLimitId: previousLimitId || null,
    windows: normalized };
}

function staleFallback(provider, now, absence = 'update failed') {
  if (!provider || provider.state === 'unavailable') return null;
  const copy = JSON.parse(JSON.stringify(provider));
  copy.state = 'stale'; copy.fallback = true; copy.absence = absence;
  copy.windows = copy.windows.map((w) => ({ ...w,
    state: w.state === 'not-reported' ? 'not-reported'
      : (w.resetsAt && w.resetsAt <= now ? 'reset-passed' : 'stale') }));
  return copy;
}

async function readJsonCapped(file) {
  const st = await fs.promises.stat(file);
  if (!st.isFile() || st.size > MAX_CLAUDE_RECORD) throw new Error('invalid cache record');
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

async function loadClaude(home, now) {
  const root = process.env.CLAUDE_USAGE_GUARD_DIR || path.join(home, '.cache', 'claude-usage-guard');
  const files = [path.join(root, 'oauth-cache.json')];
  try {
    const names = await fs.promises.readdir(path.join(root, 'state'));
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) files.push(path.join(root, 'state', name));
  } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  const records = []; let existed = false, malformed = false;
  for (const file of files) {
    try { records.push(await readJsonCapped(file)); existed = true; }
    catch (e) {
      if (e && e.code === 'ENOENT') continue;
      existed = true; malformed = true;
    }
  }
  const chosen = selectClaudeObservation(records, now);
  const provider = normalizeClaudeObservation(chosen, now);
  if (provider) return provider;
  if (existed && malformed) throw new Error('no valid Claude cache observation');
  return unavailableProvider('claude', existed ? 'no recognized cache observation' : 'no local usage cache');
}

async function discoverRollouts(base) {
  const files = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full, depth + 1);
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) return;
      try { const st = await fs.promises.stat(full); files.push({ path: full, mtimeMs: st.mtimeMs, size: st.size }); } catch {}
    }));
  }
  await walk(base, 0);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)).slice(0, MAX_CODEX_FILES);
}

function createAccountUsageReader({ home = process.env.HOME || homedir(), swrMs = SWR_MS,
  codexBase = process.env.CODEX_SESSIONS_DIR || path.join(home, '.codex', 'sessions'), now = () => Date.now() } = {}) {
  let aggregate = null, aggregateAt = 0, inFlight = null;
  const lastGood = { claude: null, codex: null };
  const fileMemo = new Map();

  async function fileObservations(meta) {
    const key = `${meta.path}\0${meta.size}\0${meta.mtimeMs}`;
    if (fileMemo.has(key)) return fileMemo.get(key);
    const fh = await fs.promises.open(meta.path, 'r');
    try {
      const start = Math.max(0, meta.size - MAX_CODEX_TAIL);
      const buf = Buffer.alloc(meta.size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const data = buf.subarray(0, bytesRead); let pos = 0;
      if (start > 0) { const nl = data.indexOf(10); pos = nl < 0 ? data.length : nl + 1; }
      const rows = [];
      while (pos < data.length) {
        const nl = data.indexOf(10, pos), end = nl < 0 ? data.length : nl;
        const raw = data.subarray(pos, end).toString('utf8').trim();
        if (raw) {
          const parsed = parseCodexUsageObservation(raw, start + pos);
          if (parsed) rows.push({ ...parsed, fileMtime: meta.mtimeMs, filePath: meta.path });
        }
        if (nl < 0) break;
        pos = nl + 1;
      }
      if (fileMemo.size >= 64) fileMemo.delete(fileMemo.keys().next().value);
      fileMemo.set(key, rows);
      return rows;
    } finally { await fh.close(); }
  }

  async function loadCodex(at) {
    const candidates = await discoverRollouts(codexBase);
    if (!candidates.length) return unavailableProvider('codex', 'no local rollout candidates');
    const settled = await Promise.allSettled(candidates.map(fileObservations));
    const rows = settled.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    if (!rows.length && settled.every((r) => r.status === 'rejected')) throw new Error('rollout reads failed');
    // Carry the previously-reported pool in so a bucket switch is reported as a
    // discontinuity rather than silently replacing one meter with another.
    const previousLimitId = (lastGood.codex && lastGood.codex.limitId) || null;
    const provider = normalizeCodexObservation(selectCodexObservation(rows), at, { previousLimitId });
    return provider || unavailableProvider('codex', 'bounded discovery found no valid rate-limit observation');
  }

  async function collect() {
    const at = now();
    const settled = await Promise.allSettled([loadClaude(home, at), loadCodex(at)]);
    const providers = {};
    for (const [i, kind] of ['claude', 'codex'].entries()) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        providers[kind] = r.value;
        if (r.value.state !== 'unavailable') lastGood[kind] = r.value;
      } else {
        providers[kind] = staleFallback(lastGood[kind], at) || unavailableProvider(kind, 'local usage read failed');
      }
    }
    return { generatedAt: at, claude: providers.claude, codex: providers.codex };
  }

  function startRefresh() {
    if (!inFlight) inFlight = collect().then((value) => {
      aggregate = value; aggregateAt = now(); return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }
  async function get() {
    const at = now();
    if (aggregate && at - aggregateAt < swrMs) return aggregate;
    if (aggregate) { startRefresh(); return aggregate; }
    return startRefresh();
  }
  return { get, refresh: startRefresh };
}

module.exports = {
  STALE_MS, SWR_MS, MAX_CODEX_FILES, MAX_CODEX_TAIL,
  normalizeClaudeObservation, selectClaudeObservation, selectCodexObservation, normalizeCodexObservation,
  staleFallback, createAccountUsageReader,
};
