'use strict';

// CLI bridge for the /handoff skill: RETIRE a Command Deck tab after a handoff — kill its tmux
// session and drop it from the registry (so it won't auto-resume next boot). Mirror of newtab.js:
// short-lived process, in-process lib calls, no HTTP (the kill route fails closed on origin-less
// POSTs). The web UI drops the tab on its next ~12s session poll.
//
//   node lib/closetab.js --id <cd…> [--after <seconds>]
//
// Only ids starting with "cd" are accepted — Command Deck sessions only, never a personal tmux
// session. --after sleeps in-process before killing, so the dying tab can schedule its own
// deferred retirement on the tmux SERVER (survives the pane's death):
//   tmux run-shell -b "node …/lib/closetab.js --id $SELF --after 45"
//
// Prints one JSON line: {"ok":true,"id":"cd…"} or {"ok":false,"error":"…"}.

const terminal = require('./terminal');
let audit; try { audit = require('./audit'); } catch { audit = null; }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--id') { out.id = v; i++; }
    else if (argv[i] === '--after') { out.after = v; i++; }
  }
  return out;
}

// Defense in depth on top of terminal.isSafeId: this bridge only ever retires Command Deck
// sessions (ids are minted as "cd…" by terminal.createSession).
function guardId(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s.startsWith('cd')) return { ok: false, error: 'refusing: not a Command Deck session id (must start with "cd")' };
  return { ok: true, id: s };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const a = parseArgs(argv);
  const g = guardId(a.id);
  if (!g.ok) return g;
  const after = Math.max(0, parseInt(a.after, 10) || 0);
  if (after) await sleep(after * 1000);
  const r = await terminal.killSession(g.id);
  if (audit) {
    try { audit.appendEntry({ actor: 'cli:closetab', action: 'term:kill', target: g.id, ok: !!(r && r.ok) }); } catch {}
  }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'killSession failed' };
  return { ok: true, id: g.id };
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(r.ok ? 0 : 1); })
    .catch((e) => {
      process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }) + '\n');
      process.exit(1);
    });
}

module.exports = { parseArgs, guardId, main };
