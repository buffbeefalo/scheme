'use strict';

// Idle-tab reaper: close a Command Deck tab after COMMAND_DECK_IDLE_CLOSE_HOURS (default 48)
// with no activity from the human OR the agent. Default inactivity rule: "if no edits in 48
// hours then close it" — plus the correction that landed with it, "things that ask for my
// follow up DO NOT close".
//
// ---- why the clock is what it is (all four candidates measured on the live box, 2026-08-11)
//   * transcript FILE MTIME — rejected. Four live transcripts carried mtimes minutes old while
//     the newest record INSIDE them was 2-4 days old (something rewrites the file). lights.js
//     uses (mtime,size) as a CHANGE trigger, which is harmless there; as an idle clock it would
//     mean this reaper never fires.
//   * tmux #{window_activity} — rejected. Sampled 25s apart it jumped to `now` for all five
//     ATTACHED tabs, including one whose conversation had been dead 12 days: an attached pane's
//     TUI redraws forever, so window_activity measures pixels, not work. It would have spared
//     every tab a browser happens to be looking at, and (worse) it read 1.38d IDLE for a tab
//     that was streaming tokens at that moment, because that tab was detached.
//   * tmux #{session_activity} — kept, but only as HALF the clock. It moves on real client
//     interaction (keys, scroll, attach) and stays frozen under redraw, which is exactly the
//     "activity from me" half. It is NOT output-driven: a detached pane printing output left it
//     unchanged in a controlled probe.
//   * transcript LAST RECORD TIMESTAMP — kept as the other half. It is the conversation's own
//     clock: reboot-durable, redraw-immune, and it correctly reported the token-streaming tab as
//     active (0.00d) when tmux claimed 1.38d. Every pane's live session uuid was confirmed
//     against /proc/<pid>/cmdline to be the registry uuid, so transcriptPath(cwd,uuid) is the
//     file that pane is really writing.
//
// idle = now - max(last transcript record, session_activity, registry createdAt)
//
// session_activity is IGNORED when it equals session_created: a reboot revives every saved tab
// with both stamps set to the revival moment, which carries no information about the human. The
// transcript clock survives the reboot, so the tab keeps aging correctly instead of being handed
// a fresh 48h lease. registry createdAt is the floor so a brand-new tab that never produced a
// transcript still ages out from its creation.
//
// Everything here is fail-closed: any missing evidence keeps the tab. Killing a live agent is
// unrecoverable; keeping a dead tab costs one row in a list.

const { runtimeOf, runtimeConflict } = require('./runtime');

const DEFAULT_HOURS = 48;
const TAIL_BYTES = 64 * 1024;          // enough for many records; we only need the newest stamp
const HOUR_MS = 3600 * 1000;
// A shell tab has no transcript and no lights, so it is judged on interaction alone — but only
// while its pane is sitting at a plain prompt. Anything else running there is work in progress.
const IDLE_SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', '-bash', '-zsh']);

// PURE. Threshold in ms from the environment. 0 (or a non-positive/garbage value) disables the
// reaper entirely — an unparseable knob must never silently mean "48".
function thresholdMs(env = process.env) {
  const raw = env.COMMAND_DECK_IDLE_CLOSE_HOURS;
  const hours = raw == null || raw === '' ? DEFAULT_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours * HOUR_MS;
}

