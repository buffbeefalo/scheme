'use strict';

const { homedir } = require('node:os');

// Claude runtime switches — flip the harness surfaces (plugins / hooks / skills / council)
// that a NEW Claude Code session will load. Plugins+hooks are read from settings.json
// at launch and skills are discovered from the skill dirs at launch. The council's
// marker is also checked before later provider calls from already-open sessions.
//
// Mechanisms (each is the ONLY one that actually works for its surface — verified 2026-08-14
// against claude CLI 2.1.233, which has disableAllHooks but no disableAllPlugins and no
// skills kill-switch):
//   plugins → enabledPlugins[key]=false for every key EXCEPT the council plugin (owned below)
//   hooks   → disableAllHooks: true
//   skills  → rename ~/.claude/skills and ~/.agents/skills to <dir>.disabled (and back)
//   council → enabledPlugins['ai-council@personal-council']=false PLUS the marker file
//             ~/.claude/council-disabled, which the CLAUDE.md council directive checks
//
// Safety: settings.json holds secrets — this module never returns file contents, only
// derived booleans/counts. Unreadable or malformed settings are never written back.
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFile } = require('./atomicfile');
const { createRegistryLock } = require('./registry-lock');

const COUNCIL_PLUGIN = 'ai-council@personal-council';
const TOGGLE_NAMES = ['plugins', 'hooks', 'skills', 'council'];
const settingsLock = createRegistryLock();
const settingsQueues = new Map();

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function readObject(file, label, valid = () => true) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, value: null, raw: null };
    return { ok: false, error: `${label} could not be read (${error && error.code || 'read error'}) — refusing to touch it` };
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { return { ok: false, error: `${label} exists but is not valid JSON — refusing to touch it` }; }
  if (!isObject(value) || !valid(value)) return { ok: false, error: `${label} has an invalid structure — refusing to touch it` };
  return { ok: true, value, raw };
}

function conflict(message) { return Object.assign(new Error(message), { status: 409 }); }
function requireUnchanged(current, baseline, label) {
  if (!current.ok) throw conflict(current.error);
  if (current.raw !== baseline.raw) throw conflict(`${label} changed while the toggle was pending — refusing to replace it`);
}

async function writeObject(file, value, owner, beforeReplace) {
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n', {
    ...fs.promises,
    writeFile: (target, data) => fs.promises.writeFile(target, data, { mode: 0o600 }),
    async rename(from, to) {
      if (!owner.owns()) throw conflict('settings lock ownership changed — refusing to write');
      beforeReplace();
      // This detects observed drift; it is not an atomic compare-and-swap against
      // external editors that do not participate in Scheme's settings lock.
      await fs.promises.rename(from, to);
    },
  });
}

function home(opts = {}) { return opts.home || process.env.HOME || homedir(); }
function settingsPath(opts) { return path.join(home(opts), '.claude', 'settings.json'); }
function markerPath(opts) { return path.join(home(opts), '.claude', 'council-disabled'); }
// Where the pre-blackout per-plugin state is parked so the switch is REVERSIBLE. Without this,
// flipping plugins off and back on set every key to true — silently force-enabling the ones that
// were deliberately disabled (14 of 23 on this box). A kill switch must restore what it killed.
function pluginStatePath(opts) { return path.join(home(opts), '.claude', '.deck-plugin-state.json'); }
function readPluginState(opts) {
  return readObject(pluginStatePath(opts), 'saved plugin state', (value) => Object.values(value).every((on) => typeof on === 'boolean'));
}
function skillDirs(opts) {
  return [path.join(home(opts), '.claude', 'skills'), path.join(home(opts), '.agents', 'skills')];
}

// Only ENOENT means absent. Invalid JSON, invalid shapes and read errors are read-only.
function readSettings(opts) {
  return readObject(settingsPath(opts), 'settings.json', (value) =>
    !Object.hasOwn(value, 'enabledPlugins') || isObject(value.enabledPlugins));
}

async function writeSettings(settings, opts, baseline, owner) {
  await writeObject(settingsPath(opts), settings, owner, () => requireUnchanged(readSettings(opts), baseline, 'settings.json'));
}

function pluginKeys(settings) {
  const all = settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    ? Object.keys(settings.enabledPlugins) : [];
  return all.filter((k) => k !== COUNCIL_PLUGIN);
}

function readState(opts = {}) {
  const s = readSettings(opts);
  if (!s.ok) return { ok: false, error: s.error };
  const settings = s.value || {};
  const keys = pluginKeys(settings);
  const onCount = keys.filter((k) => settings.enabledPlugins[k] !== false).length;
  const dirs = skillDirs(opts);
  const enabledDirs = dirs.filter((d) => fs.existsSync(d));
  const disabledDirs = dirs.filter((d) => fs.existsSync(d + '.disabled'));
  const councilKeyOn = !settings.enabledPlugins || settings.enabledPlugins[COUNCIL_PLUGIN] !== false;
  const markerExists = fs.existsSync(markerPath(opts));
  return {
    ok: true,
    toggles: {
      plugins: { on: keys.length === 0 || onCount > 0, detail: `${onCount}/${keys.length} enabled` },
      hooks: { on: settings.disableAllHooks !== true, detail: settings.disableAllHooks === true ? 'disableAllHooks' : 'settings hooks live' },
      skills: {
        on: enabledDirs.length > 0 || disabledDirs.length === 0,
        detail: enabledDirs.length + disabledDirs.length === 0 ? 'no skill dirs'
          : `${enabledDirs.length} dir${enabledDirs.length === 1 ? '' : 's'} live, ${disabledDirs.length} parked`,
      },
      council: {
        on: councilKeyOn && !markerExists,
        detail: markerExists ? 'directive suspended (marker)' : councilKeyOn ? 'plugin + directive live' : 'plugin off',
      },
    },
  };
}

