'use strict';

// Unit tests for the pure metric parsers. Zero-dep: Node's built-in test runner.
//   node --test test/metrics.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDf, selectDisks, milliCToC, summarizeThermals, tailLines, parseOllamaPs } = require('../lib/metrics');

const KB = 1024;
const GB = 1024 ** 3;

// Real `df -kP` output captured from the GB10 box.
const DF_REAL = `Filesystem     1024-blocks      Used  Available Capacity Mounted on
tmpfs             12760124      3684   12756440       1% /run
efivarfs               256        33        224      13% /sys/firmware/efi/efivars
/dev/nvme0n1p2  3937374564 766939872 2970394772      21% /
tmpfs             63800604         4   63800600       1% /dev/shm
tmpfs                 5120         8       5112       1% /run/lock
/dev/nvme0n1p1      304536      6520     298016       3% /boot/efi
tmpfs             12760120      2552   12757568       1% /run/user/1000`;

test('parseDf parses every data row and skips the header', () => {
  const rows = parseDf(DF_REAL);
  assert.equal(rows.length, 7);
  assert.ok(!rows.some((r) => r.fs === 'Filesystem'));
});

test('parseDf converts 1024-blocks to bytes and reads the capacity column', () => {
  const root = parseDf(DF_REAL).find((r) => r.mount === '/');
  assert.equal(root.fs, '/dev/nvme0n1p2');
  assert.equal(root.total, 3937374564 * KB);
  assert.equal(root.used, 766939872 * KB);
  assert.equal(root.avail, 2970394772 * KB);
  assert.equal(root.usePct, 21);
});

test('parseDf ignores malformed / truncated lines without emitting NaN', () => {
  const rows = parseDf(DF_REAL + '\ngarbage line\n/dev/sdz 123\n');
  assert.equal(rows.length, 7); // the two bad lines are dropped
  assert.ok(rows.every((r) => Number.isFinite(r.total) && Number.isFinite(r.usePct)));
});

test('selectDisks keeps real block devices, drops pseudo filesystems', () => {
  const disks = selectDisks(parseDf(DF_REAL));
  // tmpfs/efivarfs gone; /boot/efi dropped (sub-1GB, not root); only root remains.
  assert.equal(disks.length, 1);
  assert.equal(disks[0].mount, '/');
});

test('selectDisks keeps large secondary disks and drops loop/snap mounts', () => {
  const fixture = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sdb1 1953514584 1000000000 953514584 52% /data
/dev/loop3 56320 56320 0 100% /snap/core
tmpfs 8000000 100 7999900 1% /tmp`;
  const disks = selectDisks(parseDf(fixture));
  assert.equal(disks.length, 1);
  assert.equal(disks[0].mount, '/data');
  assert.equal(disks[0].usePct, 52);
});

test('selectDisks sorts by total size descending', () => {
  const fixture = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/nvme0n1p2 3937374564 766939872 2970394772 21% /
/dev/sdb1 5953514584 1000000000 4953514584 17% /data`;
  const disks = selectDisks(parseDf(fixture));
  assert.deepEqual(disks.map((d) => d.mount), ['/data', '/']);
});

test('milliCToC converts milli-degrees to one-decimal Celsius', () => {
  assert.equal(milliCToC('47200\n'), 47.2);
  assert.equal(milliCToC('45000'), 45);
});

test('milliCToC returns null for empty / non-numeric input', () => {
  assert.equal(milliCToC(''), null);
  assert.equal(milliCToC('N/A'), null);
  assert.equal(milliCToC(undefined), null);
});

test('summarizeThermals returns the hottest zone and a desc-sorted list', () => {
  const s = summarizeThermals([
    { type: 'acpitz', raw: '47200' },
    { type: 'acpitz', raw: '41200' },
    { type: 'x86_pkg_temp', raw: '52000' },
  ]);
  assert.equal(s.max.tempC, 52);
  assert.deepEqual(s.zones.map((z) => z.tempC), [52, 47.2, 41.2]);
  assert.equal(s.count, 3);
});

test('summarizeThermals drops null and implausible readings', () => {
  const s = summarizeThermals([
    { type: 'acpitz', raw: '44000' },
    { type: 'broken', raw: 'N/A' },
    { type: 'disabled', raw: '0' },
    { type: 'bogus', raw: '250000' },
  ]);
  assert.equal(s.count, 1);
  assert.equal(s.max.tempC, 44);
});

