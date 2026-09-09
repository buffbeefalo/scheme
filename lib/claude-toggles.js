'use strict';

const { homedir } = require('node:os');

// Claude runtime switches — flip the harness surfaces (plugins / hooks / skills / council)
// that a NEW Claude Code session will load. Nothing here can affect sessions already
// running: plugins+hooks are read from ~/.claude/settings.json at launch, skills are
// discovered from the skill dirs at launch, and the council directive is CLAUDE.md prose
// gated on a marker file. The UI must say "applies to new sessions".
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
// derived booleans/counts. A settings file that fails to parse is never written back.
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFile } = require('./atomicfile');

const COUNCIL_PLUGIN = 'ai-council@personal-council';
const TOGGLE_NAMES = ['plugins', 'hooks', 'skills', 'council'];

function home(opts = {}) { return opts.home || process.env.HOME || homedir(); }
function settingsPath(opts) { return path.join(home(opts), '.claude', 'settings.json'); }
function markerPath(opts) { return path.join(home(opts), '.claude', 'council-disabled'); }
// Where the pre-blackout per-plugin state is parked so the switch is REVERSIBLE. Without this,
// flipping plugins off and back on set every key to true — silently force-enabling the ones that
// were deliberately disabled (14 of 23 on this box). A kill switch must restore what it killed.
function pluginStatePath(opts) { return path.join(home(opts), '.claude', '.deck-plugin-state.json'); }
function readPluginState(opts) {
  try { const v = JSON.parse(fs.readFileSync(pluginStatePath(opts), 'utf8')); return (v && typeof v === 'object') ? v : null; }
  catch { return null; }
}
function skillDirs(opts) {
  return [path.join(home(opts), '.claude', 'skills'), path.join(home(opts), '.agents', 'skills')];
}

// → { ok:true, settings } | { ok:true, settings:null } (absent) | { ok:false, error } (corrupt).
// Corrupt is distinct from absent: absent is writable (start fresh), corrupt is read-only.
function readSettings(opts) {
  let raw;
  try { raw = fs.readFileSync(settingsPath(opts), 'utf8'); }
  catch { return { ok: true, settings: null }; }
  try { return { ok: true, settings: JSON.parse(raw) }; }
  catch { return { ok: false, error: 'settings.json exists but is not valid JSON — refusing to touch it' }; }
}

async function writeSettings(settings, opts) {
  await atomicWriteFile(settingsPath(opts), JSON.stringify(settings, null, 2) + '\n');
}

function pluginKeys(settings) {
  const all = settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    ? Object.keys(settings.enabledPlugins) : [];
  return all.filter((k) => k !== COUNCIL_PLUGIN);
}

function readState(opts = {}) {
  const s = readSettings(opts);
  if (!s.ok) return { ok: false, error: s.error };
  const settings = s.settings || {};
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
  on = !!on;
  const warnings = [];
  const s = readSettings(opts);
  if (!s.ok) return { ok: false, status: 409, error: s.error };
  const settings = s.settings || {};

  try {
    if (name === 'plugins') {
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      const keys = pluginKeys(settings);
      if (!on) {
        // Park the current per-plugin state BEFORE blacking it out, so switching back restores
        // the exact mix rather than turning everything on.
        const snap = {};
        for (const k of keys) snap[k] = settings.enabledPlugins[k] !== false;
        try { await atomicWriteFile(pluginStatePath(opts), JSON.stringify(snap, null, 2) + '\n'); }
        catch (e) { warnings.push(`could not save plugin state (${e && e.message}) — turning plugins back on will enable all of them`); }
        for (const k of keys) settings.enabledPlugins[k] = false;
      } else {
        const snap = readPluginState(opts);
        // Restore only what was parked; a key added since the blackout keeps its own value.
        // With no snapshot (first ever use, or a failed save) fall back to enabling everything,
        // which is the old behaviour and the only safe guess left.
        for (const k of keys) settings.enabledPlugins[k] = snap ? (Object.hasOwn(snap, k) ? snap[k] : settings.enabledPlugins[k] !== false) : true;
        if (!snap) warnings.push('no saved plugin state — enabled every plugin');
        else { try { fs.unlinkSync(pluginStatePath(opts)); } catch {} }
      }
      await writeSettings(settings, opts);
    } else if (name === 'hooks') {
      if (on) delete settings.disableAllHooks; else settings.disableAllHooks = true;
      await writeSettings(settings, opts);
    } else if (name === 'skills') {
      flipSkillDirs(on, opts, warnings);
    } else if (name === 'council') {
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      if (Object.hasOwn(settings.enabledPlugins, COUNCIL_PLUGIN) || !on) settings.enabledPlugins[COUNCIL_PLUGIN] = on;
      await writeSettings(settings, opts);
      if (on) { try { fs.unlinkSync(markerPath(opts)); } catch {} }
      else {
        fs.mkdirSync(path.dirname(markerPath(opts)), { recursive: true });
        fs.writeFileSync(markerPath(opts), `council disabled via Command Deck at ${new Date().toISOString()}\n`);
      }
    }
  } catch (e) {
    return { ok: false, status: 500, error: `toggle "${name}" failed: ${e && e.message}` };
  }
  const state = readState(opts);
  return { ok: true, name, on, warnings, ...(state.ok ? { toggles: state.toggles } : {}) };
}

module.exports = { readState, setToggle, TOGGLE_NAMES, COUNCIL_PLUGIN };