// Rename each skills dir to <dir>.disabled (off) or back (on). A dir whose destination
// already exists is SKIPPED with a warning — never merge or overwrite skill trees.
function flipSkillDirs(on, opts, warnings) {
  for (const dir of skillDirs(opts)) {
    const parked = dir + '.disabled';
    const [from, to] = on ? [parked, dir] : [dir, parked];
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) { warnings.push(`${to} already exists — left ${from} in place`); continue; }
    fs.renameSync(from, to);
  }
}

async function setToggle(name, on, opts = {}) {
  if (!TOGGLE_NAMES.includes(name)) return { ok: false, status: 400, error: `unknown toggle "${name}"` };
  const resolved = { ...opts, home: path.resolve(home(opts)) };
  const file = settingsPath(resolved);
  // Queue before taking the cross-process lock, so another call in this process
  // cannot block the event loop while the current owner's writes are awaiting I/O.
  const previous = settingsQueues.get(file) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const result = await settingsLock.withLockAsync(file, (owner) => applyToggle(name, !!on, resolved, owner));
    return result || { ok: false, status: 409, error: 'settings update could not acquire or retain its lock — try again' };
  });
  settingsQueues.set(file, pending);
  try { return await pending; }
  finally { if (settingsQueues.get(file) === pending) settingsQueues.delete(file); }
}

async function applyToggle(name, on, opts, owner) {
  const warnings = [];
  const s = readSettings(opts);
  if (!s.ok) return { ok: false, status: 409, error: s.error };
  const settings = s.value || {};

  try {
    if (name === 'plugins') {
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      const keys = pluginKeys(settings);
      const saved = readPluginState(opts);
      if (!saved.ok) return { ok: false, status: 409, error: saved.error };
      const snap = saved.value;
      let createdSnapshot = null;
      if (!on) {
        // Preserve the first snapshot across repeated OFF requests. If it cannot
        // be saved, refuse the blackout rather than lose the original choices.
        if (!snap) {
          const initial = Object.fromEntries(keys.map((key) => [key, settings.enabledPlugins[key] !== false]));
          await writeObject(pluginStatePath(opts), initial, owner, () => {
            requireUnchanged(readSettings(opts), s, 'settings.json');
            requireUnchanged(readPluginState(opts), saved, 'saved plugin state');
          });
          createdSnapshot = { raw: JSON.stringify(initial, null, 2) + '\n' };
        }
        for (const k of keys) settings.enabledPlugins[k] = false;
      } else {
        // Restore only what was parked; a key added since the blackout keeps its own value.
        // A genuinely absent snapshot retains the legacy fallback with an explicit warning.
        for (const k of keys) settings.enabledPlugins[k] = snap ? (Object.hasOwn(snap, k) ? snap[k] : settings.enabledPlugins[k] !== false) : true;
        if (!snap) warnings.push('no saved plugin state — enabled every plugin');
      }
      try {
        await writeSettings(settings, opts, s, owner);
      } catch (error) {
        if (createdSnapshot) {
          try {
            if (!owner.owns()) throw conflict('settings lock ownership changed');
            const current = readPluginState(opts);
            if (!current.ok || current.raw !== null) {
              requireUnchanged(current, createdSnapshot, 'saved plugin state');
              fs.unlinkSync(pluginStatePath(opts));
            }
          } catch (cleanup) {
            error.message += `; the unused plugin backup could not be removed (${cleanup.message})`;
          }
        }
        throw error;
      }
      // Keep recovery information until the settings replacement succeeds.
      if (on && snap) {
        try {
          if (!owner.owns()) throw conflict('settings lock ownership changed');
          requireUnchanged(readPluginState(opts), saved, 'saved plugin state');
          fs.unlinkSync(pluginStatePath(opts));
        } catch (error) {
          if (error && error.code !== 'ENOENT') warnings.push(`plugins restored but saved state could not be removed (${error && error.message})`);
        }
      }
    } else if (name === 'hooks') {
      if (on) delete settings.disableAllHooks; else settings.disableAllHooks = true;
      await writeSettings(settings, opts, s, owner);
    } else if (name === 'skills') {
      flipSkillDirs(on, opts, warnings);
    } else if (name === 'council') {
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      if (Object.hasOwn(settings.enabledPlugins, COUNCIL_PLUGIN) || !on) settings.enabledPlugins[COUNCIL_PLUGIN] = on;
      await writeSettings(settings, opts, s, owner);
      if (on) { try { fs.unlinkSync(markerPath(opts)); } catch {} }
      else {
        fs.mkdirSync(path.dirname(markerPath(opts)), { recursive: true });
        fs.writeFileSync(markerPath(opts), `council disabled via Command Deck at ${new Date().toISOString()}\n`);
      }
    }
  } catch (e) {
    return { ok: false, status: e && e.status || 500, error: `toggle "${name}" failed: ${e && e.message}` };
  }
  const state = readState(opts);
  return { ok: true, name, on, warnings, ...(state.ok ? { toggles: state.toggles } : {}) };
}

module.exports = { readState, setToggle, TOGGLE_NAMES, COUNCIL_PLUGIN };