test('summarizeThermals gives unique labels to same-typed zones', () => {
  const s = summarizeThermals([
    { type: 'acpitz', raw: '47200' },
    { type: 'acpitz', raw: '41200' },
  ]);
  const labels = new Set(s.zones.map((z) => z.label));
  assert.equal(labels.size, 2);
});

test('summarizeThermals handles no zones', () => {
  const s = summarizeThermals([]);
  assert.equal(s.max, null);
  assert.deepEqual(s.zones, []);
  assert.equal(s.count, 0);
});

test('tailLines returns the last n lines', () => {
  assert.equal(tailLines('a\nb\nc\nd\n', 2), 'c\nd');
});

test('tailLines returns everything when fewer than n lines', () => {
  assert.equal(tailLines('a\nb', 5), 'a\nb');
});

test('tailLines handles empty input and trailing newline', () => {
  assert.equal(tailLines('', 3), '');
  assert.equal(tailLines('only\n', 3), 'only');
});

// Ollama `/api/ps` → attributable model line. This is what explains an 88%-used
// gauge on a UNIFIED-memory box: a resident model is counted in system "used" but
// holds no process RSS, so without this it looks like phantom usage.
const TOTAL = 127601212 * 1024;   // MemTotal (bytes) from /proc/meminfo
const PS_REAL = {
  models: [{
    name: 'llama3.3:70b-instruct-q8_0', model: 'llama3.3:70b-instruct-q8_0',
    size: 119183966720, size_vram: 119183966720,
    expires_at: '2026-05-29T19:42:34.410128411-07:00',
  }],
};

test('parseOllamaPs extracts a resident model with bytes, vram, expiry', () => {
  const m = parseOllamaPs(PS_REAL, TOTAL).models[0];
  assert.equal(m.name, 'llama3.3:70b-instruct-q8_0');
  assert.equal(m.bytes, 119183966720);
  assert.equal(m.vramBytes, 119183966720);
  assert.equal(m.expiresAt, '2026-05-29T19:42:34.410128411-07:00');
});

test('parseOllamaPs computes pct-of-RAM (the attribution that explains the gauge)', () => {
  assert.equal(parseOllamaPs(PS_REAL, TOTAL).models[0].pctOfRam, 91);
  assert.equal(parseOllamaPs(PS_REAL, TOTAL).total, 119183966720);
});

test('parseOllamaPs omits pctOfRam when no total is given, still sums total', () => {
  const r = parseOllamaPs(PS_REAL);
  assert.equal(r.models[0].pctOfRam, undefined);
  assert.equal(r.total, 119183966720);
});

test('parseOllamaPs returns empty for no resident models / Ollama idle', () => {
  assert.deepEqual(parseOllamaPs({ models: [] }, TOTAL), { models: [], total: 0 });
});

test('parseOllamaPs is null/garbage-safe', () => {
  assert.deepEqual(parseOllamaPs(null, TOTAL), { models: [], total: 0 });
  assert.deepEqual(parseOllamaPs({}, TOTAL), { models: [], total: 0 });
  assert.deepEqual(parseOllamaPs({ models: 'nope' }, TOTAL), { models: [], total: 0 });
});

test('parseOllamaPs sorts multiple models by size desc and drops zero-size', () => {
  const r = parseOllamaPs({ models: [
    { name: 'small', size: 1e9 }, { name: 'big', size: 5e10 }, { name: 'ghost', size: 0 },
  ] }, TOTAL);
  assert.deepEqual(r.models.map((m) => m.name), ['big', 'small']);
});

// ---- pickTop: the Top Processes union (CPU hogs + memory giants) -----------
const { pickTop } = require('../lib/metrics');
const P = (pid, cpu, mem) => ({ pid, cpu, mem, name: `p${pid}` });

