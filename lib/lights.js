'use strict';
// Per-session lights-state collector — the 2s tick's single transcript walk, extracted
// with injected I/O (house pattern) so the bare suite exercises it without a child
// server. Produces the SSE `termLights` map plus the attention/asks/pendingById trio
// that termAttention and the auto-answer consume — ONE analysis feeds all surfaces.
// Spec: docs/superpowers/specs/2026-07-17-telemetry-fanout-design.md §1.
const { runtimeOf, runtimeConflict } = require('./runtime');

const TAIL_LINES = 4000, TAIL_BYTES = 1024 * 1024;

function tri(value) { return value === true ? true : value === false ? false : null; }
// Strict guards, because the switcher renders these directly: an unread token count must show as
// "—", never as a confident 0, and a timestamp we cannot parse is not a timestamp.
function posNum(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null; }
function nonEmpty(value) { return typeof value === 'string' && value ? value : null; }
function iso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null; }

function summarize(tel = {}, contextWindowFor) {
  // Codex reports its real window in the transcript; Claude's comes from the static model map.
  const win = tel.contextWindow != null ? tel.contextWindow
    : (typeof contextWindowFor === 'function' && tel.model ? contextWindowFor(tel.model) : null);
  return {
    working: tri(tel.working),
    needsInput: tri(tel.needsInput),
    needsInputKind: tel.needsInputKind || null,
    waitingOnBackground: tri(tel.waitingOnBackground),
    lastTurnId: tel.lastTurnId || null,
    // Compact switcher metadata (council a6363f19 §c) — rides this existing stat-gated walk
    // rather than an N-session telemetry fan-out.
    stateSince: iso(tel.stateSince),
    lastActivity: iso(tel.lastActivity),
    contextTokens: posNum(tel.tokens && tel.tokens.context),
    contextWindow: posNum(win),
    modelShort: nonEmpty(tel.modelShort),
  };
}

function createLightsCollector(deps) {
  const { statFile, readTail, transcriptPath, resolveCodexRollout, analyzeTranscript, analyzeCodexRollout, backfillCodexUuid, contextWindowFor, warn = () => {} } = deps;
  const loadCodexTelemetry = deps.loadCodexTelemetry || ((_session, text) => analyzeCodexRollout(text));
  const codexJournalStatKey = deps.codexJournalStatKey || (() => 'rollout-only');
  const memo = new Map();

  async function collect(sessions) {
    const termLights = {}, attention = {}, asks = {}, pendingById = {};
    const liveIds = new Set();
    for (const s of sessions) {
      liveIds.add(s.id);
      if (runtimeConflict(s)) continue;
      const rt = runtimeOf(s);
      if (rt === 'shell') continue;
      try {
        if (rt === 'codex') {
          if (!s.codexUuid) { try { await backfillCodexUuid(s, sessions); } catch {} continue; }
          const r = resolveCodexRollout(s.codexUuid);
          if (!r) { termLights[s.id] = summarize({}); memo.delete(s.id); continue; }
          const key = `${r.stat.mtimeMs}:${r.stat.size}|${codexJournalStatKey(s)}`;
          const m = memo.get(s.id);
          let tuple;
          if (m && m.statKey === key) tuple = m.tuple;
          else {
            const text = await readTail(r.path, TAIL_LINES, TAIL_BYTES);
            // Carry the complete parity state machine, not just `working`: Codex task_complete
            // supplies a truncation-stable turn id, while hook-only fields deliberately remain null.
            tuple = summarize(loadCodexTelemetry(s, text), contextWindowFor);
            memo.set(s.id, { statKey: key, tuple, pendingAsk: null });
          }
          termLights[s.id] = tuple;
          continue;
        }
        if (rt !== 'claude' && rt !== 'local') continue;
        const file = transcriptPath(s.cwd, s.uuid);
        let st = null;
        if (file) {
          try { st = statFile(file); }
          catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
        }
        if (!st) { termLights[s.id] = summarize({}); memo.delete(s.id); continue; }
        const key = `${st.mtimeMs}:${st.size}`;
        const m = memo.get(s.id);
        let tuple, pendingAsk;
        if (m && m.statKey === key) { tuple = m.tuple; pendingAsk = m.pendingAsk; }
        else {
          const text = await readTail(file, TAIL_LINES, TAIL_BYTES);
          const tel = analyzeTranscript(text);
          tuple = summarize(tel, contextWindowFor);
          pendingAsk = tel.pendingAsk || null;
          memo.set(s.id, { statKey: key, tuple, pendingAsk });
        }
        termLights[s.id] = tuple;
        if (tuple.needsInput) {
          attention[s.id] = tuple.needsInputKind || 'question';
          // Local runtimes still surface attention, but only a cloud Claude
          // session may enter the auto-answer pipeline.
          if (rt === 'claude') {
            asks[s.id] = { kind: tuple.needsInputKind };
            if (pendingAsk) pendingById[s.id] = pendingAsk;
          }
        }
      } catch (e) {
        termLights[s.id] = { err: true };
        memo.delete(s.id);
        warn(`[command-deck] lights walk error for ${s.id}: ${e && e.message}`);
      }
    }
    for (const id of [...memo.keys()]) if (!liveIds.has(id)) memo.delete(id);
    return { termLights, attention, asks, pendingById };
  }

  return { collect };
}

module.exports = { createLightsCollector, summarize, TAIL_LINES, TAIL_BYTES };
