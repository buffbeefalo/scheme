'use strict';

// CLI bridge for the /handoff skill: open a NEW Command Deck tab that auto-continues from a
// handoff document. Run as a short-lived process (NOT the running server) so it always picks up
// the current terminal.js. createSession() does `tmux new-session` + registry.upsert, and the web
// UI re-syncs the session list every ~12s (terminal-ui.js — "tabs created from another device /
// tmux CLI appear without a reload"), so the tab surfaces on its own. No HTTP (the POST route
// fails closed on origin-less requests), no server restart needed.
//
//   node lib/newtab.js --bump "<current tab title>" --cwd "<dir>" --prompt "<initial prompt>"
//   node lib/newtab.js --label "<exact title>"      --cwd "<dir>" --prompt "<initial prompt>"
//   node lib/newtab.js --agent codex --bump "<current tab title>" --cwd "<dir>" --prompt "<initial prompt>"
//
// Prints one JSON line: {"ok":true,"id":"cd…","label":"foo v2"} or {"ok":false,"error":"…"}.

const terminal = require('./terminal');
const LABEL_MAX = terminal.LABEL_MAX || 40;   // match sanitizeLabel's cap so the " vN" suffix can't be sliced off

// "Put v2 next to the title" — but survive REPEATED handoffs by bumping a trailing " vN" rather than
// stacking suffixes: "foo" → "foo v2" → "foo v3", never "foo v2 v2". A bare title gets " v2". The base
// is trimmed so the whole "<base> vN" fits LABEL_MAX; otherwise sanitizeLabel (terminal.js) would later
// slice off the version suffix, and repeated long-title handoffs would never increment (finding 4b).
function bumpVersion(title, max = LABEL_MAX) {
  const t = String(title == null ? '' : title).trim();
  let base, n;
  const m = t.match(/^(.*\S)\s+v(\d+)$/);          // "<base> vN" → bump N (keeps the base)
  if (m) { base = m[1]; n = Number(m[2]) + 1; }
  else {
    const bare = t.match(/^v(\d+)$/);              // a title that IS just "vN" → bump it
    if (bare) return `v${Number(bare[1]) + 1}`;
    base = t; n = 2;                               // no version (incl. "foov2", "vNext") → start at v2
  }
  if (!base) return `v${n}`;                       // empty title → just "v2"
  const suffix = ` v${n}`;
  if (base.length + suffix.length > max) base = base.slice(0, max - suffix.length).trimEnd();
  return `${base}${suffix}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--bump') { out.bump = v; i++; }
    else if (argv[i] === '--label') { out.label = v; i++; }
    else if (argv[i] === '--cwd') { out.cwd = v; i++; }
    else if (argv[i] === '--prompt') { out.prompt = v; i++; }
    else if (argv[i] === '--agent') {
      // Preserve a missing value as invalid instead of accidentally consuming
      // the next option and silently falling back to Claude.
      if (v == null || v.startsWith('--')) out.agent = '';
      else { out.agent = v; i++; }
    }
  }
  return out;
}

function sessionOptions(a, label) {
  const base = { label, cwd: a.cwd || '', prompt: a.prompt || '' };
  if (a.agent == null || a.agent === 'claude') return { ok: true, options: base };
  if (a.agent === 'codex') return { ok: true, options: { ...base, codex: true } };
  return { ok: false, error: "--agent must be 'claude' or 'codex'" };
}

async function main(argv) {
  const a = parseArgs(argv);
  const label = a.label != null ? a.label : bumpVersion(a.bump || '');
  const request = sessionOptions(a, label);
  if (!request.ok) return request;
  const r = await terminal.createSession(request.options);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'createSession failed' };
  return { ok: true, id: r.session.id, label: r.session.name };
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(r.ok ? 0 : 1); })
    .catch((e) => {
      process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }) + '\n');
      process.exit(1);
    });
}

module.exports = { bumpVersion, parseArgs, sessionOptions, main };
