'use strict';

// Git status of a session's cwd for the terminal rail. Pure porcelain-v2 parser + a per-cwd
// stale-while-revalidate cache in the refreshTailscale posture: request handlers only ever
// read the cache — get() returns whatever is known RIGHT NOW (null on first sight) and kicks
// the probe in the background, so a wedged git can never slow the telemetry poll. Non-git,
// error, or timeout → null, CACHED (fails closed; no per-poll retry hammering a bad cwd).
const { execFile } = require('child_process');

// `git status --porcelain=v2 --branch`: '# branch.*' headers, then one record per path —
// '1' modified, '2' renamed/copied, 'u' unmerged, '?' untracked ('!' ignored are not emitted
// without --ignored). dirty = changed + untracked is the rail's headline number.
function parsePorcelainV2(text) {
  const g = { branch: null, detached: false, ahead: null, behind: null, changed: 0, untracked: 0, dirty: 0 };
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') g.detached = true; else g.branch = head;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { g.ahead = Number(m[1]); g.behind = Number(m[2]); }
    } else if (line[0] === '1' || line[0] === '2' || line[0] === 'u') g.changed++;
    else if (line[0] === '?') g.untracked++;
  }
  g.dirty = g.changed + g.untracked;
  return g;
}

const GIT_ARGS = ['status', '--porcelain=v2', '--branch'];

function createGitStatus({ execFileFn = execFile, nowFn = Date.now, ttlMs = 15000, timeoutMs = 2000 } = {}) {
  const cache = new Map();   // cwd → { at, value, inflight }

  function refresh(cwd, e) {
    e.inflight = new Promise((resolve) => {
      execFileFn('git', ['-C', cwd, ...GIT_ARGS], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        e.value = err ? null : parsePorcelainV2(String(stdout || ''));
        e.at = nowFn();
        e.inflight = null;
        resolve();
      });
    });
  }

  // Synchronous cache read + background revalidation. Trailing slash normalized so a stored
  // "/x/" and a live "/x" share one entry (same quirk transcriptPath guards against).
  function get(cwd) {
    const key = String(cwd || '').replace(/\/+$/, '') || '/';
    let e = cache.get(key);
    if (!e) { e = { at: 0, value: null, inflight: null }; cache.set(key, e); refresh(key, e); return null; }
    if (!e.inflight && nowFn() - e.at >= ttlMs) refresh(key, e);
    return e.value;
  }

  // Test/shutdown hook: settle every in-flight probe.
  function flush() { return Promise.all([...cache.values()].map((e) => e.inflight).filter(Boolean)); }

  return { get, flush };
}

module.exports = { parsePorcelainV2, createGitStatus };
