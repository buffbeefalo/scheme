'use strict';

const fs = require('node:fs/promises');
const { cleanAsk } = require('./tab-focus');

// Task context is a literal excerpt of the opening request. It never calls a model,
// reads an attachment, or treats a persisted goal as evidence of current activity.
function firstUserText(text, runtime) {
  for (const line of String(text || '').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    let content;
    if (runtime === 'codex') {
      const p = row && row.payload;
      if (!p) continue;
      if (row.type === 'response_item' && p.type === 'message' && p.role === 'user') content = p.content;
      else if (row.type === 'event_msg' && p.type === 'user_message') content = p.message;
      else if (row.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') content = p.item.content;
      else if (row.type === 'event_msg' && p.type === 'thread_goal_updated') content = p.goal?.objective;
    } else if (row?.type === 'user' && !row.isMeta && !row.isCompactSummary && !row.queueTranscriptOnly) {
      content = row.message?.content;
    }
    const value = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(item => item && ['text', 'input_text'].includes(item.type)).map(item => item.text || '').join('\n') : '';
    const ask = cleanAsk(value);
    if (ask) return ask;
  }
  return null;
}

function createTaskResolver({ maxBytes = 1024 * 1024, maxFiles = 200 } = {}) {
  const cache = new Map();
  async function taskFor(_session, runtime, file) {
    if (!file || !['claude', 'local', 'codex'].includes(runtime)) return null;
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      const prefix = Buffer.alloc(Math.min(128, stat.size));
      await handle.read(prefix, 0, prefix.length, 0);
      const previous = cache.get(file);
      if (previous && previous.runtime === runtime && previous.dev === stat.dev && previous.ino === stat.ino
        && stat.size >= previous.size && (stat.size !== previous.size || stat.mtimeMs === previous.mtimeMs)
        && prefix.equals(previous.prefix)) return previous.task;
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      // Ignore an unterminated record, including one cut by the bounded head read.
      const end = buffer.lastIndexOf(10, bytesRead - 1);
      const sentence = end < 0 ? null : firstUserText(buffer.subarray(0, end).toString('utf8'), runtime);
      const task = sentence ? { sentence, from: 'first request', pending: false } : null;
      cache.delete(file);
      // An empty new transcript is retried so its first request can appear later.
      if (task) cache.set(file, { runtime, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, prefix, task });
      while (cache.size > maxFiles) cache.delete(cache.keys().next().value);
      return task;
    } catch {
      cache.delete(file);
      return null;
    } finally { if (handle) await handle.close(); }
  }
  return { taskFor };
}

module.exports = { createTaskResolver, firstUserText };
