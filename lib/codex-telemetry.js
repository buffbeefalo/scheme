'use strict';

const { homedir } = require('node:os');

// Pure analyzer for a Codex rollout JSONL → the telemetry the terminal rail renders.
// Codex's transcript schema is unrelated to Claude Code's, so this is a SEPARATE parser from
// lib/telemetry.js (which owns the Claude path). Line shapes are taken from real
// ~/.codex/sessions rollouts (codex-cli 0.144.4):
//   envelope: {type, payload, timestamp}, type ∈ session_meta | turn_context | response_item | event_msg
//   - turn_context.payload.model              → the live model (session_meta.model is null)
//   - event_msg task_started.model_context_window / token_count.info.model_context_window → the window
//   - event_msg token_count.info.total_token_usage.total_tokens → current context footprint
//   - event_msg task_started / task_complete  → the working-state machine
//   - response_item function_call {name}      → tool activity
// No I/O in analyzeCodexRollout — server.js reads the file and hands text/lines here (unit-testable).
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const SESSIONS_DIR = path.join(process.env.HOME || homedir(), '.codex', 'sessions');

const PARITY_FIELDS = [
  'working', 'needsInput', 'waitingOnBackground', 'lastTurnId', 'tasks', 'todos',
  'skills', 'plugins', 'mcp', 'codex', 'recentFiles', 'readFiles', 'pendingBg',
];

function fieldMeta(source = 'unavailable', completeness = 'unavailable', observedAt = null, coverageSince = null) {
  return { source, completeness, observedAt, coverageSince };
}

