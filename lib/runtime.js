'use strict';
// Runtime identity — THE single server-side derivation for the four terminal runtimes.
// Storage stays the legacy tmux markers + registry presence-booleans; this module only
// interprets them. Canonical precedence mirrors the client's rtOf (terminal-ui.js:84)
// byte-for-byte: local > codex > shell > claude. Writer-reachable states are exclusive
// (createSession refuses combos), so precedence matters only for hand-edited state — and
// the dangerous verbs (resume / persist / act) refuse conflicts outright instead.

const RUNTIME_KEYS = ['claude', 'local', 'codex', 'shell'];

function runtimeOf(s) {
  if (!s) return 'claude';
  return s.local ? 'local' : s.codex ? 'codex' : s.shell ? 'shell' : 'claude';
}

// ≥2 runtime flags = hand-edited/corrupt identity. Dangerous verbs refuse on it; display
// paths label via runtimeOf; the parse choke point warns.
function runtimeConflict(s) {
  return !!s && ((s.local ? 1 : 0) + (s.codex ? 1 : 0) + (s.shell ? 1 : 0)) > 1;
}

// API-boundary normalization — replaces createSession's inline exclusivity check.
// Error string preserved verbatim (UI copy).
function runtimeFromFlags({ local, codex, shell } = {}) {
  if ((local && codex) || (shell && (local || codex)))
    return { ok: false, error: 'a tab is ONE runtime — claude, codex, local, or a plain terminal' };
  return { ok: true, runtime: runtimeOf({ local, codex, shell }) };
}

// Per-runtime data — ONLY fields with a live consumer:
//   mintsUuidAtCreate → createSession's uuid policy (claude/local pin a session id up
//                       front; codex mints its own post-turn; shell has no conversation).
//   marks(src)        → the runtime-identity fields persisted to the registry and echoed
//                       in the create response. Field ORDER is load-bearing: the registry
//                       file is JSON.stringify'd in insertion order and byte-compared by
//                       the golden tests.
const RUNTIMES = {
  claude: { mintsUuidAtCreate: true, marks: (s) => ({ ...(s && s.autonomous ? { autonomous: true } : {}) }) },
  local: { mintsUuidAtCreate: true, marks: (s) => ({ local: true, ...(s && s.localModel ? { localModel: s.localModel } : {}) }) },
  codex: { mintsUuidAtCreate: false, marks: (s) => ({ codex: true, ...(s && s.codexModel ? { codexModel: s.codexModel } : {}), ...(s && s.codexUuid ? { codexUuid: s.codexUuid } : {}) }) },
  shell: { mintsUuidAtCreate: false, marks: () => ({ shell: true }) },
};

module.exports = { RUNTIME_KEYS, RUNTIMES, runtimeOf, runtimeConflict, runtimeFromFlags };
