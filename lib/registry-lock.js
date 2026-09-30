'use strict';

// Cross-process lock for the terminal-session registry. The registry is mutated by
// the long-lived dashboard and short-lived CLI helpers, so an atomic final rename is
// not enough: the complete read-modify-write transaction needs one owner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

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
  const platform = overrides.platform || process.platform;
  const exec = overrides.execFileSync || execFileSync;
  const kill = overrides.kill || ((ownerPid, signal) => process.kill(ownerPid, signal));
  const now = overrides.now || Date.now;
  const sleep = overrides.sleep || ((ms) => Atomics.wait(sleepWord, 0, 0, ms));
  const makeToken = overrides.token || (() => crypto.randomBytes(16).toString('hex'));
  const nativeOptions = { encoding: 'utf8', timeout: 500, maxBuffer: 4096,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] };
  const getBootId = overrides.bootId || (() => {
    if (platform !== 'darwin') return readBootId(io);
    try {
      // Unlike kern.boottime, the boot UUID cannot change when the wall clock
      // is adjusted. A clock change must never invalidate a live owner's lock.
      const boot = String(exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], nativeOptions)).trim().toLowerCase();
      return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot) ? `darwin:${boot}` : null;
    } catch { return null; }
  });
  const getStartTicks = overrides.processStartTicks || ((ownerPid) => {
    if (platform !== 'darwin') return readProcessStartTicks(ownerPid, io);
    try {
      // Darwin lstart formats the stored p_start timestamp (preserved on exec),
      // not boot time plus current uptime. Fixed locale/timezone stabilize it.
      const raw = String(exec('/bin/ps', ['-p', String(ownerPid), '-o', 'lstart='], nativeOptions)).trim().replace(/\s+/g, ' ');
      if (/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(raw)) return `darwin:${raw}`;
    } catch {}
    // A failed/empty ps response alone never proves that an owner died. Only
    // ESRCH from the no-signal existence probe authorizes dead-owner recovery.
    try { kill(ownerPid, 0); } catch (error) { if (error && error.code === 'ESRCH') return false; }
    return null;
  });
  const warn = overrides.warn || ((message) => console.warn(message));
  const timeoutMs = Number.isFinite(overrides.timeoutMs) ? overrides.timeoutMs : 500;
  const retryMs = Number.isFinite(overrides.retryMs) ? overrides.retryMs : 10;
  const malformedStaleMs = Number.isFinite(overrides.malformedStaleMs) ? overrides.malformedStaleMs : 30_000;
  const reclaimMalformed = overrides.reclaimMalformed !== false;

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
      return reclaimMalformed && !!snapshot.stat && now() - snapshot.stat.mtimeMs > malformedStaleMs;
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

  async function withLockAsync(registryFile, callback) {
    const lease = acquire(registryFile);
    if (!lease) return false;
    try {
      const result = await callback({ token: lease.token, owns: lease.owns });
      if (!lease.owns()) {
        warn('[command-deck] registry lock ownership changed before commit');
        return false;
      }
      return result;
    } catch (error) {
      warn(`[command-deck] registry transaction failed: ${error.message}`);
      return false;
    } finally {
      releaseOwned(lease.lockPath, lease.token);
    }
  }

  return { withLock, withLockAsync };
}

module.exports = { createRegistryLock };