// PURE. Newest record timestamp (epoch ms) in a transcript tail, or null. Both Claude JSONL and
// Codex rollout lines carry an ISO-8601 `timestamp`. We scan ALL stamps in the tail and take the
// max rather than trusting line order, and parse with Date.parse — the ISO strings are UTC and
// hand-rolled timezone math silently shifted an earlier draft of this by an hour.
function lastRecordTs(text) {
  let best = null;
  const re = /"timestamp"\s*:\s*"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

// PURE. The single activity clock, in epoch ms. See the header for why each input is shaped
// this way. Returns null when nothing at all is known (caller keeps the tab).
function effectiveActivity({ convTs = null, sessionActivity = null, sessionCreated = null, createdAt = null }) {
  const stamps = [];
  if (Number.isFinite(convTs)) stamps.push(convTs);
  // A session_activity equal to session_created is the reboot-revival stamp, not a human.
  if (Number.isFinite(sessionActivity) && (!Number.isFinite(sessionCreated) || sessionActivity > sessionCreated)) {
    stamps.push(sessionActivity);
  }
  if (Number.isFinite(createdAt)) stamps.push(createdAt);
  return stamps.length ? Math.max(...stamps) : null;
}

// PURE. Should this tab be closed? Returns {reap:boolean, reason:string, idleMs:number|null}.
// `light` is the session's lib/lights.js tuple; `tmuxInfo` is {activity, created} in epoch ms.
function decide(session, { light, tmuxInfo = {}, convTs = null, paneCmd = null, now, threshold, pinned = false }) {
  const keep = (reason) => ({ reap: false, reason, idleMs: null });
  if (!threshold) return keep('disabled');
  if (!session || !session.id) return keep('no-session');
  // A pinned tab is exempt however long it idles — the user's explicit keep-list, held outside
  // the registry (pinned-tabs.json) so nothing that rewrites sessions.json can drop it.
  if (pinned === true) return keep('pinned');
  if (runtimeConflict(session)) return keep('runtime-conflict');

  const rt = runtimeOf(session);
  if (rt === 'shell') {
    // No transcript, no lights. Only reap a shell sitting at its prompt.
    if (!paneCmd || !IDLE_SHELLS.has(String(paneCmd).trim())) return keep('shell-busy');
  } else {
    // Agent tabs need a live lights reading. Absent or errored = no evidence = keep.
    if (!light || light.err) return keep('no-lights');
    if (light.working === true) return keep('working');
    // The explicit ask: a tab waiting on the user is never closed, however long it waits.
    if (light.needsInput === true) return keep('needs-input');
    if (light.waitingOnBackground === true) return keep('waiting-on-background');
  }

  // A session with no tmux row (read failed, or it was created between our two calls) has lost
  // the "activity from me" half of the clock. Judging it on the conversation alone would close a
  // tab whose transcript is ancient but that the user clicked into a minute ago — measured: one
  // live tab sat at 287h conversation-idle and 1h interaction-idle. Missing evidence keeps it.
  if (!Number.isFinite(tmuxInfo.activity)) return keep('no-tmux-activity');

  const last = effectiveActivity({
    convTs,
    sessionActivity: tmuxInfo.activity,
    sessionCreated: tmuxInfo.created,
    createdAt: session.createdAt,
  });
  if (last === null) return keep('no-activity-evidence');
  const idleMs = now - last;
  if (!(idleMs >= threshold)) return { reap: false, reason: 'fresh', idleMs };
  return { reap: true, reason: 'idle', idleMs };
}

// PURE. Apply decide() across a session list; returns only the reapable ones, oldest first.
function selectStale(sessions, ctx) {
  const out = [];
  const pins = ctx.pins instanceof Set ? ctx.pins : new Set(Array.isArray(ctx.pins) ? ctx.pins : []);
  for (const s of sessions || []) {
    const d = decide(s, {
      ...ctx,
      pinned: pins.has(s.uuid) || pins.has(s.codexUuid) || pins.has(s.id),
      light: (ctx.lights || {})[s.id],
      tmuxInfo: (ctx.tmux || {})[s.id] || {},
      convTs: (ctx.convTs || {})[s.id] ?? null,
      paneCmd: (ctx.paneCmds || {})[s.id] || null,
    });
    if (d.reap) out.push({ id: s.id, name: s.name || s.id, cwd: s.cwd || '', runtime: runtimeOf(s), uuid: s.uuid || s.codexUuid || null, idleMs: d.idleMs });
  }
  return out.sort((a, b) => b.idleMs - a.idleMs);
}

// ---- I/O ------------------------------------------------------------------
// deps: {listSessions, tmuxActivity, readTail, transcriptFor, killSession, audit, ledger, now, env, log, warn}
function createIdleCloser(deps) {
  const {
    listSessions, tmuxActivity, readTail, transcriptFor, killSession,
    audit = () => {}, ledger = () => {}, now = () => Date.now(),
    env = process.env, log = () => {}, warn = () => {}, readPins = () => [],
  } = deps;

  // One sweep. `lights` is the live termLights map from the fast tick. A missing map means the
  // transcript walk failed this tick — we have no working/needsInput evidence for ANY tab, so
  // the whole sweep is skipped rather than run blind.
  async function sweep(lights) {
    const threshold = thresholdMs(env);
    if (!threshold) return { ok: true, skipped: 'disabled', scanned: 0, closed: [] };
    if (!lights || typeof lights !== 'object') return { ok: true, skipped: 'no-lights-map', scanned: 0, closed: [] };

    let sessions;
    try { sessions = await listSessions(); } catch (e) { warn(`idle-close: listSessions failed: ${e && e.message}`); return { ok: false, scanned: 0, closed: [] }; }
    if (!Array.isArray(sessions) || !sessions.length) return { ok: true, scanned: 0, closed: [] };

    // Same rule as the lights map: a failed/empty tmux read is missing evidence for EVERY tab,
    // so the sweep stands down rather than judging on half a clock.
    const tmux = await tmuxActivity().catch(() => ({}));
    if (!tmux || !Object.keys(tmux).length) { warn('idle-close: no tmux activity data — sweep skipped'); return { ok: true, skipped: 'no-tmux-activity', scanned: 0, closed: [] }; }
    const convTs = {}, paneCmds = {};
    for (const s of sessions) {
      if (tmux[s.id] && tmux[s.id].paneCmd) paneCmds[s.id] = tmux[s.id].paneCmd;
      try {
        const f = transcriptFor(s);
        convTs[s.id] = f ? lastRecordTs(await readTail(f, TAIL_BYTES)) : null;
      } catch { convTs[s.id] = null; }      // unreadable transcript = no evidence = keep
    }

    // Pins are an exception list, so absence/garbage means "no pins" and the sweep proceeds —
    // the reverse of the evidence rules above, where missing data stands the sweep down.
    let pins = [];
    try { const p = await readPins(); if (Array.isArray(p)) pins = p; } catch { /* no pins */ }

    const at = now();
    const stale = selectStale(sessions, { lights, tmux, convTs, paneCmds, pins, now: at, threshold });
    const dry = String(env.COMMAND_DECK_IDLE_CLOSE_DRY || '') === '1';
    const closed = [];
    for (const t of stale) {
      const hours = (t.idleMs / HOUR_MS).toFixed(1);
      if (dry) { log(`idle-close [DRY] would close ${t.id} "${t.name}" (idle ${hours}h)`); closed.push({ ...t, dry: true }); continue; }
      // Ledger BEFORE the kill: the row that tells you how to get the conversation back must
      // survive even if the kill or the process dies mid-sweep.
      ledger({ closedAt: at, id: t.id, name: t.name, cwd: t.cwd, runtime: t.runtime, uuid: t.uuid, idleHours: Number(hours) });
      let ok = false;
      try { const r = await killSession(t.id); ok = !!(r && r.ok); } catch (e) { warn(`idle-close: kill ${t.id} failed: ${e && e.message}`); }
      audit({ actor: 'idle-reaper', action: 'term:autoclose', target: t.id, detail: `"${t.name}" idle ${hours}h (${t.runtime}) resume: ${t.uuid || 'n/a'}`, ok });
      log(`idle-close: closed ${t.id} "${t.name}" after ${hours}h idle (${t.runtime}${t.uuid ? `, resume ${t.uuid}` : ''})`);
      if (ok) closed.push(t);
    }
    return { ok: true, scanned: sessions.length, closed };
  }

  return { sweep };
}

module.exports = {
  DEFAULT_HOURS, TAIL_BYTES, HOUR_MS, IDLE_SHELLS,
  thresholdMs, lastRecordTs, effectiveActivity, decide, selectStale, createIdleCloser,
};
