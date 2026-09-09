'use strict';

// Filesystem affordances for the Studio terminal, JAILED to a session's cwd.
// Powers the project file tree, @-mention search, and image attach. Every path is
// resolved and re-confirmed to stay within `root` — lexically AND after realpath
// (symlink defense) — so a crafted `rel`/filename can never read or write outside
// the session directory. No shell ever touches these inputs. Pure + unit-tested;
// server.js only supplies the trusted `root` (the tmux session's @cd_cwd).

const fs = require('fs');
const path = require('path');

// Heavy/uninteresting dirs we never descend into for @-mention search.
const FS_SKIP = new Set(['node_modules', '.git', '.cache', '.next', 'dist', 'build', '.venv', '__pycache__', '.turbo', '.pnpm-store']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

// Resolve `rel` under `root`, returning the absolute path only if it stays inside.
// Returns null on any escape. Symlinks are followed and re-checked when the target
// exists; a not-yet-existing target (e.g. a fresh upload dir) passes on the lexical
// check alone, which is sufficient because we built the path from a sanitized name.
function jailResolve(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(rel || '.'));
  if (target !== base && !target.startsWith(base + path.sep)) return null;     // lexical jail
  try {
    const rbase = fs.realpathSync(base), rt = fs.realpathSync(target);          // symlink jail
    if (rt !== rbase && !rt.startsWith(rbase + path.sep)) return null;
    return rt;
  } catch { return target; }
}

// One directory level, dirs first then name-sorted. Capped so a giant dir can't
// blow up the response.
function listDir(root, rel) {
  const target = jailResolve(root, rel);
  if (!target) return { ok: false, error: 'path escapes the session directory' };
  let ents;
  try { ents = fs.readdirSync(target, { withFileTypes: true }); }
  catch { return { ok: false, error: 'cannot read that directory' }; }
  const entries = [];
  for (const d of ents) {
    let dir = false, size = 0;
    try { const st = fs.statSync(path.join(target, d.name)); dir = st.isDirectory(); size = st.size; } catch {}
    entries.push({ name: d.name, dir, size });
    if (entries.length >= 800) break;
  }
  entries.sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name));
  return { ok: true, rel: String(rel || ''), entries };
}

// Bounded DFS for @-mention autocomplete: skips heavy dirs and symlinked dirs (no
// loops), caps files scanned and matches returned. Substring match on the rel path.
function findFiles(root, q, cap = 40) {
  const base = path.resolve(root);
  const ql = String(q || '').toLowerCase();
  const matches = []; let scanned = 0;
  const stack = [''];
  while (stack.length && matches.length < cap && scanned < 6000) {
    const rel = stack.pop();
    let ents; try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of ents) {
      if (FS_SKIP.has(d.name)) continue;
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { if (!d.isSymbolicLink() && (!d.name.startsWith('.') || d.name === '.cc-uploads')) stack.push(r); }
      else { scanned++; if (!ql || r.toLowerCase().includes(ql)) { matches.push(r); if (matches.length >= cap) break; } }
    }
  }
  return matches;
}

// Save a base64 (or data-URL) upload into <root>/.cc-uploads and return its path so the client
// can drop it into the prompt (Claude Code reads the file by path). ANY file type is accepted —
// images, pdf/docx/xlsx, sql/csv/json, code, etc. — because the file is only ever READ by Claude,
// never executed, and the destination is jailed to the session cwd. Rejects empty/oversize
// payloads and any path escape; the filename is basename'd + sanitized so it can't traverse.
function saveUpload(root, name, dataB64) {
  const base = path.resolve(root);
  const safe = (path.basename(String(name || 'file')).replace(/[^\w.\-]/g, '_').slice(0, 80)) || 'file';
  const buf = Buffer.from(String(dataB64 || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) return { ok: false, error: 'empty upload' };
  if (buf.length > 25 * 1024 * 1024) return { ok: false, error: 'file too large (>25MB)' };
  const dir = path.join(base, '.cc-uploads');
  // Realpath the upload dir AFTER creating it: if `.cc-uploads` was pre-planted as a
  // symlink pointing elsewhere, the resolved dir won't equal <realBase>/.cc-uploads,
  // so we refuse — the write can't be redirected outside the session cwd.
  let realBase, realDir;
  try { realBase = fs.realpathSync(base); fs.mkdirSync(dir, { recursive: true }); realDir = fs.realpathSync(dir); }
  catch { return { ok: false, error: 'could not prepare the upload directory' }; }
  if (realDir !== path.join(realBase, '.cc-uploads')) return { ok: false, error: 'upload directory escapes the session directory' };
  const fname = `${Date.now().toString(36)}-${safe}`;
  const dest = path.join(realDir, fname);
  if (!dest.startsWith(realDir + path.sep)) return { ok: false, error: 'bad destination' };
  // 'wx' = create only, never follow/overwrite an existing path (no symlink-clobber).
  try { const fd = fs.openSync(dest, 'wx', 0o600); try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); } }
  catch (e) { return { ok: false, error: e && e.code === 'EEXIST' ? 'name collision — retry' : 'could not save the file' }; }
  return { ok: true, path: dest, rel: path.join('.cc-uploads', fname), bytes: buf.length };
}

module.exports = { FS_SKIP, IMG_EXT, jailResolve, listDir, findFiles, saveUpload };
