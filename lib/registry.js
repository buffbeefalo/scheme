'use strict';

const { homedir } = require('node:os');

// Disk-persistent registry of Command Deck terminal sessions. tmux holds session
// state only in RAM, so it's lost on reboot; this JSON file is the durable mirror
// (id, label, cwd, claude uuid) that lets the server re-create + `claude --resume`
// every session after the machine restarts. Written on create/rename/close.
// Path is overridable via COMMAND_DECK_REGISTRY (used by tests).
// Snapshot reads stay lock-free: same-directory atomic rename guarantees a
// complete old or new document. Mutations lock the whole read-modify-write
// transaction because the dashboard and CLI helpers are separate processes.
const fs = require('fs');
const path = require('path');
const { createRegistryLock } = require('./registry-lock');

const registryLock = createRegistryLock();

function file() {
  return process.env.COMMAND_DECK_REGISTRY
    || path.join(process.env.HOME || homedir(), '.claude', 'command-deck', 'sessions.json');
}

function validSession(session) {
  return !!session && typeof session === 'object' && !Array.isArray(session)
    && typeof session.id === 'string' && !!session.id;
}

function readSnapshot() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!j || j.version !== 1 || !Array.isArray(j.sessions)
      || !j.sessions.every(validSession)) {
      throw new Error('invalid registry document');
    }
    return { ok: true, missing: false, sessions: j.sessions };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, missing: true, sessions: [] };
    return { ok: false, missing: false, sessions: null, error };
  }
}

function readAll() {
  const snapshot = readSnapshot();
  if (snapshot.ok) return snapshot.sessions;
  console.warn(`[command-deck] registry read failed: ${snapshot.error.message}`);
  return []; // Legacy snapshot callers degrade; mutations never use this fallback.
}

function writeAllUnlocked(sessions, owner) {
  const f = file();
  const tmp = `${f}.${process.pid}.${owner.token}.tmp`;
  let fd = null;
  let created = false;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fd = fs.openSync(tmp, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify({ version: 1, sessions }, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (!owner.owns()) return false;
    fs.renameSync(tmp, f);          // atomic replace
    created = false;
    // Rename durability needs the containing directory as well as the data.
    // Some filesystems do not implement directory fsync; other failures remain
    // visible even though the atomic replacement has already occurred.
    fd = fs.openSync(path.dirname(f), 'r');
    try { fs.fsyncSync(fd); }
    catch (error) { if (!error || !['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
    return true;
  } catch (error) {
    console.warn(`[command-deck] registry write failed: ${error.message}`);
    return false;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    if (created) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

function writeAll(sessions) {
  if (!Array.isArray(sessions) || !sessions.every(validSession)) return false;
  return mutate(() => ({ write: true, sessions }));
}

function mutate(build) {
  return registryLock.withLock(file(), (owner) => {
    const snapshot = readSnapshot();
    if (!snapshot.ok) {
      console.warn(`[command-deck] registry mutation refused: ${snapshot.error.message}`);
      return false;
    }
    const change = build(snapshot.sessions);
    if (!change.write) return change.result;
    return writeAllUnlocked(change.sessions, owner);
  });
}

// Add or update a session by id. meta: {id, label, cwd, uuid, createdAt}
function upsert(meta) {
  if (!validSession(meta)) return false;
  return mutate((all) => {
    const i = all.findIndex((s) => s.id === meta.id);
    if (i >= 0) all[i] = { ...all[i], ...meta };
    else all.push({ createdAt: Date.now(), ...meta });
    return { write: true, sessions: all };
  });
}

function setLabel(id, label) {
  return mutate((all) => {
    const s = all.find((x) => x.id === id);
    if (!s) return { write: false, result: false };
    s.label = label;
    return { write: true, sessions: all };
  });
}

function remove(id) {
  return mutate((all) => {
    const next = all.filter((s) => s.id !== id);
    if (next.length === all.length) return { write: false, result: true };   // nothing to do
    return { write: true, sessions: next };
  });
}

// Reorder the saved sessions to match `ids` (the new tab order). Ids not present are
// ignored; any saved session missing from `ids` is kept, appended at the end. The array
// order IS the tab order, so this persists drag-to-reorder across reboot/refresh.
function reorder(ids) {
  if (!Array.isArray(ids)) return false;
  return mutate((all) => {
    const byId = new Map(all.map((s) => [s.id, s]));
    const next = [];
    for (const id of ids) if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); }
    for (const s of byId.values()) next.push(s);   // leftovers keep their relative order
    return { write: true, sessions: next };
  });
}

module.exports = { file, readSnapshot, readAll, writeAll, upsert, setLabel, remove, reorder };
