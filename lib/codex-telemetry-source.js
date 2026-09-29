'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeCodexRollout, markField } = require('./codex-telemetry');
const { createCodexLifecycleReader } = require('./codex-lifecycle');
const { validIdentity, journalPath, readHookJournal } = require('./codex-hook-journal');
const { mergeCodexTelemetry } = require('./codex-telemetry-merge');
const lifecycleReader = createCodexLifecycleReader();

function defaultJournalRoot(env = process.env) {
  return env.COMMAND_DECK_CODEX_TELEMETRY_DIR
    || path.join(os.homedir(), '.claude', 'command-deck', 'codex-telemetry');
}

function sessionIdentity(session) {
  return {
    sessionId: session && session.codexUuid,
    tabId: session && session.id,
    generationId: session && session.codexGeneration,
  };
}

function loadCodexTelemetry(session, rolloutText, options = {}) {
  const analyze = options.analyzeCodexRollout || analyzeCodexRollout;
  const rollout = analyze(rolloutText);
  if (options.rollout) {
    const life = (options.lifecycleReader || lifecycleReader).read(options.rollout.path,
      [session.id, session.codexUuid, session.codexGeneration || ''].join(':'));
    rollout.telemetryMeta.lifecyclePending = life.pending;
    if (life.working !== null) {
      const sameEdge = rollout.telemetryMeta.fields.working.observedAt === life.observedAt;
      rollout.stateSince = life.stateSince || (sameEdge ? rollout.stateSince : null);
      markField(rollout, 'working', life.working, 'rollout', 'complete', life.observedAt);
      if (life.lastTurnId) markField(rollout, 'lastTurnId', life.lastTurnId, 'rollout', 'complete', life.lastTurnAt);
    } else {
      // A bounded detail tail cannot overrule an unread or unclassifiable gap.
      rollout.stateSince = null;
      markField(rollout, 'working', null, 'unavailable', 'unavailable');
    }
  }
  const identity = sessionIdentity(session);
  // Legacy sessions and the current safe rollout-only launch path intentionally
  // have no generation marker. They degrade without manufacturing hook state.
  if (!validIdentity(identity)) return rollout;
  const root = options.journalRoot || defaultJournalRoot(options.env);
  const file = journalPath(root, identity);
  const read = options.readHookJournal || readHookJournal;
  return mergeCodexTelemetry(rollout, read(file, identity), identity);
}

function codexJournalStatKey(session, options = {}) {
  const identity = sessionIdentity(session);
  if (!validIdentity(identity)) return 'rollout-only';
  const root = options.journalRoot || defaultJournalRoot(options.env);
  const file = journalPath(root, identity);
  const stat = options.statFile || fs.statSync;
  try {
    const value = stat(file);
    return `${value.mtimeMs}:${value.size}`;
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'missing' : `unreadable:${error && error.code || 'unknown'}`;
  }
}

module.exports = { defaultJournalRoot, sessionIdentity, loadCodexTelemetry, codexJournalStatKey };
