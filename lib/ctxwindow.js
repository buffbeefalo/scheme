'use strict';

// Truthful per-model context windows for the terminal rail meter. Hand-verified constants:
// ollama /api/show is NOT a truth source (the harness sets num_ctx per request), and the old
// 500k hardcode overstated fullness ~2× on 1M-window cloud sessions. Unknown model → null →
// the UI shows raw tokens with NO percentage rather than inventing a denominator.
// A prefix matches only at an id boundary (end-of-string or '-'), so date-suffixed ids
// ("claude-haiku-4-5-20251001") resolve while lookalikes ("claude-opus-4-85") never bleed.
const WINDOWS = [
  ['claude-fable-5', 1000000],
  // Verified by observation on this box 2026-08-16: a live claude-opus-5 session held 512,408
  // context tokens, which excludes every published window below 1M. Transcripts never record the
  // "[1m]" suffix, so this is the only string the analyzer can key on.
  ['claude-opus-5', 1000000],
  ['claude-mythos-5', 1000000],
  ['claude-opus-4-8', 1000000],
  ['claude-opus-4-7', 1000000],
  ['claude-opus-4-6', 1000000],
  ['claude-sonnet-5', 1000000],
  ['claude-sonnet-4-6', 1000000],
  ['claude-haiku-4-5', 200000],
  // Local brains: only entries VERIFIED against what claude-local actually runs with belong
  // here (ornith:9b raised to 128k ctx 2026-07-11). The other picker tiers stay null until
  // someone verifies them — no % beats a wrong %.
  ['ornith:9b', 131072],
];

function contextWindowFor(model) {
  const m = String(model || '');
  if (!m) return null;
  for (const [prefix, win] of WINDOWS) {
    if (m === prefix || m.startsWith(prefix + '-')) return win;
  }
  return null;
}

module.exports = { contextWindowFor, WINDOWS };
