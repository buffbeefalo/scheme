'use strict';

const { markField } = require('./codex-telemetry');
const { sameIdentity, reconstructHookTelemetry } = require('./codex-hook-journal');

const HOOK_FIELDS = ['needsInput', 'pendingBg', 'tasks', 'todos', 'readFiles', 'skills', 'plugins', 'mcp', 'codex'];

function unavailable(telemetry, key) {
  const meta = telemetry && telemetry.telemetryMeta && telemetry.telemetryMeta.fields && telemetry.telemetryMeta.fields[key];
  return !meta || meta.completeness === 'unavailable';
}

function copyField(target, source, key) {
  target[key] = structuredClone(source[key]);
  target.telemetryMeta.fields[key] = structuredClone(source.telemetryMeta.fields[key]);
  if (key === 'needsInput') {
    target.needsInputKind = source.needsInputKind || null;
    target.pendingAsk = source.pendingAsk ? structuredClone(source.pendingAsk) : null;
  }
}

function mergeCodexTelemetry(rollout, journal, identity) {
  const out = structuredClone(rollout);
  out.telemetryMeta = out.telemetryMeta || { fields: {}, warnings: [] };
  out.telemetryMeta.warnings = [...(out.telemetryMeta.warnings || [])];
  if (!journal || journal.valid !== true || !sameIdentity(journal.identity, identity)) {
    out.telemetryMeta.warnings.push(...((journal && journal.warnings) || []));
    return out;
  }
  const hook = journal.telemetry || reconstructHookTelemetry(journal);
  for (const key of HOOK_FIELDS) {
    if (unavailable(out, key) && !unavailable(hook, key)) copyField(out, hook, key);
  }
  if (out.tasks !== null) out.tasksPartial = out.telemetryMeta.fields.tasks.completeness !== 'complete';
  const known = out.working !== null && out.needsInput !== null && out.pendingBg !== null;
  const completeness = known && [out.telemetryMeta.fields.working, out.telemetryMeta.fields.needsInput, out.telemetryMeta.fields.pendingBg]
    .some((meta) => !meta || meta.completeness === 'partial') ? 'partial' : known ? 'complete' : 'unavailable';
  markField(out, 'waitingOnBackground', known ? (!out.working && !out.needsInput && out.pendingBg > 0) : null,
    known ? 'derived' : 'unavailable', completeness, known ? out.lastActivity : null,
    known ? hook.telemetryMeta.fields.pendingBg.coverageSince : null);
  // The rollout's stateSince dates a WORKING edge. If the hook journal lifts the reported state to
  // one the rollout never witnessed — blocked on the user, or waiting on a subagent — that timestamp
  // no longer describes the state being shown, and there is nothing truthful to replace it with.
  if (out.needsInput === true || out.waitingOnBackground === true) out.stateSince = null;
  out.telemetryMeta.warnings.push(...(hook.telemetryMeta.warnings || []), ...((journal && journal.warnings) || []));
  return out;
}

module.exports = { HOOK_FIELDS, mergeCodexTelemetry };
