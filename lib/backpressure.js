'use strict';

function closed(stream) {
  return !stream || stream.destroyed || stream.writableEnded;
}

// Attempt one write while enforcing a hard cap on the stream's queued bytes.
// `accepted:false` is normal Node backpressure; `ok:false` means evict/close.
function boundedWrite(stream, chunk, maxBytes) {
  if (closed(stream)) return { ok: false, accepted: false, overflow: true };
  if (Number(stream.writableLength || 0) > maxBytes) return { ok: false, accepted: false, overflow: true };
  try {
    const accepted = stream.write(chunk) !== false;
    const overflow = Number(stream.writableLength || 0) > maxBytes;
    return { ok: !overflow, accepted, overflow };
  } catch (error) {
    return { ok: false, accepted: false, overflow: true, error };
  }
}

// A terminal child is a real readable stream: pause it when the socket applies
// backpressure, then resume only after drain. Overflow closes the bridge.
function writeWithBackpressure(source, sink, chunk, { maxBytes, onOverflow = () => {} }) {
  const result = boundedWrite(sink, chunk, maxBytes);
  if (!result.ok) {
    onOverflow(result.error);
    return false;
  }
  if (!result.accepted && source && typeof source.pause === 'function') {
    source.pause();
    sink.once('drain', () => {
      if (!closed(sink) && source && !source.destroyed && typeof source.resume === 'function') source.resume();
    });
  }
  return true;
}

module.exports = { boundedWrite, writeWithBackpressure };
