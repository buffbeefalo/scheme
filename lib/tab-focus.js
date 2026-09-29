'use strict';

// Pure transcript helpers for the latest real request, project activity, and last action.
// A launch directory alone is not evidence that an agent worked on a project.

const os = require('os');
const path = require('path');
const { redactSensitiveText } = require('./redact');

const HOME = path.resolve(os.homedir() || '/');   // resolve() drops the historical trailing slash

// Folders an agent touches for its own plumbing (plugin/skill caches, uploads, tool state). A read
// of a skill file is not "working in" that folder, so these never name the project.
// Session transcripts and memory notes are written at the END of most tasks, so they would mask the
// real project; they count as plumbing too.
const PLUMBING = ['.claude/plugins', '.claude/projects', '.codex', '.cache', '.npm', '.npm-global', '.local', '.cc-uploads', '.agents', '.config', '.nvm'];

// A path → the project it belongs to, or null when it names no project (outside home, home itself,
// plumbing). isFile: the path is a file, so a single segment under home is a loose file, not a folder.
function projectOf(p, isFile, home = HOME) {
  if (typeof p !== 'string' || !p) return null;
  let abs = p;
  if (abs.startsWith('file://')) { try { abs = decodeURIComponent(new URL(abs).pathname); } catch { return null; } }
  if (!path.isAbsolute(abs)) return null;
  abs = path.resolve(abs);
  const rel = path.relative(home, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const seg = rel.split(path.sep);
  const dirSeg = isFile ? seg.slice(0, -1) : seg;
  if (!dirSeg.length) return null;
  const relDir = dirSeg.join('/');
  if (PLUMBING.some((x) => relDir === x || relDir.startsWith(x + '/'))) return null;
  // Conventional workspace roots contain projects one level below them.
  if (['projects', 'src', 'code', 'dev', 'repos', 'work', 'workspace'].includes(dirSeg[0]) && dirSeg.length > 1) {
    return { label: dirSeg[1], path: path.join(home, ...dirSeg.slice(0, 2)) };
  }
  // Hidden application state is not a project, even when it is not on the known list.
  if (dirSeg[0].startsWith('.')) return null;
  return { label: dirSeg[0], path: path.join(home, dirSeg[0]) };
}

// events: chronological [{kind:'edit'|'cwd'|'read', path}], one per tool action ('cwd' = the folder a
// command ran in). "Latest folder visited" was tried first and lied: tabs end a task by filing notes
// or course reviews somewhere unrelated, so the LAST move named the wrong project. Instead each
// project scores the actions it received (an edit counts triple — changing files is the work;
// reading is context), ties go to the more recent. A second project within half the top score is
// reported as `also` so split work shows both. No scoring action → null, shown honestly.
const WEIGHT = { edit: 3, cwd: 1, read: 1 };
function whereFrom(events, home = HOME) {
  const score = new Map();
  (Array.isArray(events) ? events : []).forEach((e, i) => {
    if (!e || !WEIGHT[e.kind]) return;
    const proj = projectOf(e.path, e.kind !== 'cwd', home);
    if (!proj) return;
    const row = score.get(proj.path) || { label: proj.label, path: proj.path, score: 0, last: -1 };
    row.score += WEIGHT[e.kind]; row.last = i;
    score.set(proj.path, row);
  });
  const ranked = [...score.values()].sort((a, b) => b.score - a.score || b.last - a.last);
  if (!ranked.length) return null;
  const [top, next] = ranked;
  const also = next && next.score * 2 >= top.score ? { label: next.label, path: next.path } : null;
  return { label: top.label, path: top.path, also };
}

const ASK_MAX = 160;
// A user-turn text → the request as the operator typed it, or null for harness traffic (hook
// reminders, task notices, pasted-instruction preambles, interrupts). Slash commands keep their
// name: "/goal <args>".
function cleanAsk(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  const cmd = s.match(/<command-name>\s*([^<]*?)\s*<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    s = (cmd[1] + ' ' + args).trim();
  } else if (s.startsWith('<') || s.startsWith('[Request interrupted') || s.startsWith('# AGENTS.md')) {
    return null;
  }
  // Requests travel to every open dashboard: scrub keys/tokens/passwords before they leave the server.
  s = redactSensitiveText(s.replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, ' [pasted text] ')).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > ASK_MAX ? s.slice(0, ASK_MAX - 1).trimEnd() + '…' : s;
}

// The latest tool action in plain words ("Editing terminal-ui.js", "Run the full test suite") —
// labelled "last action" in the UI because it is history, not a claim about this instant.
const clip = (s, n = 90) => { const t = redactSensitiveText(String(s || '')).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const base = (p) => (typeof p === 'string' && p ? path.basename(p) : '');
function claudeAction(name, input) {
  const inp = input || {};
  const file = base(inp.file_path || inp.notebook_path);
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return file ? 'Editing ' + file : 'Editing a file';
  if (name === 'Read') return file ? 'Reading ' + file : 'Reading a file';
  if (name === 'Bash') return inp.description ? clip(inp.description) : 'Running a command';
  if (name === 'Grep' || name === 'Glob') return 'Searching files';
  if (name === 'Agent' || name === 'Task') return 'Delegating: ' + (clip(inp.description, 60) || 'a helper agent');
  if (name === 'Workflow') return 'Running a multi-agent workflow';
  if (name === 'WebFetch' || name === 'WebSearch') return 'Looking something up online';
  if (name === 'AskUserQuestion') return 'Asking you a question';
  if (name === 'ExitPlanMode') return 'Waiting for plan approval';
  if (name === 'Skill') return 'Using the ' + clip(inp.skill, 40) + ' skill';
  if (['TaskCreate', 'TaskUpdate', 'TodoWrite'].includes(name)) return 'Updating its task list';
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(name || '');
  if (mcp) return 'Using ' + [...new Set(mcp[1].replace(/^(plugin_|claude_ai_)/, '').split('_'))].join(' ');   // plugin_playwright_playwright → playwright
  return name ? 'Using ' + name : null;
}
// Codex nested items: a FileChange, or a shell command whose parsed_cmd says what it did.
function codexAction(item) {
  if (!item) return null;
  if (item.type === 'FileChange') {
    const files = item.changes && typeof item.changes === 'object' ? Object.keys(item.changes) : [];
    return files.length ? 'Editing ' + base(files[0]) + (files.length > 1 ? ' +' + (files.length - 1) : '') : 'Editing files';
  }
  if (item.type === 'CommandExecution') {
    const cmds = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
    const read = cmds.find((c) => c && c.type === 'read');
    if (read) return 'Reading ' + (base(read.path || read.name) || 'a file');
    if (cmds.some((c) => c && c.type === 'search')) return 'Searching files';
    if (cmds.some((c) => c && c.type === 'list_files')) return 'Listing files';
    return 'Running a command';
  }
  if (item.type === 'McpToolCall') return 'Using ' + clip(item.server, 40);
  if (item.type === 'ImageView') return 'Looking at an image';
  return null;
}

module.exports = { projectOf, whereFrom, cleanAsk, claudeAction, codexAction, HOME, ASK_MAX };
