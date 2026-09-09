// Command Deck tailscale-probe retry schedule — see test/tsretry.test.js.
//
// WHY: after the 2026-09-01 12:29 reboot the tailnet name (https://spark.…ts.net) answered
// 403 "untrusted dashboard host" for ~5 minutes. server.js refreshTailscale() probes once at
// boot, before tailscaled has its identity; that miss stamped the probe time and a flat
// 5-minute backoff then held every retry, although slowTick runs every 5s and the probe costs
// ~15ms. A resolved identity is cached for the process lifetime and never re-probed, so the
// backoff only ever governs the UNRESOLVED window — its sole practical effect was lengthening
// a boot race. Schedule now: retry every 10s for the first 10 minutes of process life (the
// boot window), then fall back to 5 minutes so a box with no tailscale at all does not spawn
// two CLI children every tick forever.
'use strict';

const FAST_MS = 10e3;
const FAST_WINDOW_MS = 10 * 60e3;
const SLOW_MS = 5 * 60e3;

// Pure: given the clock, the last probe time (0 = never) and process start, is a probe due?
function probeDue({ now, lastProbeAt, bootAt }) {
  if (!lastProbeAt) return true;
  const retryMs = now - bootAt < FAST_WINDOW_MS ? FAST_MS : SLOW_MS;
  return now - lastProbeAt >= retryMs;
}

module.exports = { probeDue, FAST_MS, FAST_WINDOW_MS, SLOW_MS };
