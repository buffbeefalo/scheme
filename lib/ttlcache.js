'use strict';
// Tiny TTL + single-flight + invalidation-generation async cache. Pure — no I/O, no
// timers; the clock is injected (monotonic performance.now by default, so an NTP wall
// step can't extend or wreck the TTL) and freshness is stamped when a call COMPLETES,
// so a slow call isn't born stale. Built for listSessions() but generic.
//
// Contract (spec §4):
//  - get(): fresh cached value → returned. Else join the in-flight call of the CURRENT
//    generation, or start a new one.
//  - a result is cached only if cacheIf(result) is truthy AND the generation hasn't
//    moved while the call ran; invalidate() during a call means its result is returned
//    to its callers but never cached, and its completion never clears a newer slot.
//  - a get() issued after invalidate() must NOT join a pre-invalidation in-flight call.
//  - a rejected call is never cached; the rejection propagates to that call's joiners.
const { performance } = require('node:perf_hooks');

function createTtlCache(fn, { ttlMs = 1000, now = () => performance.now(), cacheIf = () => true } = {}) {
  let value = null, at = 0, has = false;
  let gen = 0;
  let inflight = null, inflightGen = -1;

  function get() {
    if (has && now() - at < ttlMs) return Promise.resolve(value);
    if (inflight && inflightGen === gen) return inflight;
    const myGen = gen;
    const p = (async () => {
      try {
        const v = await fn();
        if (gen === myGen && cacheIf(v)) { value = v; at = now(); has = true; }
        return v;
      } finally {
        if (inflight === p) inflight = null;
      }
    })();
    inflight = p; inflightGen = myGen;
    return p;
  }

  function invalidate() { gen++; has = false; }

  return { get, invalidate };
}

module.exports = { createTtlCache };
