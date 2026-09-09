// Command Deck net-probe resilience — see test/netprobe.test.js.
//
// WHY: the Critical-Now strip raises "internet unreachable" (and the header pill flips
// OFFLINE) straight off conn.internet.alive, and faults APPEAR instantly by design
// (vendor/faults.js asymmetric hysteresis). With a single `ping -c 1 -W 1` sample feeding
// it, one dropped WiFi packet under load painted the whole header red (witnessed
// 2026-08-30 00:20 PDT: OFFLINE banner while 40/40 control pings succeeded). A probe only
// reports dead after every attempt in one burst fails; a genuine outage still surfaces in
// the same slow tick, ~(attempts-1)*delayMs later at worst.
'use strict';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// probeOnce: () => Promise<{alive, ...}>. Returns the first alive result, or the last
// dead one after `attempts` tries spaced `delayMs` apart. `sleep` is injectable for tests.
async function probeWithRetries(probeOnce, opts) {
  const { attempts = 3, delayMs = 300, sleep = defaultSleep } = opts || {};
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    last = await probeOnce();
    if (last && last.alive) return last;
  }
  return last;
}

module.exports = { probeWithRetries };
