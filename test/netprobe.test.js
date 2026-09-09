const { test } = require('node:test');
const assert = require('node:assert');
const { probeWithRetries } = require('../lib/netprobe.js');

// Fake single-shot probe: pops results off a script. Records call count.
function scripted(results) {
  const s = { calls: 0, probe: null };
  s.probe = async () => { s.calls++; return results[Math.min(s.calls - 1, results.length - 1)]; };
  return s;
}
// Fake sleep: records requested delays, never actually waits.
function fakeSleep() {
  const s = { delays: [], sleep: null };
  s.sleep = async (ms) => { s.delays.push(ms); };
  return s;
}

test('probeWithRetries: first attempt alive returns immediately, no retries, no sleeps', async () => {
  const p = scripted([{ alive: true, ms: 12.3 }]);
  const z = fakeSleep();
  const out = await probeWithRetries(p.probe, { attempts: 3, delayMs: 300, sleep: z.sleep });
  assert.deepStrictEqual(out, { alive: true, ms: 12.3 });
  assert.strictEqual(p.calls, 1);
  assert.deepStrictEqual(z.delays, []);
});

test('probeWithRetries: one dropped packet then success reports alive (the flap fix)', async () => {
  const p = scripted([{ alive: false, ms: null }, { alive: true, ms: 25.1 }]);
  const z = fakeSleep();
  const out = await probeWithRetries(p.probe, { attempts: 3, delayMs: 300, sleep: z.sleep });
  assert.deepStrictEqual(out, { alive: true, ms: 25.1 });
  assert.strictEqual(p.calls, 2);
  assert.deepStrictEqual(z.delays, [300]);
});

test('probeWithRetries: all attempts dead returns the last dead result after exactly `attempts` tries', async () => {
  const p = scripted([{ alive: false, ms: null }]);
  const z = fakeSleep();
  const out = await probeWithRetries(p.probe, { attempts: 3, delayMs: 300, sleep: z.sleep });
  assert.deepStrictEqual(out, { alive: false, ms: null });
  assert.strictEqual(p.calls, 3);
  assert.deepStrictEqual(z.delays, [300, 300]);
});

test('probeWithRetries: defaults are 3 attempts, 300ms apart', async () => {
  const p = scripted([{ alive: false, ms: null }]);
  const z = fakeSleep();
  await probeWithRetries(p.probe, { sleep: z.sleep });
  assert.strictEqual(p.calls, 3);
  assert.deepStrictEqual(z.delays, [300, 300]);
});
