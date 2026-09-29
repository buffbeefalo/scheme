'use strict';
const fs = require('node:fs');
const { LifecycleRecordParser } = require('./codex-lifecycle-record');

const READ_BUDGET = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const empty = () => ({ working: null, lastTurnId: null, lastTurnAt: null, stateSince: null, observedAt: null });

function lifecycleEvent(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  const p = record && record.type === 'event_msg' && record.payload;
  if (!p || !['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) return null;
  return {
    working: p.type === 'task_started',
    lastTurnId: p.type === 'task_complete' && typeof p.turn_id === 'string' && p.turn_id ? p.turn_id : null,
    observedAt: typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null,
  };
}

function fold(state, event) {
  if (state.working !== event.working) state.stateSince = state.working === null ? null : event.observedAt;
  state.working = event.working;
  state.observedAt = event.observedAt;
  if (event.lastTurnId) { state.lastTurnId = event.lastTurnId; state.lastTurnAt = event.observedAt; }
}

// Recover the most recent native lifecycle event, then read only appends. The detail
// tail can move past a turn's start without moving this cursor past its evidence.
function createCodexLifecycleReader({ io = fs, budgetBytes = READ_BUDGET, chunkBytes = CHUNK_BYTES,
  maxLineBytes = MAX_LINE_BYTES, maxEntries = 128 } = {}) {
  const cache = new Map();
  function read(file, identity = '') {
    const key = identity + '\0' + file;
    let fd;
    try {
      fd = io.openSync(file, 'r');
      const st = io.fstatSync(fd);
      const block = (start, length) => {
        const b = Buffer.alloc(length);
        const n = io.readSync(fd, b, 0, length, start);
        if (n !== length) throw new Error('rollout changed during read');
        return b;
      };
      let s = cache.get(key);
      const sameFile = s && s.dev === st.dev && s.ino === st.ino && st.size >= s.size
        && !(st.size === s.size && st.mtimeMs !== s.mtimeMs)
        && block(0, s.head.length).equals(s.head)
        && block(s.size - s.anchor.length, s.anchor.length).equals(s.anchor);
      if (!sameFile) {
        s = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs,
          scanOffset: st.size, scanDone: false, boundary: null, lineEnd: null,
          inspection: null, parser: null, ready: false, offset: 0,
          parts: [], partBytes: 0, oversized: false, skipTail: true, state: empty() };
      }
      cache.delete(key); cache.set(key, s);
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      let budget = budgetBytes;
      const clearLine = () => { s.parts = []; s.partBytes = 0; s.oversized = false; s.parser = null; };
      const fragment = (b, reverse) => {
        if (reverse && (s.oversized || s.skipTail)) return;
        if (s.parser) { s.parser.write(b); return; }
        s.partBytes += b.length;
        if (s.partBytes > maxLineBytes) {
          s.oversized = true;
          if (!reverse) {
            s.parser = new LifecycleRecordParser();
            for (const part of s.parts) s.parser.write(part);
            s.parser.write(b);
          }
          s.parts = []; s.partBytes = 0; return;
        }
        if (reverse) s.parts.unshift(b); else s.parts.push(b);
      };
      const recover = result => {
        if (result.kind === 'event' || result.kind === 'unknown') {
          if (result.event) fold(s.state, result.event);
          s.ready = true; s.offset = s.boundary ?? 0;
        }
      };
      const finishReverse = start => {
        if (s.skipTail) { s.skipTail = false; clearLine(); return; }
        if (s.oversized) {
          // Reverse discovery retains only the byte range. Validate it forward,
          // sharing this call's budget and resuming inspection on the next poll.
          s.inspection = { offset: start, end: s.lineEnd, parser: new LifecycleRecordParser() };
        } else {
          const event = lifecycleEvent(Buffer.concat(s.parts).toString('utf8'));
          if (event) recover({ kind: 'event', event });
        }
        clearLine();
      };
      while (!s.ready && budget > 0) {
        if (s.inspection) {
          const scan = s.inspection;
          const len = Math.min(scan.end - scan.offset, chunkBytes, budget);
          if (len > 0) {
            scan.parser.write(block(scan.offset, len));
            scan.offset += len; budget -= len;
          }
          if (scan.offset === scan.end) { recover(scan.parser.finish()); s.inspection = null; }
          continue;
        }
        if (s.scanOffset === 0) {
          if (!s.scanDone) { finishReverse(0); s.scanDone = true; }
          if (!s.inspection) { s.ready = true; s.offset = s.boundary ?? 0; }
          continue;
        }
        const len = Math.min(s.scanOffset, chunkBytes, budget), start = s.scanOffset - len;
        const b = block(start, len);
        s.scanOffset = start; budget -= len;
        let end = b.length;
        while (end > 0 && !s.ready) {
          const nl = b.lastIndexOf(10, end - 1);
          fragment(b.subarray(nl + 1, end), true);
          if (nl < 0) break;
          if (s.skipTail) s.boundary = start + nl + 1;
          finishReverse(start + nl + 1);
          s.lineEnd = start + nl;
          if (s.inspection) {
            // Any older bytes already fetched in this chunk may be reread, but
            // that replay is also charged to the budget.
            s.scanOffset = start + nl; break;
          }
          end = nl;
        }
      }
      while (s.ready && s.offset < st.size && budget > 0) {
        const len = Math.min(st.size - s.offset, chunkBytes, budget), b = block(s.offset, len);
        s.offset += len; budget -= len;
        let start = 0, nl;
        while ((nl = b.indexOf(10, start)) >= 0) {
          fragment(b.subarray(start, nl), false);
          if (s.parser) {
            const result = s.parser.finish();
            if (result.event) fold(s.state, result.event);
            else if (result.kind === 'unknown') s.state = empty();
          } else {
            const event = lifecycleEvent(Buffer.concat(s.parts).toString('utf8'));
            if (event) fold(s.state, event);
          }
          clearLine(); start = nl + 1;
        }
        fragment(b.subarray(start), false);
      }
      s.size = st.size; s.mtimeMs = st.mtimeMs;
      s.head = block(0, Math.min(128, st.size));
      s.anchor = block(Math.max(0, st.size - 128), Math.min(128, st.size));
      const pending = !s.ready || s.offset < st.size;
      return { ...(pending ? empty() : s.state), pending };
    } catch (error) {
      cache.delete(key);
      throw error;
    } finally {
      if (fd !== undefined) io.closeSync(fd);
    }
  }
  return { read };
}

module.exports = { createCodexLifecycleReader, lifecycleEvent, READ_BUDGET, CHUNK_BYTES, MAX_LINE_BYTES };
