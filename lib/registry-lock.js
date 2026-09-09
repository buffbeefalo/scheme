'use strict';

// Cross-process lock for the terminal-session registry. The registry is mutated by
// the long-lived dashboard and short-lived CLI helpers, so an atomic final rename is
// not enough: the complete read-modify-write transaction needs one owner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sleepWord = new Int32Array(new SharedArrayBuffer(4));

function readBootId(fsImpl) {
  try { return fsImpl.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; }
  catch { return null; }
}

// /proc/<pid>/stat field 22 is process start time in clock ticks. Locate the
// final ')' first because Linux process names may themselves contain spaces.
function readProcessStartTicks(pid, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(')');
    if (end < 0) return null;
    return raw.slice(end + 2).trim().split(/\s+/)[19] || null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    return null;
  }
}

function createRegistryLock(overrides = {}) {
  const io = overrides.fs || fs;
  const pid = Number.isInteger(overrides.pid) ? overrides.pid : process.pid;
  const now = overrides.now || Date.now;
  const sleep = overrides.sleep || ((ms) => Atomics.wait(sleepWord, 0, 0, ms));
  const makeToken = overrides.token || (() => crypto.randomBytes(16).toString('hex'));
  const getBootId = overrides.bootId || (() => readBootId(io));
  const getStartTicks = overrides.processStartTicks || ((ownerPid) => readProcessStartTicks(ownerPid, io));
  const warn = overrides.warn || ((message) => console.warn(message));
  const timeoutMs = Number.isFinite(overrides.timeoutMs) ? overrides.timeoutMs : 500;
  const retryMs = Number.isFinite(overrides.retryMs) ? overrides.retryMs : 10;
  const malformedStaleMs = Number.isFinite(overrides.malformedStaleMs) ? overrides.malformedStaleMs : 30_000;

  function readSnapshot(lockPath) {
    try {
      const raw = io.readFileSync(lockPath, 'utf8');
      const stat = io.statSync(lockPath);
      let record = null;
      try { record = JSON.parse(raw); } catch {}
      const valid = !!(record
        && record.version === 1
        && typeof record.token === 'string' && record.token
        && Number.isInteger(record.pid) && record.pid > 0
        && typeof record.bootId === 'string' && record.bootId
        && typeof record.startTicks === 'string' && record.startTicks
        && Number.isFinite(record.createdAt));
      return { missing: false, raw, stat, record: valid ? record : null };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { missing: true };
      return { missing: false, error };
    }
  }

  function owns(lockPath, token) {
    const snapshot = readSnapshot(lockPath);
    return !snapshot.missing && !snapshot.error && !!snapshot.record && snapshot.record.token === token;
  }

  function releaseOwned(lockPath, token) {
    if (!owns(lockPath, token)) return false;
    try { io.unlinkSync(lockPath); return true; }
    catch (error) {
      if (!error || error.code !== 'ENOENT') warn(`[command-deck] registry lock release failed: ${error.message}`);
      return false;
    }
  }

  function createExclusive(lockPath, record) {
    let fd = null;
    let created = false;
    try {
      fd = io.openSync(lockPath, 'wx', 0o600);
      created = true;
      io.writeFileSync(fd, JSON.stringify(record));
      if (typeof io.fsyncSync === 'function') io.fsyncSync(fd);
      io.closeSync(fd);
      fd = null;
      return true;
    } catch (error) {
      if (fd != null) { try { io.closeSync(fd); } catch {} }
      if (error && error.code === 'EEXIST') return false;
      // We alone created this path and the callback has not started, so no
      // compliant owner can have replaced it. Remove even empty/partial JSON.
      if (created) { try { io.unlinkSync(lockPath); } catch {} }
      throw error;
    }
  }

  function stale(snapshot, currentBootId) {
    if (!snapshot || snapshot.missing || snapshot.error) return false;
    if (!snapshot.record) {
      return !!snapshot.stat && now() - snapshot.stat.mtimeMs > malformedStaleMs;
    }
    if (snapshot.record.bootId !== currentBootId) return true;
    let actual;
    try { actual = getStartTicks(snapshot.record.pid); } catch { actual = null; }
    if (actual === false) return true;
    if (actual == null) return false;
    return String(actual) !== snapshot.record.startTicks;
  }

  function removeSame(lockPath, snapshot) {
    const current = readSnapshot(lockPath);
    if (current.missing || current.error || current.raw !== snapshot.raw) return false;
    try { io.unlinkSync(lockPath); return true; } catch { return false; }
  }

  function clearStaleReclaimGuard(reclaimPath, currentBootId) {
    const guard = readSnapshot(reclaimPath);
    return stale(guard, currentBootId) ? removeSame(reclaimPath, guard) : false;
  }

  function reclaim(lockPath, reclaimPath, observed, identity, token) {
    const guardRecord = {
      version: 1,
      token: `${token}:reclaim`,
      pid,
      bootId: identity.bootId,
      startTicks: identity.startTicks,
      createdAt: now(),
    };
    let guardOwned = false;
    try {
      guardOwned = createExclusive(reclaimPath, guardRecord);
      if (!guardOwned) {
        clearStaleReclaimGuard(reclaimPath, identity.bootId);
        return false;
      }
      const current = readSnapshot(lockPath);
      if (current.missing) return true;
      if (current.error || current.raw !== observed.raw || !stale(current, identity.bootId)) return false;
      return removeSame(lockPath, current);
    } catch (error) {
      warn(`[command-deck] registry stale-lock recovery failed: ${error.message}`);
      return false;
    } finally {
      if (guardOwned) releaseOwned(reclaimPath, guardRecord.token);
    }
  }

  function currentIdentity() {
    let bootId = null;
    let startTicks = null;
    try { bootId = getBootId(); } catch {}
    try { startTicks = getStartTicks(pid); } catch {}
    if (typeof bootId !== 'string' || !bootId || typeof startTicks !== 'string' || !startTicks) return null;
    return { bootId, startTicks };
  }

  function acquire(registryFile) {
    const identity = currentIdentity();
    if (!identity) {
      warn('[command-deck] registry lock unavailable: current process identity could not be verified');
      return null;
    }
    try { io.mkdirSync(path.dirname(registryFile), { recursive: true }); }
    catch (error) {
      warn(`[command-deck] registry lock directory failed: ${error.message}`);
      return null;
    }

    const lockPath = `${registryFile}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    const token = makeToken();
    const deadline = now() + timeoutMs;
    const record = { version: 1, token, pid, bootId: identity.bootId, startTicks: identity.startTicks, createdAt: now() };

    while (true) {
      const guard = readSnapshot(reclaimPath);
      if (!guard.missing) {
        clearStaleReclaimGuard(reclaimPath, identity.bootId);
      } else {
        try {
          if (createExclusive(lockPath, record)) {
            // A reclaimer can win just after our pre-check. It must see our new
            // token before deleting anything; we withdraw until its guard clears.
            if (!readSnapshot(reclaimPath).missing) releaseOwned(lockPath, token);
            else return { lockPath, token, owns: () => owns(lockPath, token) };
          } else {
            const observed = readSnapshot(lockPath);
            if (stale(observed, identity.bootId)) reclaim(lockPath, reclaimPath, observed, identity, token);
          }
        } catch (error) {
          warn(`[command-deck] registry lock acquisition failed: ${error.message}`);
          return null;
        }
      }
      if (now() >= deadline) {
        warn(`[command-deck] registry lock timed out after ${timeoutMs}ms`);
        return null;
      }
      sleep(Math.min(retryMs, Math.max(0, deadline - now())));
    }
  }

  function withLock(registryFile, callback) {
    const lease = acquire(registryFile);
    if (!lease) return false;
    try {
      const result = callback({ token: lease.token, owns: lease.owns });
      if (!lease.owns()) {
        warn('[command-deck] registry lock ownership changed before commit');
        return false;
      }
      return result === true;
    } catch (error) {
      warn(`[command-deck] registry transaction failed: ${error.message}`);
      return false;
    } finally {
      releaseOwned(lease.lockPath, lease.token);
    }
  }

  return { withLock };
}

module.exports = { createRegistryLock };