function markField(t, key, value, source, completeness = 'complete', observedAt = null, coverageSince = null) {
  t[key] = value;
  t.telemetryMeta.fields[key] = fieldMeta(source, completeness, observedAt, coverageSince);
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function boundedString(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// One completely-framed token_count record -> one account-level quota observation. This
// stays pure so the bounded account-usage reader can reuse the exact rate-limit semantics
// without inheriting any transcript paths or per-session telemetry. `byteOffset` is only a
// deterministic tie-break inside the reader; it is never returned by the HTTP route.
function parseCodexUsageObservation(raw, byteOffset = 0) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return null; } }
  const p = o && o.type === 'event_msg' && o.payload;
  const rl = p && p.type === 'token_count' && p.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const recognized = ['plan_type', 'rate_limit_reached_type', 'primary', 'secondary', 'credits']
    .some((k) => Object.prototype.hasOwnProperty.call(rl, k));
  const observedAt = Date.parse(o.timestamp || '');
  if (!recognized || !Number.isFinite(observedAt)) return null;

  const window = (key, fallbackLabel) => {
    const w = rl[key];
    if (!w || typeof w !== 'object') return { key, label: fallbackLabel, reported: false };
    const minutes = Number.isFinite(w.window_minutes) ? w.window_minutes : null;
    const label = minutes === 300 ? '5h' : minutes === 10080 ? 'weekly'
      : minutes != null ? (minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`) : fallbackLabel;
    const out = { key, label, reported: true };
    if (Number.isFinite(w.used_percent)) out.usedPercent = w.used_percent;
    if (Number.isFinite(w.resets_at)) out.resetsAt = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;
    return out;
  };
  return {
    observedAt,
    byteOffset: Number.isFinite(byteOffset) ? byteOffset : 0,
    plan: typeof rl.plan_type === 'string' ? rl.plan_type.slice(0, 40) : null,
    // Quota-POOL identity. Codex can serve this account's usage from different buckets
    // (observed 2026-08-06: limit_id flipped 'codex' -> 'codex_bengalfox' /
    // limit_name 'GPT-5.3-Codex-Spark', with a different resets_at, i.e. a genuinely
    // different window — not the same one rolling over). Dropping these made the meter
    // silently swap to an unused 0%-consumed pool and present it as the account's usage.
    // A percentage is only meaningful next to the bucket it was measured against, so the
    // identity travels with the observation. Null when absent — never inferred.
    limitId: typeof rl.limit_id === 'string' ? rl.limit_id.slice(0, 64) : null,
    limitName: typeof rl.limit_name === 'string' ? rl.limit_name.slice(0, 64) : null,
    partial: !rl.primary || !rl.secondary,
    windows: [window('primary', 'primary'), window('secondary', 'secondary')],
  };
}

function analyzeCodexRollout(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split('\n');
  const t = {
    model: null, modelShort: null,
    tokens: { input: 0, output: 0, cacheRead: 0, context: 0, totalSpent: 0 },
    contextWindow: null,                 // truthful window straight from the transcript (null if unknown)
    approvalPolicy: null, sandbox: null,
    working: null, turns: 0, lastTurnId: null,
    lastTool: null, lastToolAt: null, tools: {}, recentFiles: null, readFiles: null,
    tasks: null, todos: null, tasksPartial: true,
    skills: null, plugins: null, mcp: null, codex: null,
    needsInput: null, needsInputKind: null, pendingAsk: null,
    pendingBg: null, waitingOnBackground: null,
    codexRate: null,                     // {plan, reached, windows:[{usedPercent,windowMinutes,resetsAt}], credits} — Codex-only bonus row
    lastActivity: null,
    stateSince: null,                    // when the CURRENT lifecycle state began (null when unprovable)
    telemetryMeta: { fields: {}, warnings: [] },
  };
  for (const key of PARITY_FIELDS) t.telemetryMeta.fields[key] = fieldMeta();

  const seenCalls = new Set();
  const seenItems = new Set();
  const fileHits = [], readHits = [];
  const mcpCounts = new Map(), pluginCounts = new Map();
  const skillCatalog = new Map(), activeSkills = new Set();
  let firstTimestamp = null;
  // Current-state duration — same rule as lib/telemetry.js: only a transition WITNESSED inside the
  // read window may be dated. A rollout can prove the working edge and nothing else, so the first
  // observed value seeds the tracker without dating it, and the merge drops this timestamp whenever
  // the hook journal reports a state the rollout never saw.
  let stateSince = null, curWorking;
  const noteWorking = (value, ts) => {
    if (value === curWorking) return;
    stateSince = curWorking === undefined || typeof ts !== 'string' || !Number.isFinite(Date.parse(ts)) ? null : ts;
    curWorking = value;
  };

  const noteStructuredRead = (name, args, at) => {
    if (!['read_file', 'Read', 'NotebookRead', 'view_image', 'read_mcp_resource'].includes(name)) return;
    const file = args && (args.file_path || args.notebook_path || args.path);
    if (typeof file !== 'string' || !path.isAbsolute(file)) return;
    readHits.push(file);
    for (const [skillPath, skillName] of skillCatalog) {
      if (path.resolve(file) === skillPath) activeSkills.add(skillName);
    }
    markField(t, 'readFiles', [], 'rollout', 'partial', at, firstTimestamp);
  };

  const notePlan = (args, callId, at) => {
    if (!args || !Array.isArray(args.plan)) return;
    const base = boundedString(callId, 128) || `plan-${at || 'unknown'}`;
    const tasks = args.plan.slice(0, 100).map((step, index) => ({
      id: `${base}:${index}`,
      subject: boundedString(step && (step.step || step.subject), 500),
      status: boundedString(step && step.status, 40) || 'pending',
    })).filter((step) => step.subject);
    markField(t, 'tasks', tasks, 'rollout', 'complete', at, firstTimestamp);
    t.tasksPartial = false;
  };

  const absoluteFile = (file, cwd) => {
    if (typeof file !== 'string' || !file) return null;
    try {
      if (file.startsWith('file:')) return fileURLToPath(file);
      if (path.isAbsolute(file)) return file;
      const base = typeof cwd === 'string' && cwd.startsWith('file:') ? fileURLToPath(cwd) : cwd;
      return base && path.isAbsolute(base) ? path.resolve(base, file) : null;
    } catch { return null; }
  };
  const noteMcp = (server, tool, plugin, at) => {
    if (typeof server === 'string' && typeof tool === 'string') {
      const key = `${server}\0${tool}`;
      const row = mcpCounts.get(key) || { server: boundedString(server, 200), tool: boundedString(tool, 200), count: 0 };
      row.count++; mcpCounts.set(key, row);
      markField(t, 'mcp', [], 'rollout', 'partial', at, firstTimestamp);
    }
    if (typeof plugin === 'string' && plugin) {
      pluginCounts.set(plugin, (pluginCounts.get(plugin) || 0) + 1);
      markField(t, 'plugins', [], 'rollout', 'partial', at, firstTimestamp);
    }
  };
  // Code-mode's nested tools arrive as typed items, separately from the outer exec call.
  // Consume completed records once; never infer execution by parsing JavaScript tool input.
  const noteItem = (item, at) => {
    if (!item || typeof item !== 'object' || (item.id && seenItems.has(item.id))) return;
    if (item.id) seenItems.add(item.id);
    let tool = null;
    if (item.type === 'CommandExecution') {
      tool = 'exec_command';
      if (item.exit_code === 0 && Array.isArray(item.parsed_cmd)) {
        for (const cmd of item.parsed_cmd) {
          if (cmd.type !== 'read') continue;
          const file = absoluteFile(cmd.path, item.cwd);
          if (file) noteStructuredRead('read_file', { path: file }, at);
        }
      }
    } else if (item.type === 'FileChange') {
      tool = 'apply_patch';
      if (item.status === 'completed' && item.changes && typeof item.changes === 'object' && !Array.isArray(item.changes)) {
        for (const [name, change] of Object.entries(item.changes)) {
          const file = absoluteFile(change && change.move_path || name, item.cwd);
          if (file) fileHits.push(file);
        }
        markField(t, 'recentFiles', [], 'rollout', 'partial', at, firstTimestamp);
      }
    } else if (item.type === 'McpToolCall') {
      tool = `mcp__${item.server}__${item.tool}`;
      noteMcp(item.server, item.tool, item.pluginId, at);
    } else if (item.type === 'ImageView') {
      tool = 'view_image';
      const file = absoluteFile(item.path);
      if (file) noteStructuredRead('view_image', { path: file }, at);
    } else if (item.type === 'Extension' && typeof item.kind === 'string') {
      tool = boundedString(item.kind, 200);
    }
    if (tool) { t.tools[tool] = (t.tools[tool] || 0) + 1; t.lastTool = tool; t.lastToolAt = at; }
  };

  for (const raw of lines) {
    let o = raw;
    if (typeof raw === 'string') { const s = raw.trim(); if (!s) continue; try { o = JSON.parse(s); } catch { continue; } }
    if (!o || typeof o !== 'object') continue;
    const p = o.payload;
    if (o.timestamp) {
      t.lastActivity = o.timestamp;
      if (!firstTimestamp) firstTimestamp = o.timestamp;
    }
    if (!p || typeof p !== 'object') continue;

    if (o.type === 'world_state') {
      const state = p.state;
      if (state && Array.isArray(state.skills)) {
        for (const skill of state.skills) {
          if (!skill || typeof skill.path !== 'string' || !path.isAbsolute(skill.path)) continue;
          skillCatalog.set(path.resolve(skill.path), boundedString(skill.name, 200) || path.basename(path.dirname(skill.path)));
        }
      }
      continue;
    }

    if (o.type === 'turn_context') {
      // Latest turn_context wins → reflects a mid-session model switch.
      if (p.model) { t.model = p.model; t.modelShort = p.model; }   // codex tags are already short (gpt-5.5)
      if (p.approval_policy) t.approvalPolicy = p.approval_policy;
      if (p.sandbox_policy) t.sandbox = p.sandbox_policy;
      continue;
    }

    if (o.type === 'event_msg') {
      switch (p.type) {
        case 'item_completed':
          noteItem(p.item, o.timestamp || null);
          break;
        case 'task_started':
          markField(t, 'working', true, 'rollout', 'complete', o.timestamp || null, firstTimestamp);
          noteWorking(true, o.timestamp);
          if (Number.isFinite(p.model_context_window)) t.contextWindow = p.model_context_window;
          break;
        case 'task_complete':
          markField(t, 'working', false, 'rollout', 'complete', o.timestamp || null, firstTimestamp);
          noteWorking(false, o.timestamp);
          t.turns++;
          if (typeof p.turn_id === 'string' && p.turn_id) {
            markField(t, 'lastTurnId', p.turn_id, 'rollout', 'complete', o.timestamp || null, firstTimestamp);
          }
          break;
        case 'turn_aborted':
          markField(t, 'working', false, 'rollout', 'complete', o.timestamp || null, firstTimestamp);
          noteWorking(false, o.timestamp);
          break;
        case 'patch_apply_end':
          if (p.success === true && p.changes && typeof p.changes === 'object' && !Array.isArray(p.changes)) {
            for (const file of Object.keys(p.changes)) if (path.isAbsolute(file)) fileHits.push(file);
            markField(t, 'recentFiles', [], 'rollout', 'partial', o.timestamp || null, firstTimestamp);
          }
          break;
        case 'mcp_tool_call_end': {
          const inv = p.invocation;
          noteMcp(inv && inv.server, inv && inv.tool, p.plugin_id, o.timestamp || null);
          break;
        }
        case 'token_count': {
          const info = p.info;   // null until usage lands — must not crash or clobber the window
          // Context occupancy = the CURRENT turn (last_token_usage), NOT cumulative total_token_usage
          // (which climbs past the window across a session → a >100% meter). Verified on real
          // multi-turn rollouts: total 28973→829897 while last stays ~112k of a 258400 window.
          const lu = info && info.last_token_usage;
          if (lu && Number.isFinite(lu.input_tokens)) {
            const cached = Number.isFinite(lu.cached_input_tokens) ? lu.cached_input_tokens : 0;
            t.tokens.context = lu.input_tokens;                       // live window occupancy (incl. cached + prior outputs)
            t.tokens.cacheRead = cached;
            t.tokens.input = Math.max(0, lu.input_tokens - cached);   // non-cached input (Claude-consistent split)
            t.tokens.output = Number.isFinite(lu.output_tokens) ? lu.output_tokens : 0;
          }
          // Cumulative spend across the whole session — informational, never the meter numerator.
          if (info && info.total_token_usage && Number.isFinite(info.total_token_usage.total_tokens)) t.tokens.totalSpent = info.total_token_usage.total_tokens;
          if (info && Number.isFinite(info.model_context_window)) t.contextWindow = info.model_context_window;
          // rate_limits is parallel to info (real rollouts carry info:null + a valid weekly limit),
          // so it must stay outside the info guard. A token_count without it is not an invalidation:
          // retain the last usable snapshot until Codex supplies a newer one.
          const rl = p.rate_limits;
          if (rl && typeof rl === 'object') {
            const windows = [rl.primary, rl.secondary].filter((w) => w && Number.isFinite(w.used_percent))
              .map((w) => ({ usedPercent: w.used_percent, windowMinutes: Number.isFinite(w.window_minutes) ? w.window_minutes : null, resetsAt: Number.isFinite(w.resets_at) ? w.resets_at : null }));
            const plan = rl.plan_type || null, reached = rl.rate_limit_reached_type || null;
            const c = rl.credits;
            let credits = null;
            if (c && typeof c === 'object') {
              let balance = null;
              if (Number.isFinite(c.balance)) balance = c.balance;
              else if (typeof c.balance === 'string' && /^-?\d+(\.\d+)?$/.test(c.balance.trim())) {
                const parsed = Number(c.balance.trim());
                if (Number.isFinite(parsed)) balance = parsed;
              }
              credits = { balance, hasCredits: c.has_credits === true, unlimited: c.unlimited === true };
            }
            if (windows.length || plan != null || reached != null || credits != null) t.codexRate = { plan, reached, windows, credits };
          }
          break;
        }
        default: break;
      }
      continue;
    }

    if (o.type === 'response_item') {
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.name) {
        const id = typeof p.call_id === 'string' && p.call_id ? p.call_id : null;
        const fresh = !id || !seenCalls.has(id);
        if (id) seenCalls.add(id);
        if (fresh) t.tools[p.name] = (t.tools[p.name] || 0) + 1;
        t.lastTool = p.name; t.lastToolAt = o.timestamp || t.lastActivity || null;
        if (p.type === 'function_call') {
          const args = parseObject(p.arguments);
          if (p.name === 'update_plan') notePlan(args, id, o.timestamp || null);
          noteStructuredRead(p.name, args, o.timestamp || null);
          if (p.name === 'spawn_agent' && args && typeof args.task_name === 'string') {
            const agents = Array.isArray(t.codex) ? t.codex.slice() : [];
            agents.push({ agent: boundedString(args.task_name, 200), description: boundedString(args.message, 500), mode: 'background' });
            markField(t, 'codex', agents, 'rollout', 'partial', o.timestamp || null, firstTimestamp);
          }
        }
      }
      continue;
    }
    // session_meta: model is null there; cwd/id are used by the path resolver, not the rail.
  }
  if (t.recentFiles !== null) {
    const seen = new Set(), recent = [];
    for (let i = fileHits.length - 1; i >= 0 && recent.length < 10; i--) {
      if (!seen.has(fileHits[i])) { seen.add(fileHits[i]); recent.push(fileHits[i]); }
    }
    t.recentFiles = recent;
  }
  if (t.readFiles !== null) {
    const edited = new Set(t.recentFiles || []), seen = new Set(), reads = [];
    for (let i = readHits.length - 1; i >= 0 && reads.length < 10; i--) {
      if (!edited.has(readHits[i]) && !seen.has(readHits[i])) { seen.add(readHits[i]); reads.push(readHits[i]); }
    }
    t.readFiles = reads;
  }
  if (t.mcp !== null) t.mcp = [...mcpCounts.values()];
  if (t.plugins !== null) t.plugins = [...pluginCounts].map(([name, count]) => ({ name, count }));
  if (activeSkills.size) markField(t, 'skills', [...activeSkills], 'derived', 'partial', t.lastActivity, firstTimestamp);
  t.stateSince = stateSince;
  return t;
}

// Resolve a Codex session's rollout by uuid: <base>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
// Codex mints its own uuid (embedded in the filename), so we glob for it rather than
// deriving a deterministic path. Cache-backed: rollout paths are immutable once minted,
// so a hit is validated with ONE statSync whose result the tick's stat gate reuses
// (spec §3). Typed errors: ENOENT (missing) resolves null / re-walks; anything else
// (EACCES/EIO) THROWS so the lights collector can mark {err:true} instead of inventing
// dark. Deep date-dir readdir errors keep the historical skip-and-continue.
const PATH_CACHE_MAX = 128;
const _pathCache = new Map();

function resolveCodexRollout(uuid, base = SESSIONS_DIR) {
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) return null;
  const key = `${base}\0${uuid}`;
  const cached = _pathCache.get(key);
  if (cached) {
    try { return { path: cached, stat: fs.statSync(cached) }; }
    catch (e) {
      if (e && e.code === 'ENOENT') _pathCache.delete(key);
      else throw e;
    }
  }
  const suffix = `-${uuid}.jsonl`;
  const scanLevel = (entries, dir) => {
    const hit = entries.find((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(suffix));
    if (hit) return path.join(dir, hit.name);
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    for (const d of dirs) { const found = descend(path.join(dir, d)); if (found) return found; }
    return null;
  };
  const descend = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    return scanLevel(entries, dir);
  };
  let rootEntries;
  try { rootEntries = fs.readdirSync(base, { withFileTypes: true }); }
  catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const found = scanLevel(rootEntries, base);
  if (!found) return null;
  if (_pathCache.size >= PATH_CACHE_MAX) _pathCache.delete(_pathCache.keys().next().value);
  _pathCache.set(key, found);
  let stat;
  try { stat = fs.statSync(found); }
  catch (e) { if (e && e.code === 'ENOENT') { _pathCache.delete(key); return null; } throw e; }
  return { path: found, stat };
}

// Compatibility wrapper — string | null, NEVER throws (the telemetry route calls it
// with no local catch; HEAD's catch-all walk meant any error rendered the ordinary
// all-false codex rail, and that contract is preserved verbatim; spec R3-F19).
function codexTranscriptPath(uuid, base = SESSIONS_DIR) {
  try { const r = resolveCodexRollout(uuid, base); return r ? r.path : null; }
  catch { return null; }
}

// Read just the first line of a (possibly large) rollout without slurping the whole file. Codex's
// session_meta is line 1 but can carry a multi-KB base_instructions, so read a generous prefix.
function readFirstLine(file, maxBytes = 262144) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const s = buf.subarray(0, n).toString('utf8');
    const nl = s.indexOf('\n');
    if (nl < 0 && n >= maxBytes) return null;
    return nl >= 0 ? s.slice(0, nl) : s;
  } catch { return null; }
  finally { if (fd != null) { try { fs.closeSync(fd); } catch {} } }
}

const CODEX_UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function localDateFloor(sinceMs) {
  const d = new Date(sinceMs);
  if (!Number.isFinite(d.getTime())) return null;
  const floor = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  floor.setDate(floor.getDate() - 1);
  return floor.getTime();
}

function beforeLocalDateFloor(parts, floorMs) {
  if (floorMs == null || parts.length !== 3) return false;
  const [year, month, day] = parts.map(Number);
  if (![year, month, day].every(Number.isInteger)) return false;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return false;
  return date.getTime() < floorMs;
}

function listCodexSessionCandidates({ cwd, sinceMs = 0, claimed = new Set() } = {}, base = SESSIONS_DIR) {
  if (!cwd) return [];
  const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0;
  const floor = localDateFloor(since);
  const out = [];
  const walk = (dir, parts) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = entries.filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
      .map((e) => e.name).sort().reverse();   // rollout filenames start with an ISO timestamp → newest first
    for (const nm of files) {
      const m = nm.match(CODEX_UUID_RE);
      if (!m || claimed.has(m[1])) continue;
      const full = path.join(dir, nm);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < since) continue;       // cheap coarse prefilter; timestamp below is the proximity truth
      const line = readFirstLine(full);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!(o && o.type === 'session_meta' && o.payload && o.payload.cwd === cwd)) continue;
      const startMs = Date.parse(o.payload.timestamp);
      if (!Number.isFinite(startMs)) continue;
      out.push({ uuid: m[1], startMs });
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();   // YYYY/MM/DD, newest first
    for (const d of dirs) {
      const next = [...parts, d];
      if (beforeLocalDateFloor(next, floor)) continue;
      walk(path.join(dir, d), next);
    }
  };
  walk(base, []);
  return out;
}

// Compatibility wrapper for existing callers: the candidate list carries the stricter metadata,
// while legacy consumers still receive the newest matching uuid or null.
function findCodexSessionUuid(opts = {}, base = SESSIONS_DIR) {
  const candidates = listCodexSessionCandidates(opts, base);
  candidates.sort((a, b) => b.startMs - a.startMs || a.uuid.localeCompare(b.uuid));
  return candidates.length ? candidates[0].uuid : null;
}

module.exports = {
  analyzeCodexRollout, parseCodexUsageObservation, codexTranscriptPath, resolveCodexRollout,
  findCodexSessionUuid, listCodexSessionCandidates, SESSIONS_DIR, PARITY_FIELDS, fieldMeta, markField,
};