test('pickTop: a huge-RSS idle process survives 18+ busier 0-MB processes', () => {
  // 20 kernel-thread-like rows: tiny CPU, zero RSS…
  const noise = Array.from({ length: 20 }, (_, i) => P(i + 1, 0.025, 0));
  // …and the llama-server shape: 0 CPU, 6.5 GiB resident.
  const llama = P(999, 0, 6.5 * 2 ** 30);
  const out = pickTop([...noise, llama]);
  assert.equal(out.length, 18);
  assert.ok(out.some((r) => r.pid === 999), 'memory giant must be present');
});
test('pickTop: dedupes rows that qualify by both CPU and memory', () => {
  const both = P(1, 50, 8e9);
  const rest = Array.from({ length: 5 }, (_, i) => P(i + 2, 1, 1e6));
  const out = pickTop([both, ...rest]);
  assert.equal(out.filter((r) => r.pid === 1).length, 1);
  assert.equal(out.length, 6);
});
test('pickTop: display order stays CPU-first, memory as tiebreak', () => {
  const rows = [P(1, 5, 0), P(2, 10, 0), P(3, 5, 9e9), P(4, 0, 5e9)];
  const out = pickTop(rows);
  assert.deepEqual(out.map((r) => r.pid), [2, 3, 1, 4]);
});
test('pickTop: respects a custom limit and never exceeds it', () => {
  const rows = Array.from({ length: 30 }, (_, i) => P(i + 1, 30 - i, i * 1e6));
  assert.equal(pickTop(rows, { limit: 10 }).length, 10);
});

// ---- per-session process-subtree attribution (terminal rail v2) -------------
// byPid mirrors the tick's /proc scan: Map(pid → {ppid, cpu, mem|memBytes}).
const { buildChildrenIndex, subtreeStats } = require('../lib/metrics');

test('buildChildrenIndex groups pids under their ppid', () => {
  const byPid = new Map([
    [100, { ppid: 1, cpu: 1, mem: 10 }],
    [101, { ppid: 100, cpu: 2, mem: 20 }],
    [102, { ppid: 100, cpu: 3, mem: 30 }],
  ]);
  const idx = buildChildrenIndex(byPid);
  assert.deepEqual([...idx.get(100)].sort((a, b) => a - b), [101, 102]);
  assert.deepEqual(idx.get(1), [100]);
});

test('subtreeStats aggregates cpu/mem/procs over the pane subtree only', () => {
  const byPid = new Map([
    [100, { ppid: 1, cpu: 0.5, mem: 10 }],      // pane shell
    [101, { ppid: 100, cpu: 2, mem: 200 }],     // claude
    [102, { ppid: 101, cpu: 1.5, mem: 90 }],    // its child
    [999, { ppid: 1, cpu: 50, mem: 5000 }],     // unrelated heavyweight
  ]);
  const s = subtreeStats(byPid, buildChildrenIndex(byPid), 100);
  assert.equal(s.procs, 3);
  assert.ok(Math.abs(s.cpu - 4) < 1e-9);
  assert.equal(s.mem, 300);
});

test('subtreeStats accepts the scan\'s memBytes field name too', () => {
  const byPid = new Map([
    [100, { ppid: 1, cpu: 1, memBytes: 128 }],
    [101, { ppid: 100, cpu: 1, memBytes: 64 }],
  ]);
  const s = subtreeStats(byPid, buildChildrenIndex(byPid), 100);
  assert.equal(s.mem, 192);
});

test('subtreeStats: unknown root → null (the rail row hides; nothing is invented)', () => {
  const byPid = new Map([[100, { ppid: 1, cpu: 1, mem: 1 }]]);
  assert.equal(subtreeStats(byPid, buildChildrenIndex(byPid), 4242), null);
});

test('subtreeStats survives a corrupt ppid cycle and honours the node cap', () => {
  const cyc = new Map([
    [200, { ppid: 201, cpu: 1, mem: 1 }],
    [201, { ppid: 200, cpu: 1, mem: 1 }],
  ]);
  const s = subtreeStats(cyc, buildChildrenIndex(cyc), 200);   // must terminate
  assert.equal(s.procs, 2);
  const wide = new Map();
  for (let i = 0; i < 50; i++) wide.set(1000 + i, { ppid: i === 0 ? 1 : 1000, cpu: 1, mem: 1 });
  const capped = subtreeStats(wide, buildChildrenIndex(wide), 1000, { cap: 10 });
  assert.equal(capped.procs, 10);
  assert.equal(capped.cpu, 10);
});
