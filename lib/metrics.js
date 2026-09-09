'use strict';

// Pure parsers for the metric samplers. No I/O, no side effects — kept separate
// from server.js so they can be unit-tested directly (test/metrics.test.js).

const KB = 1024;
const GB = 1024 ** 3;

// ---- disk (`df -kP`) -------------------------------------------------------
// df -kP columns: Filesystem  1024-blocks  Used  Available  Capacity  Mounted on
function parseDf(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('Filesystem')) continue;
    const f = line.split(/\s+/);
    if (f.length < 6) continue;                       // truncated/garbled row
    const blocks = Number(f[1]), used = Number(f[2]), avail = Number(f[3]);
    if (![blocks, used, avail].every(Number.isFinite)) continue;
    let usePct = parseInt(f[4], 10);                  // "21%" -> 21
    if (!Number.isFinite(usePct)) {
      const denom = used + avail;
      usePct = denom > 0 ? Math.round((used / denom) * 100) : 0;
    }
    out.push({
      fs: f[0], mount: f.slice(5).join(' '), usePct,
      total: blocks * KB, used: used * KB, avail: avail * KB,
    });
  }
  return out;
}

// Keep real block devices the operator cares about; drop tmpfs/overlay/loop and
// tiny non-root mounts (e.g. /boot/efi) so the panel shows signal, not noise.
function selectDisks(records, { minBytes = GB } = {}) {
  return records
    .filter((r) => r.fs.startsWith('/dev/') && !/^\/dev\/loop/.test(r.fs)
      && (r.mount === '/' || r.total >= minBytes))
    .sort((a, b) => b.total - a.total);
}

// ---- thermals (/sys/class/thermal) -----------------------------------------
const ZONE_LABELS = { acpitz: 'ACPI', x86_pkg_temp: 'CPU package' };
function prettyZone(type) {
  if (ZONE_LABELS[type]) return ZONE_LABELS[type];
  const cleaned = String(type || '').replace(/[-_]/g, ' ')
    .replace(/\b(thermal|therm|temp|zone)\b/gi, '').trim();
  return cleaned || String(type || 'zone');
}

// "47200\n" (milli-°C) -> 47.2 ; non-numeric/empty -> null
function milliCToC(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) return null;
  return Math.round(Number(s) / 100) / 10;
}

// zones: [{ type, raw }] -> { max, zones (desc), count }
function summarizeThermals(zones) {
  const parsed = (zones || [])
    .map((z, i) => ({ label: `${prettyZone(z.type)} ${i}`, tempC: milliCToC(z.raw) }))
    .filter((z) => z.tempC != null && z.tempC > 0 && z.tempC <= 130)   // drop disabled/bogus sensors
    .sort((a, b) => b.tempC - a.tempC);
  return { max: parsed[0] || null, zones: parsed, count: parsed.length };
}

// ---- Ollama resident models (`/api/ps`) ------------------------------------
// On the GB10 the model loads into UNIFIED memory, so it counts as system "used"
// but holds ~no process RSS — invisible to a top/RSS view. This turns the raw
// /api/ps payload into an attributable line (size + %-of-RAM + keep_alive expiry)
// so a near-full memory gauge is explainable at a glance, not phantom usage.
function parseOllamaPs(psJson, totalBytes = 0) {
  const list = psJson && Array.isArray(psJson.models) ? psJson.models : [];
  const models = list
    .map((m) => ({
      name: String((m && (m.name || m.model)) || 'model'),
      bytes: Number(m && m.size) || 0,
      vramBytes: Number(m && m.size_vram) || 0,
      expiresAt: (m && m.expires_at) || null,
    }))
    .filter((m) => m.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  if (totalBytes > 0) for (const m of models) m.pctOfRam = Math.round((m.bytes / totalBytes) * 100);
  return { models, total: models.reduce((s, m) => s + m.bytes, 0) };
}

// ---- top processes ----------------------------------------------------------
// Pure: choose which processes the Top table shows. A plain CPU-first sort let 0-MB kernel
// threads with a single 10ms tick displace the box's #1 RSS process (llama-server, 6.5 GiB) —
// on an OOM-prone unified-memory box the memory giants must ALWAYS be visible. Union of the
// top CPU consumers and the top RSS holders, deduped, displayed CPU-first.
function pickTop(rows, { limit = 18, memSlots = 6 } = {}) {
  const all = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const byCpu = [...all].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  const byMem = [...all].sort((a, b) => b.mem - a.mem || b.cpu - a.cpu);
  const picked = new Map();
  for (const r of byCpu.slice(0, Math.max(0, limit - memSlots))) picked.set(r.pid, r);
  for (const r of byMem.slice(0, memSlots)) picked.set(r.pid, r);
  for (const r of byCpu) { if (picked.size >= limit) break; picked.set(r.pid, r); }
  return [...picked.values()].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, limit);
}

// ---- per-session process-subtree attribution (terminal rail v2) -------------
// byPid: Map(pid → {ppid, cpu, mem|memBytes}) straight from the tick's /proc scan — the scan
// stores memBytes; test fixtures use mem; both are honoured. Pure and cycle-safe: /proc reads
// race process churn, so a corrupt/raced ppid must terminate, never hang the endpoint.
function buildChildrenIndex(byPid) {
  const idx = new Map();
  for (const [pid, v] of byPid) {
    const pp = v && v.ppid;
    if (!Number.isInteger(pp)) continue;
    const arr = idx.get(pp);
    if (arr) arr.push(pid); else idx.set(pp, [pid]);
  }
  return idx;
}

// BFS from a session's pane pid over the children index → {cpu, mem, procs}, or null when the
// root isn't in the scan (dead pane / stale stash) so the rail row hides instead of lying.
function subtreeStats(byPid, children, rootPid, { cap = 2048 } = {}) {
  if (!byPid || !byPid.has(rootPid)) return null;
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  let cpu = 0, mem = 0, procs = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const v = byPid.get(queue[qi]);
    if (v) { cpu += v.cpu || 0; mem += (v.mem != null ? v.mem : v.memBytes) || 0; procs++; }
    if (procs >= cap) break;
    for (const kid of (children && children.get(queue[qi])) || []) {
      if (!seen.has(kid)) { seen.add(kid); queue.push(kid); }
    }
  }
  return { cpu, mem, procs };
}

// ---- log tail --------------------------------------------------------------
function tailLines(text, n) {
  if (!text) return '';
  const lines = String(text).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();   // ignore trailing newline
  return lines.slice(-n).join('\n');
}

module.exports = { parseDf, selectDisks, prettyZone, milliCToC, summarizeThermals, parseOllamaPs, pickTop, tailLines, buildChildrenIndex, subtreeStats };
