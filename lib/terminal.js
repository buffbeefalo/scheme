'use strict';

const { homedir } = require('node:os');

// tmux-backed Claude Code session manager. tmux owns the PTYs and the session
// lifecycle, so sessions survive a browser reload, a dashboard restart, AND an
// external `tmux attach` — and we add zero native deps (no node-pty build on the
// GB10's aarch64 kernel). Every user-influenced value travels as a separate argv
// token; session ids are server-generated and validated, so nothing reaches a
// shell. Display name + cwd are stored as tmux user options (@cd_name/@cd_cwd) so
// they persist in tmux itself, not a fragile in-memory registry.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { mungeCwd } = require('./telemetry');
const { createTtlCache } = require('./ttlcache');
const { listCodexSessionCandidates } = require('./codex-telemetry');   // Codex resume-uuid capture (one-way dep)
const registry = require('./registry');   // durable session list (survives reboot)
const { RUNTIMES, runtimeOf, runtimeConflict, runtimeFromFlags } = require('./runtime');

const PREFIX = 'cd';
const LABEL_MAX = 40;   // max tab-label length (sanitizeLabel slices to this). Exported so newtab's
                        // bumpVersion reserves room for its " vN" suffix instead of having it sliced off.
const TMUX_BIN = ['/usr/bin/tmux', '/usr/local/bin/tmux'].find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || 'tmux';
const CLAUDE_BIN = process.env.COMMAND_DECK_CLAUDE || `${process.env.HOME || homedir()}/.local/bin/claude`;
const CLAUDE_LOCAL_BIN = process.env.COMMAND_DECK_CLAUDE_LOCAL || `${process.env.HOME || homedir()}/.local/bin/claude-local`;
// Codex CLI (OpenAI). A third interactive runtime alongside cloud-claude and claude-local. Codex
// self-manages its install and the layout CHURNS — 0.144 (2026-07-16) dropped the npm-global wrapper
// for a standalone release (~/.local/bin/codex symlink → ~/.codex/packages/standalone/current), which
// silently killed the old hardcoded default: send-keys landed, bash printed "No such file or
// directory", and the tab sat as a bare shell. Resolve per LAUNCH (not per boot — that migration
// happened while the server was up): first candidate on disk, else bare `codex` so the pane shell's
// own PATH does the lookup — the same resolution that works typed by hand. Override with
// COMMAND_DECK_CODEX.
function codexBin() {
  return process.env.COMMAND_DECK_CODEX
    || [`${process.env.HOME || homedir()}/.local/bin/codex`, `${process.env.HOME || homedir()}/.npm-global/bin/codex`]
      .find((p) => { try { return fs.existsSync(p); } catch { return false; } })
    || 'codex';
}
// pane_pid rides last: CD sessions are single-window/single-pane, so list-sessions expands it
// to the one pane's root pid (verified live) — the per-session resource-attribution root.
// @cd_codex / @cd_codex_model / @cd_codex_uuid ride between the local markers and pane_pid;
// @cd_shell (plain-terminal lane, 2026-07-16) and @cd_autonomous ride just before pane_pid. pane_pid MUST stay last
// (single-pane sessions expand it to the pane's root pid). @cd_codex_uuid holds Codex's self-minted
// session id (captured after the first turn) — kept SEPARATE from @cd_uuid so the Claude telemetry
// path is never handed a codex uuid.
const LIST_FORMAT = '#{session_name}\t#{@cd_name}\t#{@cd_cwd}\t#{session_created}\t#{session_attached}\t#{@cd_uuid}\t#{@cd_local}\t#{@cd_local_model}\t#{@cd_codex}\t#{@cd_codex_model}\t#{@cd_codex_uuid}\t#{@cd_shell}\t#{@cd_autonomous}\t#{pane_pid}';
const PROJECTS_DIR = `${process.env.HOME || homedir()}/.claude/projects`;

// Open-URL relay: Claude Code opens links via `Bun.spawn(["xdg-open", url])`, which on this box
// opens on the GB10's own display, not the remote user's browser. We shim `xdg-open` to forward the
// URL to the loopback dashboard (→ a click-to-open toast). Two placements:
//   (a) SHIM_DIR — prepended via LAUNCH_ENV on NEW launches; only ever on a CD PATH → always relays.
//   (b) ~/.local/bin — already FIRST on ALREADY-RUNNING sessions' PATH, so this covers them too. It's
//       broadly reachable, so it's SMART: relays only from a Command Deck tmux session (cd*), else
//       execs the REAL /usr/bin/xdg-open (absolute → no recursion) so the box's desktop links work.
const SHIM_DIR = `${process.env.HOME || homedir()}/.claude/command-deck/bin`;
const LOCAL_BIN = `${process.env.HOME || homedir()}/.local/bin`;
// Claude Code injects CLAUDE_CODE_* into the env of any process it spawns. When Command Deck's
// server is (re)started from INSIDE a Claude session — e.g. `pm2 restart sysmon` typed into a CD
// terminal — pm2 captures CLAUDE_CODE_CHILD_SESSION=1 + a stale CLAUDE_CODE_SESSION_ID and re-injects
// them on every boot, so each terminal we launch would inherit them and start as a NESTED CHILD
// session. A child session writes NO top-level <id>.jsonl transcript, so telemetry reads an empty
// file and the tab work-state lights are stuck "idle" no matter what the session is doing. `env -u`
// strips the leak at the pane so every launch is a clean, transcript-writing top-level session.
const CLEAN_ENV = 'env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_TMPDIR -u AI_AGENT';
// CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1: force the CLASSIC (inline) renderer for every CD-launched
// claude, regardless of the user's global `"tui": "fullscreen"` setting. Fullscreen uses the terminal
// ALTERNATE screen, which carries no tmux scrollback (history_size stays 0) — and CD's wheel/touch
// scroll drives tmux history, so fullscreen silently kills scrolling in the browser cockpit. Inline
// keeps scrollback alive here; the user still gets fullscreen in a direct (non-CD) terminal.
const LAUNCH_ENV = `${CLEAN_ENV} CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 PATH=${SHIM_DIR}:"$PATH" BROWSER=${SHIM_DIR}/xdg-open`;
// Autonomous tabs launch skip-perms on a semi-trusted issue body. Strip the
// autonomous mint-token from THEIR env so a prompt-injected fix session can't trivially self-read it
// (echo/env/proc-self) and POST it back to mint more autonomous tabs. Reuses the CLEAN_ENV `env -u`
// idiom. Defense-in-depth, NOT a hard boundary: the tab is code execution as the host user by design, so a determined
// payload can still /proc-read sysmon (which must hold the token to validate requests) — inherent to
// loopback-not-being-an-auth-boundary. Only the AUTONOMOUS launch path is affected; every other
// launch keeps LAUNCH_ENV verbatim (byte-identical).
const AUTONOMOUS_LAUNCH_ENV = LAUNCH_ENV.replace(CLEAN_ENV, `${CLEAN_ENV} -u COMMAND_DECK_AUTONOMOUS_TOKEN`);
// Codex launches ALSO scrub CODEX_COMPANION_SESSION_ID: the codex Claude-Code plugin injects it
// into this dashboard's own process env, and inheriting it would make a CD-launched codex boot as a
// nested "companion" of our session instead of a clean top-level Codex session (same failure class
// as the CLAUDE_CODE_* leak the CLEAN_ENV scrub already fixes). The alt-screen env is harmless to
// codex (it uses the --no-alt-screen flag instead); reusing the shim PATH/BROWSER keeps open-URL
// relay identical across runtimes.
const CODEX_LAUNCH_ENV = `${CLEAN_ENV} -u CODEX_COMPANION_SESSION_ID PATH=${SHIM_DIR}:"$PATH" BROWSER=${SHIM_DIR}/xdg-open`;
// Codex 0.144.6 accepts session-only `-c hooks.…` tables, but its trust gate skips those hooks
// unless the entire invocation receives --dangerously-bypass-hook-trust. That switch also trusts
// unrelated user/project/plugin hooks, so Command Deck must not add it. Live probes on 2026-07-21
// proved both sides: the scoped hook ran with the bypass and did not run without it, while
// ~/.codex/config.toml remained byte-identical. Keep this explicit gate next to launch construction;
// when Codex gains scoped pre-trust, this is the one capability decision to replace.
const CODEX_HOOK_ENRICHMENT = Object.freeze({
  enabled: false,
  verifiedVersion: '0.144.6',
  reason: 'scoped-hooks-require-broad-trust-bypass',
});
function codexHookLaunchArgs() { return null; }
const SHIM_MARKER = '# command-deck-xdg-open-shim';
function ensureOpenUrlShim() {
  const port = Number(process.env.SYSMON_PORT) || 3000;
  const relay = `curl -s -m 3 -X POST --data-urlencode "url=$1" "http://127.0.0.1:${port}/api/openurl" >/dev/null 2>&1`;
  try {   // (a) dedicated, always-relay
    fs.mkdirSync(SHIM_DIR, { recursive: true });
    const dedicated = ['#!/bin/sh', SHIM_MARKER, '[ -z "$1" ] && exit 0', relay, 'exit 0', ''].join('\n');
    const p = path.join(SHIM_DIR, 'xdg-open');
    fs.writeFileSync(p, dedicated); fs.chmodSync(p, 0o755);
  } catch (_) {}
  try {   // (b) ~/.local/bin smart shim (covers already-running sessions); never clobber a foreign file
    const lp = path.join(LOCAL_BIN, 'xdg-open');
    const foreign = fs.existsSync(lp) && !fs.readFileSync(lp, 'utf8').includes(SHIM_MARKER);
    if (!foreign) {
      fs.mkdirSync(LOCAL_BIN, { recursive: true });
      const smart = [
        '#!/bin/sh',
        SHIM_MARKER,
        "# Relay open-URL to the user's browser when called from a Command Deck session (cd*),",
        '# otherwise behave like the real xdg-open (open on this box).',
        'sess=""',
        '[ -n "$TMUX_PANE" ] && sess=$(tmux display-message -p -t "$TMUX_PANE" \'#{session_name}\' 2>/dev/null)',
        'case "$sess" in',
        `  cd*) [ -n "$1" ] && ${relay}; exit 0 ;;`,
        'esac',
        'for real in /usr/bin/xdg-open /bin/xdg-open; do [ -x "$real" ] && exec "$real" "$@"; done',
        'exit 0',
        '',
      ].join('\n');
      fs.writeFileSync(lp, smart); fs.chmodSync(lp, 0o755);
    }
  } catch (_) {}
}
ensureOpenUrlShim();   // self-healing: rewritten on every server start

let _seq = 0;

// ---- pure helpers (unit-tested) --------------------------------------------
function isSafeId(id) { return /^cd[a-z0-9]+$/.test(String(id || '')); }
function newSessionId() { return `${PREFIX}${Date.now().toString(36)}${(_seq++).toString(36)}`; }
// The 'session' fallback is the RENAME default (an operator who clears a name keeps a name).
// createSession passes '' instead so it can tell "no label typed" apart and mint one.
function sanitizeLabel(raw, fallback = 'session') {
  return String(raw == null ? '' : raw).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, LABEL_MAX) || fallback;
}
// Runtime words for a minted tab name — the client's own RT_META labels (terminal-ui.js:149-152).
const RUNTIME_NAMES = { claude: 'Claude', local: 'Local', codex: 'Codex', shell: 'Shell' };
// Ratified lane contract e0458eff clause (e): "Empty-label creation mints a collision-free
// <Runtime> · <HH:MM> name." Before this, an unlabelled tab fell through to the literal
// 'session', so a row of new tabs was six identically-named pills. Identity comes only from the
// runtime and the creation minute — never from cwd or prompt content (same clause). A same-minute
// sibling takes the codebase's existing " vN" idiom (newtab.js bumpVersion); `taken` is finite, so
// the walk always terminates.
function mintSessionName(runtime, at, taken = []) {
  const d = at instanceof Date ? at : new Date(at);
  const base = `${RUNTIME_NAMES[runtime] || RUNTIME_NAMES.claude} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const used = new Set(taken.map((n) => String(n == null ? '' : n)));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} v${n}`)) n += 1;
  return `${base} v${n}`;
}
function sanitizePrompt(raw) {
  return String(raw == null ? '' : raw).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 16000);
}
// A session whose display name starts with "zz " is an ephemeral TEST artifact: the closetab
// integration tests label their throwaway sessions "zz closetab selftest" / "zz closetab delay".
// If such a test is interrupted between create and its finally-kill, the real tmux session it
// spawned survives on the DEFAULT socket, and because listSessions() enumerates live tmux (and
// resumeSaved() backfills anything live-but-unregistered), that orphan resurfaces as a permanent
// phantom tab. Dropping "zz " names from the live listing kills that resurrection at the read side,
// independent of the socket-isolation guard below (defence in depth — either alone fixes it).
function isEphemeralLabel(name) { return /^zz\s/i.test(String(name == null ? '' : name)); }

function dim(v, def, lo, hi) {
  if (v == null) return def;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function clampDims(cols, rows) { return { cols: dim(cols, 80, 20, 400), rows: dim(rows, 24, 5, 200) }; }

// Shell-quote a value so it survives being TYPED into the pane's shell by tmux send-keys.
// The launch string is parsed by that shell, so a baked-in prompt must be one unsplittable
// token: single-quote wrap, and close/escape/reopen on each embedded quote.
function shquote(s) { return `'${String(s == null ? '' : s).replace(/'/g, `'\\''`)}'`; }

// Local-brain API tiers. ornith:9b PROMOTED to default 2026-07-10 (broadened interactive-honesty
// eval: 0 fabrications across 4 scenarios n=8, fresh-context blind-verified; wins gate 33/36 vs 32,
// tool-chain-hash 3/3 vs 0/3, 5.6 GB vs 25 GB, coexists with the hot 70b). baseline qwen3-coder:30b
// kept as an explicit pick; glm = 2nd opinion, -next = big gun (51 GB — no 70b coexistence). The
// allowlist is load-bearing: a model tag is interpolated into a launch line that tmux TYPES into the
// pane's shell, so only these exact tags may ever pass (same posture as isSafeId for session ids).
const LOCAL_MODEL_DEFAULT = 'ornith:9b';
const LOCAL_MODELS = [LOCAL_MODEL_DEFAULT, 'qwen3-coder:30b', 'glm-4.7-flash', 'qwen3-coder-next'];
// API-boundary validation: default (or empty) normalizes to null so a baseline tab stores no
// marker anywhere — pre-picker tabs and picker-default tabs stay byte-identical.
function normalizeLocalModel(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw || raw === LOCAL_MODEL_DEFAULT) return { ok: true, model: null };
  if (LOCAL_MODELS.includes(raw)) return { ok: true, model: raw };
  return { ok: false, error: `unknown local model '${raw.slice(0, 40)}' — allowed models: ${LOCAL_MODELS.join(', ')}` };
}

// Codex model API allowlist grounded in ~/.codex/models_cache.json + config.toml. The human UI no
// longer picks models, but automation overrides remain supported. CODEX_MODEL_DEFAULT must equal
// the top-level `model =` in ~/.codex/config.toml: the default path types NO -c override and simply
// inherits that file, so a stale constant makes an explicit request for the former default vanish;
// the truth-sources test in terminal.test.js re-derives both claims from the files. Roles:
// gpt-6-astra = config default, gpt-5.6-sol = explicit prior frontier, gpt-5.6-terra = balanced override, gpt-5.6-luna =
// fast/affordable tier, gpt-5.5 = prior frontier kept as an explicit pick (same convention as the
// local picker's "prior default"). gpt-5.4-mini dropped 2026-07-16 (luna covers the light tier; no
// live tab stored it). codex-auto-review is review-only (visibility: hide) → excluded. Same
// load-bearing allowlist posture as normalizeLocalModel: the tag is interpolated into a `-c model=`
// override that tmux TYPES into the pane's shell, so only these exact tags may pass. Default (or
// empty) → null so a default codex tab stores no model marker anywhere (byte-identical to a
// pre-picker default tab).
const CODEX_MODEL_DEFAULT = 'gpt-6-astra';
const CODEX_MODELS = [CODEX_MODEL_DEFAULT, 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
function normalizeCodexModel(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw || raw === CODEX_MODEL_DEFAULT) return { ok: true, model: null };
  if (CODEX_MODELS.includes(raw)) return { ok: true, model: raw };
  return { ok: false, error: `unknown codex model '${raw.slice(0, 40)}' — allowed models: ${CODEX_MODELS.join(', ')}` };
}

// Build the `claude` launch line for a FRESH session: pinned to --effort max (Command Deck
// convention) with a deterministic --session-id. An optional initial prompt is appended as one
// shell-quoted positional arg, so a new tab can auto-start from it (used by the /handoff skill).
// `local` swaps in claude-local (qwen3-coder via Ollama's Anthropic endpoint) and drops
// --effort max — that knob shapes Anthropic-model reasoning; on a local 30B it's noise.
// `localModel` (picker) adds --model for a non-default local brain; re-checked against the
// allowlist HERE, next to the shell interpolation, not only at the API boundary.
// Extra args for a new or resumed cloud-Claude launch. The default is --effort max; an install
// on a plan without `max` overrides via COMMAND_DECK_CLAUDE_ARGS (empty string = no extra args).
// Operator-owned env, same trust level as COMMAND_DECK_CLAUDE (it is typed into the pane's shell).
const CLAUDE_ARGS = process.env.COMMAND_DECK_CLAUDE_ARGS == null ? '--effort max' : String(process.env.COMMAND_DECK_CLAUDE_ARGS).trim();
function launchCmd(uuid, prompt, local = false, localModel = null, autonomous = false) {
  const bin = local ? CLAUDE_LOCAL_BIN : CLAUDE_BIN;
  const m = local && localModel && localModel !== LOCAL_MODEL_DEFAULT && LOCAL_MODELS.includes(localModel) ? localModel : null;
  const env = (autonomous && !local) ? AUTONOMOUS_LAUNCH_ENV : LAUNCH_ENV;   // scrub token ONLY on autonomous claude
  return `${env} ${bin}${m ? ` --model ${m}` : ''}${local || !CLAUDE_ARGS ? '' : ` ${CLAUDE_ARGS}`} --session-id ${uuid}${prompt ? ` ${shquote(prompt)}` : ''}${autonomous && !local ? ' --dangerously-skip-permissions' : ''}`;
}

// Build the `codex` launch line for a FRESH interactive session. Always --no-alt-screen (inline
// mode → tmux keeps scrollback so CD's wheel/touch scroll works; codex's default alternate-screen
// TUI silently kills it — the same trap as Claude's "tui": "fullscreen"). Codex mints its OWN
// session id (there is no --session-id to pin), so reboot-resume works by CAPTURING that id after
// the first turn, not declaring one here. A non-default model rides as a `-c model="<tag>"` TOML
// override, re-checked against the allowlist next to the shell interpolation. An optional initial
// prompt is appended as one shell-quoted positional arg so a tab can auto-start from it.
// NOTE: codex self-updates via npm on launch when a newer version exists (version churn) — a
// verified update-suppression knob is a follow-up (design doc open item); the npm wrapper path is
// the stable entry point meanwhile.
function codexLaunchCmd(prompt, model = null) {
  const m = model && model !== CODEX_MODEL_DEFAULT && CODEX_MODELS.includes(model) ? model : null;
  const modelArg = m ? ` -c ${shquote(`model="${m}"`)}` : '';
  return `${CODEX_LAUNCH_ENV} ${codexBin()} --no-alt-screen${modelArg}${prompt ? ` ${shquote(prompt)}` : ''}`;
}

// Resume a captured Codex session by its self-minted uuid, inline. The session restores its own
// model/context, so no -c model here. A corrupt/absent uuid degrades to a FRESH codex launch rather
// than typing a bad resume target (a recoverable fresh session beats a dead tab). uuid is validated
// HERE, next to the interpolation — a hand-edited registry can never type an arbitrary resume arg.
function codexResumeCmd(uuid, model = null) {
  if (!/^[0-9a-f-]{36}$/i.test(String(uuid || ''))) return codexLaunchCmd('', model);   // fresh, keep the tab's model
  return `${CODEX_LAUNCH_ENV} ${codexBin()} --no-alt-screen resume ${uuid}`;               // session restores its own model
}

// Disable Nagle on the terminal transport socket. Keystrokes are tiny, latency-
// sensitive packets; with Nagle on, the kernel coalesces them and the Nagle/
// delayed-ACK interaction can add tens of ms per keystroke — felt worst on a
// high-latency WiFi link. Interactive terminals must run with TCP_NODELAY.
// Tolerates a socket without setNoDelay (test stub / half-open) so the bridge
// never throws on it.
function tuneSocket(sock) { try { if (sock && sock.setNoDelay) sock.setNoDelay(true); } catch {} return sock; }

const tmuxNewArgs = ({ id, cwd, cols, rows }) =>
  ['new-session', '-d', '-s', id, '-x', String(cols), '-y', String(rows), '-c', cwd];
const tmuxSetNameArgs = (id, label) => ['set-option', '-t', id, '@cd_name', label];
const tmuxSetCwdArgs = (id, cwd) => ['set-option', '-t', id, '@cd_cwd', cwd];
const tmuxSetUuidArgs = (id, uuid) => ['set-option', '-t', id, '@cd_uuid', uuid];
const tmuxSetLocalArgs = (id) => ['set-option', '-t', id, '@cd_local', '1'];
const tmuxSetLocalModelArgs = (id, model) => ['set-option', '-t', id, '@cd_local_model', model];
const tmuxSetCodexArgs = (id) => ['set-option', '-t', id, '@cd_codex', '1'];
const tmuxSetCodexModelArgs = (id, model) => ['set-option', '-t', id, '@cd_codex_model', model];
// Codex mints its session uuid after the first turn; the capture backfills it here so a reboot can
// `codex resume <uuid>`. Written to tmux (survives a registry loss, like the local markers).
const tmuxSetCodexUuidArgs = (id, uuid) => ['set-option', '-t', id, '@cd_codex_uuid', uuid];
// Plain-terminal lane: the tab IS the bare login shell (no agent, no launch line, no uuid).
const tmuxSetShellArgs = (id) => ['set-option', '-t', id, '@cd_shell', '1'];
const tmuxSetAutonomousArgs = (id) => ['set-option', '-t', id, '@cd_autonomous', '1'];
const tmuxSetManualArgs = (id) => ['set-option', '-t', id, 'window-size', 'manual'];
// tmux paints its own chrome (status bar, copy-mode indicator) — xterm.js can't retheme it,
// so stock tmux shows a bright-green bar / yellow copy-mode chip inside the deep-forest well.
// Colors are the well's own tokens from terminal-ui.js THEME (black / sage; lime highlight).
// Session-scoped (-t, never -g): unrelated tmux sessions keep stock defaults.
const tmuxStatusStyleArgs = (id) => ['set-option', '-t', id, 'status-style', 'bg=#243228,fg=#b9d9c4'];
const tmuxModeStyleArgs = (id) => ['set-option', '-t', id, 'mode-style', 'bg=#bfea4b,fg=#17211a'];
// Server-global: drop tmux's 500ms escape-time default so ESC/arrow/alt keys in
// Claude's TUI aren't held for half a second — the single biggest felt lag on a
// laggy link after Nagle. 10ms is safe (xterm sends each escape sequence as one
// frame, so it isn't split below the threshold).
const tmuxSetEscapeArgs = () => ['set-option', '-g', 'escape-time', '10'];
const tmuxAttachArgs = (id) => ['attach-session', '-t', id];
const tmuxKillArgs = (id) => ['kill-session', '-t', id];
const tmuxResizeArgs = (id, cols, rows) => ['resize-window', '-t', id, '-x', String(cols), '-y', String(rows)];
const tmuxListArgs = () => ['list-sessions', '-F', LIST_FORMAT];
function bringUpPlan({ id, dir, cols, rows, name, uuid, launch, runtime = 'claude', localModel = null, codexModel = null, codexUuid = null, autonomous = false }) {
  const plan = [
    tmuxNewArgs({ id, cwd: dir, cols, rows }),
    tmuxSetManualArgs(id),
    tmuxSetEscapeArgs(),
    tmuxSetNameArgs(id, name),
    tmuxSetCwdArgs(id, dir),
  ];
  if (uuid != null) plan.push(tmuxSetUuidArgs(id, uuid));
  switch (runtime) {
    case 'local':
      plan.push(tmuxSetLocalArgs(id));
      if (localModel) plan.push(tmuxSetLocalModelArgs(id, localModel));
      break;
    case 'codex':
      plan.push(tmuxSetCodexArgs(id));
      if (codexModel) plan.push(tmuxSetCodexModelArgs(id, codexModel));
      // Reboot-resume re-stamps @cd_codex_uuid: telemetry/backfill read live tmux; the old marker died
      // with the killed session, and an idle rollout can predate the revived tab.
      if (codexUuid && /^[0-9a-f-]{36}$/i.test(String(codexUuid))) plan.push(tmuxSetCodexUuidArgs(id, codexUuid));
      break;
    case 'shell':
      plan.push(tmuxSetShellArgs(id));
      break;
  }
  if (autonomous) plan.push(tmuxSetAutonomousArgs(id));
  plan.push(tmuxStatusStyleArgs(id), tmuxModeStyleArgs(id));
  // Plain-terminal tabs pass launch:null — nothing is ever typed.
  if (launch != null) plan.push(['send-keys', '-t', id, launch, 'Enter']);
  return plan;
}
// "Jump to previous input": Claude's TUI prints every SUBMITTED user message at column 0
// as "❯ <text>"; the live input box is a bare "❯ " (no text). This copy-mode regex anchors
// to line-start and demands a non-space after the prompt, so search-backward lands on real
// inputs while skipping the empty box and any stray ❯ mid-line in Claude's output. Each
// backward search walks one input older (tmux honours both the regex and the walk — verified
// live). The marker travels as ONE argv token so it can never be shell-split.
const PROMPT_SEARCH_RE = '^❯ [^ ]';
const tmuxPrevInputArgs = (id) => ['send-keys', '-t', id, '-X', 'search-backward', PROMPT_SEARCH_RE];

// ---- intervention surface: inject an operator response into a blocked session ----
// `-l` sends the text LITERALLY (no key-name lookup); `--` ends option parsing so a response
// starting with '-' is safe; the value travels as ONE argv token (execFile → never a shell).
// Enter is sent SEPARATELY after a delay: external send-keys races Claude's TUI composer, and
// an immediate Enter can submit a partial/empty line (the launch path hits the same race).
const RESPOND_ENTER_DELAY_MS = Number(process.env.COMMAND_DECK_RESPOND_DELAY_MS) || 280;
function sanitizeResponse(s) { return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 4000); }
const tmuxSendLiteralArgs = (id, text) => ['send-keys', '-t', id, '-l', '--', text];
const tmuxEnterArgs = (id) => ['send-keys', '-t', id, 'Enter'];

function parseSessions(stdout, prefix = PREFIX) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue;
    const fields = line.split('\t');
    const [name, label, cwd, created, attached, uuid, localFlag, localModel, codexFlag, codexModel, codexUuid, shellFlag, autonomousFlag, panePid] = fields;
    if (!name || !name.startsWith(prefix)) continue;   // ignore foreign tmux sessions
    if (isEphemeralLabel(label)) continue;             // drop interrupted-test artifacts so they never surface as a tab
    const isLocal = String(localFlag || '').trim() === '1';
    const isCodex = String(codexFlag || '').trim() === '1';
    const isShell = String(shellFlag || '').trim() === '1';
    const pp = Number(String(fields.length === 13 ? autonomousFlag : panePid || '').trim());
    const entry = {
      id: name,
      name: (label && label.trim()) ? label : name,
      cwd: cwd || '',
      createdAt: Number(created) * 1000 || null,
      attached: String(attached).trim() === '1',
      uuid: (uuid && uuid.trim()) ? uuid.trim() : null,
      // Brain marker lives in tmux itself (@cd_local) so a lost/backfilled registry
      // can never silently flip a local tab back to the cloud binary on resume.
      local: isLocal,
      // Picker model marker (@cd_local_model) rides the same rail; meaningless without @cd_local.
      localModel: (isLocal && localModel && localModel.trim()) ? localModel.trim() : null,
      // Codex runtime marker (@cd_codex) + its picker model + the captured self-minted session id.
      // model/uuid are meaningless without the codex flag; codexUuid is format-validated so a
      // corrupt marker can never become a `codex resume` target.
      codex: isCodex,
      codexModel: (isCodex && codexModel && codexModel.trim()) ? codexModel.trim() : null,
      codexUuid: (isCodex && codexUuid && /^[0-9a-f-]{36}$/i.test(codexUuid.trim())) ? codexUuid.trim() : null,
      // Plain-terminal marker (@cd_shell) — a bare shell tab; no agent, no uuid, no transcript.
      shell: isShell,
      autonomous: fields.length > 13 && String(autonomousFlag || '').trim() === '1',
      // Resource-attribution root; null on old/short lines — the rail load row just hides.
      panePid: Number.isInteger(pp) && pp > 0 ? pp : null,
    };
    if (runtimeConflict(entry)) console.warn(`[command-deck] session ${name} carries conflicting runtime markers`);
    out.push(entry);
  }
  return out;
}

// ---- tmux I/O (verified live) ----------------------------------------------
// Optional tmux socket isolation. When SYSMON_TMUX_SOCKET is set, every tmux call targets a PRIVATE
// server (`tmux -L <name> …`) instead of the box's default socket. Production Command Deck NEVER sets
// it (→ default socket, byte-identical behaviour). The closetab integration tests DO set it, so the
// real sessions they spawn live on a throwaway server that the production socket's listSessions() /
// resumeSaved() can never see — closing the "interrupted test leaks a real tab" class at the source.
// Read lazily per call so a test can set the env AFTER require()-ing this module (mirrors registry.file()).
function tmuxArgs(args) { const sock = process.env.SYSMON_TMUX_SOCKET || ''; return sock ? ['-L', sock, ...args] : args; }
function run(args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, tmuxArgs(args), { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && err.code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function isRealDir(cwd) { try { return !!cwd && fs.statSync(cwd).isDirectory(); } catch { return false; } }
function resolveDir(cwd) {
  const norm = (d) => String(d).replace(/\/+$/, '') || '/';   // no trailing slash → clean transcript path
  try { if (cwd && fs.statSync(cwd).isDirectory()) return norm(cwd); } catch {}
  return norm(process.env.HOME || homedir());
}

// Create the detached tmux session, pin it to manual sizing, stash its metadata as
// tmux user-options, and launch claude. Shared by create (new convo) and resume
// (existing convo) — they differ only in the launch command. `launch` is a fixed
// CLAUDE_BIN + flag + validated uuid, so nothing arbitrary is typed into the shell.
async function bringUp(opts) {
  const plan = bringUpPlan(opts);
  const created = await run(plan[0]);
  if (!created.ok) return { ok: false, error: created.stderr.trim() || 'tmux new-session failed' };
  invalidateSessions();
  for (const args of plan.slice(1)) await run(args);
  return { ok: true };
}

// ---- admission gate (NEW-cmddeck-5) ----------------------------------------
// Backpressure for session launches: don't spawn/relaunch a --effort-max Claude session when the
// box is already at its session ceiling or low on free memory. Reused by createSession (new tab)
// and resumeSaved (boot revive). Both bounds are env-tunable so the defaults can be raised.
function envInt(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;   // respects 0; ignores unset/garbage
}
// Pure decision → unit-tested. At/over the cap, or MemAvailable below the floor, refuses with a
// reason surfaced to the API/UI. Unreadable memory (memMb == null) fails OPEN on the mem bound.
function admissionDecision({ liveCount, memMb, max = envInt('SYSMON_MAX_SESSIONS', 24), floor = envInt('SYSMON_MEM_FLOOR_MB', 8000) } = {}) {
  if (Number(liveCount) >= max) return { ok: false, error: 'session cap' };
  if (memMb != null && Number(memMb) < floor) return { ok: false, error: 'low memory' };
  return { ok: true };
}
// MemAvailable (MB) from /proc/meminfo; null if unreadable (→ mem bound skipped).
function memAvailableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}
// I/O gate: count live cd-sessions (unless caller supplies the count) + read memory, then decide.
async function admissionCheck({ liveCount } = {}) {
  if (liveCount == null) liveCount = (await listSessions()).length;
  return admissionDecision({ liveCount, memMb: memAvailableMb() });
}

async function createSession({ label = '', cwd = '', cols, rows, prompt = '', local = false, localModel = '', codex = false, codexModel = '', shell = false, autonomous = false } = {}) {
  const adm = await admissionCheck();
  if (!adm.ok) return { ok: false, error: adm.error, capped: true };   // refuse BEFORE any tmux spawn
  const rt = runtimeFromFlags({ local, codex, shell });
  if (!rt.ok) return { ok: false, error: rt.error };
  const runtime = rt.runtime;
  if (autonomous && runtime !== 'claude') return { ok: false, error: 'autonomous is a claude-only capability' };
  const lm = runtime === 'local' ? normalizeLocalModel(localModel) : { ok: true, model: null };
  if (!lm.ok) return { ok: false, error: lm.error };   // refuse loudly — never fall back to a different brain silently
  const cm = runtime === 'codex' ? normalizeCodexModel(codexModel) : { ok: true, model: null };
  if (!cm.ok) return { ok: false, error: cm.error };
  const id = newSessionId();
  const { cols: c, rows: r } = clampDims(cols, rows);
  if (autonomous && !isRealDir(cwd)) return { ok: false, error: 'autonomous session requires an existing cwd' };
  const dir = resolveDir(cwd);
  // '' rather than the 'session' fallback: no typed label means MINT one from the runtime and
  // minute, checked against the names already on screen (contract e0458eff clause (e)).
  const typed = sanitizeLabel(label, '');
  const name = typed || mintSessionName(runtime, Date.now(), (await listSessions()).map((s) => s.name));
  const cleanPrompt = sanitizePrompt(prompt);
  // Claude/local tabs pin a known session id up front (→ deterministic JSONL path). Codex mints its
  // OWN id after the first turn, so a codex tab starts with NO uuid; it's captured + backfilled later.
  // A plain-terminal tab never has one — there is no conversation.
  const uuid = RUNTIMES[runtime].mintsUuidAtCreate ? crypto.randomUUID() : null;
  // Claude/local: --effort max + --session-id (the /handoff skill bakes in an optional prompt).
  // Codex: --no-alt-screen + optional -c model + optional prompt; no session-id, no effort knob.
  // Plain terminal: NO launch line at all (prompt is ignored — there is no agent to receive it).
  const launch = runtime === 'shell' ? null
    : runtime === 'codex' ? codexLaunchCmd(cleanPrompt, cm.model)
    : launchCmd(uuid, cleanPrompt, runtime === 'local', lm.model, autonomous);
  const createdAt = Date.now();
  const up = await bringUp({ id, dir, cols: c, rows: r, name, uuid, launch, runtime, localModel: lm.model, codexModel: cm.model, autonomous });
  if (!up.ok) return { ok: false, error: up.error };
  // Runtime + model markers persist so a reboot resumes the tab with the SAME runtime and model.
  const marks = RUNTIMES[runtime].marks({ localModel: lm.model, codexModel: cm.model, autonomous });
  const saved = registry.upsert({ id, label: name, cwd: dir, createdAt, ...(uuid ? { uuid } : {}), ...marks });
  invalidateSessions();
  if (!saved) console.warn(`[command-deck] registry persist failed for ${id} — tab won't survive a reboot (tmux markers still set)`);
  return { ok: true, session: { id, name, cwd: dir, cols: c, rows: r, attached: false, createdAt, ...(uuid ? { uuid } : {}), ...marks } };
}

// Re-create a saved session after a reboot and RESUME its conversation by uuid (the
// transcript on disk outlives tmux). Same cwd so claude finds the right JSONL.
// Returns {ok:true} on revive, or {ok:false, reason} where reason is 'bad-uuid' (unsafe id / bad
// uuid → nothing spawned) or 'tmux-new-session-failed' (tmux new-session errored) — so resumeSaved
// can log an HONEST per-session outcome (NEW-cmddeck-4) instead of a silent boolean.
async function resumeSession(s) {
  if (!s || !isSafeId(s.id)) return { ok: false, reason: 'bad-uuid' };
  if (runtimeConflict(s)) return { ok: false, reason: 'conflicting-runtime-markers' };
  const runtime = runtimeOf(s);
  switch (runtime) {
  // Plain-terminal resume: a fresh login shell in the same cwd. There is no conversation to
  // restore (bash history is the shell's own), so reviving the TAB is the whole contract.
  case 'shell': {
    const up = await bringUp({
      id: s.id, dir: resolveDir(s.cwd), cols: 120, rows: 34,
      name: s.label || s.id, uuid: null, runtime: 'shell', launch: null,
    });
    return up.ok ? { ok: true } : { ok: false, reason: 'tmux-new-session-failed' };
  }
  // Codex resume: reboot the tab and `codex resume <captured-uuid>`. If the uuid was never captured
  // (the tab never took its first turn before the reboot) codexResumeCmd falls back to a FRESH codex
  // in the same cwd + model — the tab persists even when the conversation can't (honest degradation).
  case 'codex': {
    const cm = s.codexModel && s.codexModel !== CODEX_MODEL_DEFAULT && CODEX_MODELS.includes(s.codexModel) ? s.codexModel : null;
    const up = await bringUp({
      id: s.id, dir: resolveDir(s.cwd), cols: 120, rows: 34,
      name: s.label || s.id, uuid: null, runtime: 'codex', codexModel: cm, codexUuid: s.codexUuid,
      launch: codexResumeCmd(s.codexUuid, cm),
    });
    return up.ok ? { ok: true } : { ok: false, reason: 'tmux-new-session-failed' };
  }
  case 'local':
  case 'claude':
  if (!/^[0-9a-f-]{36}$/i.test(s.uuid || '')) return { ok: false, reason: 'bad-uuid' };
  if (s.autonomous && !isRealDir(s.cwd)) return { ok: false, reason: 'autonomous-cwd-missing' };
  // Same allowlist at resume: a hand-edited/corrupt registry entry must never type an arbitrary
  // tag into the shell. Unknown model → resume on the default local brain, loudly (a wrong-model
  // local resume is recoverable; a refused tab is lost).
  const lm = runtime === 'local' && s.localModel && s.localModel !== LOCAL_MODEL_DEFAULT && LOCAL_MODELS.includes(s.localModel) ? s.localModel : null;
  if (runtime === 'local' && s.localModel && !lm && s.localModel !== LOCAL_MODEL_DEFAULT) {
    console.warn(`[command-deck] resume ${s.id}: unknown localModel '${String(s.localModel).slice(0, 40)}' — resuming on ${LOCAL_MODEL_DEFAULT}`);
  }
  const up = await bringUp({
    id: s.id, dir: resolveDir(s.cwd), cols: 120, rows: 34,
    name: s.label || s.id, uuid: s.uuid, runtime, localModel: lm, launch: runtime === 'local'
      ? `${LAUNCH_ENV} ${CLAUDE_LOCAL_BIN}${lm ? ` --model ${lm}` : ''} --resume ${s.uuid}`
      : `${s.autonomous ? AUTONOMOUS_LAUNCH_ENV : LAUNCH_ENV} ${CLAUDE_BIN}${CLAUDE_ARGS ? ` ${CLAUDE_ARGS}` : ''} --resume ${s.uuid}${s.autonomous ? ' --dangerously-skip-permissions' : ''}`,
    autonomous: s.autonomous,
  });
  return up.ok ? { ok: true } : { ok: false, reason: 'tmux-new-session-failed' };
  default:
    return { ok: false, reason: 'unknown-runtime' };
  }
}

const RESUME_STAGGER_MS = Number(process.env.COMMAND_DECK_RESUME_STAGGER_MS) || 1500;
// Settle window before the post-resume liveness count (see the tail of _resumeSavedImpl).
const RESUME_VERIFY_MS = Number(process.env.COMMAND_DECK_RESUME_VERIFY_MS) || 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run once at server startup. On a normal restart tmux sessions are still alive, so
// every saved id is "live" and this no-ops. After a REBOOT tmux is empty, so each
// saved session is re-created + resumed (staggered to avoid a thundering herd).
let _resuming = false;   // single in-flight guard shared by the boot resume AND the watchdog
async function resumeSaved() {
  if (_resuming) return { resumed: 0, total: registry.readAll().length, skipped: 'in-progress' };
  _resuming = true;
  try { return await _resumeSavedImpl(); } finally { _resuming = false; }
}
async function _resumeSavedImpl() {
  const liveList = await listSessions();
  const live = new Set(liveList.map((x) => x.id));
  // Backfill: persist any running session not yet in the registry (covers sessions that
  // predate the registry, so they too survive the NEXT reboot).
  const known = new Set(registry.readAll().map((s) => s.id));
  for (const s of liveList) {
    if (known.has(s.id)) continue;
    if (runtimeConflict(s)) {
      console.warn(`[command-deck] live session ${s.id} carries conflicting runtime markers — refusing backfill`);
      continue;
    }
    const runtime = runtimeOf(s);
    switch (runtime) {
    case 'claude':
    case 'local':
      if (!/^[0-9a-f-]{36}$/i.test(s.uuid || '')) break;
      // Preserve the brain markers read from tmux (@cd_local + @cd_local_model) — a backfilled
      // LOCAL tab must never silently resume on the cloud binary (or the wrong local model)
      // after a registry loss.
      registry.upsert({ id: s.id, label: s.name, cwd: s.cwd, uuid: s.uuid, createdAt: s.createdAt || Date.now(), ...RUNTIMES[runtime].marks(s) });
      break;
    case 'codex':
      // A live codex tab (its self-minted uuid may not be captured yet — that backfills on the next
      // telemetry poll). The runtime marker is what must survive a registry loss so a reboot resumes
      // it as codex, never as a cloud-claude tab.
      registry.upsert({ id: s.id, label: s.name, cwd: s.cwd, createdAt: s.createdAt || Date.now(), ...RUNTIMES[runtime].marks(s) });
      break;
    case 'shell':
      // A live plain-terminal tab: no uuid ever exists, so the runtime marker alone is what makes a
      // reboot revive it as a shell instead of dropping it (or worse, resuming it as claude).
      registry.upsert({ id: s.id, label: s.name, cwd: s.cwd, createdAt: s.createdAt || Date.now(), ...RUNTIMES[runtime].marks(s) });
      break;
    default:
      break;
    }
  }
  // Resume: saved sessions that aren't running (after a reboot tmux is empty → resume the rest,
  // gated by MEMORY ONLY — these sessions were already admitted once, so a restart must never drop
  // them on a session-count cap; we stop relaunching only when MemAvailable falls below the floor).
  // Each non-revive is console.warn'd with an HONEST reason (skipped: mem/bad-uuid; failed: tmux).
  const saved = registry.readAll();
  const launched = [];
  let liveCount = liveList.length;   // running total (feeds the memory-gated staggered relaunch)
  for (const s of saved) {
    if (live.has(s.id)) continue;    // already running → nothing to revive
    const adm = admissionDecision({ liveCount, memMb: memAvailableMb(), max: Infinity }); // resume = memory-only
    if (!adm.ok) { console.warn(`[command-deck] resume skipped ${s.id}: ${adm.error}`); continue; }
    const r = await resumeSession(s);
    if (r.ok) { launched.push(s.id); liveCount++; await sleep(RESUME_STAGGER_MS); }
    else console.warn(`[command-deck] resume ${r.reason === 'bad-uuid' ? 'skipped' : 'failed'} ${s.id}: ${r.reason}`);
  }
  // Count VERIFIED-live tabs, not launches issued. 2026-09-01 12:29 reboot: tmux's socket dir was
  // gone, `new-session` still exited 0 for every saved tab, none stayed up, and the self-heal loop
  // logged "re-revived 7/7" every 15s for ~20 minutes — its 0-revived backoff keys on this count
  // and never engaged. A launch counts only if tmux still lists it after a short settle window
  // (a tmux-level check: deterministic, no probing of the claude process itself). If that probe is
  // itself untrustworthy we return the issued count and say so (verified:false) rather than guess.
  let resumed = launched.length, verified = true;
  if (launched.length) {
    await sleep(RESUME_VERIFY_MS);
    invalidateSessions();
    const probe = await probeLive();
    if (probe.trustworthy) resumed = launched.filter((id) => probe.ids.has(id)).length;
    else verified = false;
  }
  return { resumed, issued: launched.length, total: saved.length, verified };
}
// One-line suffix for the boot + self-heal log lines: what the revived count does NOT include.
function resumeSummary(r) {
  const died = (r.issued || 0) - (r.resumed || 0);
  return (died > 0 ? ` — ${died} launched but not live after ${RESUME_VERIFY_MS}ms` : '')
    + (r.verified === false ? ' (unverified: tmux probe failed)' : '');
}

// ── self-heal watchdog (reboot recovery, NEW-cmddeck-6) ─────────────────────
// resumeSaved() runs ONCE at startup, so a tmux server that dies AFTER startup (e.g. the
// one-time graphical-login churn on the first post-reboot boot) leaves every tab dead with no
// recovery until sysmon is restarted. This watchdog closes that gap: on TRUSTWORTHY TOTAL death
// (the registry lists tabs but a probe shows zero live AND the probe is reliable) it re-runs the
// idempotent resumeSaved(). Total-death-only means a partial loss (>=1 live) never triggers it,
// so a single tab whose claude keeps exiting can never drive a respawn loop.
const _selfhealRaw = (process.env.COMMAND_DECK_SELFHEAL_MS || '').trim();
const _selfhealNum = _selfhealRaw === '' ? NaN : Number(_selfhealRaw);   // empty/blank → default (not 0/off)
const SELFHEAL_INTERVAL = !Number.isFinite(_selfhealNum) ? 15000          // unset/garbage → 15s default
  : _selfhealNum <= 0 ? 0                                                 // 0 or negative → disabled
  : Math.min(Math.max(Math.floor(_selfhealNum), 1000), 2147483647);       // else clamp to a sane [1s, ~24.8d]

// Pure decision (unit-tested). Heal iff: the probe is TRUSTWORTHY (a transient tmux error must
// never be read as "down"), saved tabs exist, none are live, no resume is already in flight, and
// we're not backing off after an unproductive heal (an all-unrevivable registry must not loop).
function shouldSelfHeal({ savedCount, liveCount, trustworthy, healing, backoff }) {
  return !!trustworthy && !healing && !backoff && Number(savedCount) > 0 && Number(liveCount) === 0;
}

// Probe tmux for live cd-sessions, separating a TRUSTWORTHY answer (server replied, or clearly
// reported "no server"/"no sessions") from a TRANSIENT failure (5s timeout / fork EAGAIN under
// memory pressure). Only a trustworthy zero is real total death; a transient error returns
// trustworthy:false so the watchdog holds instead of crying "server down" + doing wasted work.
async function probeLive() {
  const r = await run(tmuxListArgs());
  if (r.ok) { const live = parseSessions(r.stdout); return { trustworthy: true, liveCount: live.length, ids: new Set(live.map((s) => s.id)) }; }
  const down = /no server running|no sessions|error connecting|No such file or directory/i.test(String(r.stderr || ''));
  return { trustworthy: down, liveCount: 0, ids: new Set() };
}

let _backoff = false;   // set after a heal that revives nothing; cleared once the server is live again
// One watchdog tick. resumeSaved() self-serialises via its own in-flight guard, so we pass _resuming
// as `healing` only to skip a redundant "server down" log during the boot-resume window. The heal
// story goes to stdout (alongside the other CD lifecycle lines), not stderr.
async function selfHealTick() {
  let savedCount = 0;
  try { savedCount = registry.readAll().length; } catch { return; }   // no registry → nothing to heal
  if (savedCount === 0) return;                                        // no saved tabs → skip the tmux probe
  let probe;
  try { probe = await probeLive(); } catch { return; }
  if (probe.trustworthy && probe.liveCount > 0) _backoff = false;      // recovered by any means → re-arm
  if (!shouldSelfHeal({ savedCount, liveCount: probe.liveCount, trustworthy: probe.trustworthy, healing: _resuming, backoff: _backoff })) return;
  console.log(`[command-deck] self-heal: tmux server is down (${savedCount} saved tab(s), 0 live) — re-reviving`);
  try {
    const r = await resumeSaved();
    if (r.skipped) return;                                             // a resume was already running → not our verdict
    console.log(`[command-deck] self-heal: resumeSaved re-revived ${r.resumed}/${r.total}${resumeSummary(r)}`);
    if (!(r.resumed > 0)) { _backoff = true; console.warn('[command-deck] self-heal: 0 tabs revived — backing off until the server is live again'); }
  } catch (e) {
    console.error('[command-deck] self-heal: resumeSaved failed:', e && e.message);
  }
}

// Start the periodic watchdog; returns the timer (or null if disabled via COMMAND_DECK_SELFHEAL_MS<=0).
// NOT unref'd on purpose: the HTTP server already holds the event loop open, and the watchdog must
// keep ticking for the life of the process. Started once at boot, right after the startup resume.
function startSelfHealWatchdog(intervalMs = SELFHEAL_INTERVAL) {
  if (!(intervalMs > 0)) return null;
  return setInterval(() => { selfHealTick().catch(() => {}); }, intervalMs);
}

// Resolve a session's transcript JSONL: <projects>/<munged-cwd>/<uuid>.jsonl.
// Returns null if we can't (yet) — claude writes the file on first turn.
function transcriptPath(cwd, uuid) {
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) return null;
  return path.join(PROJECTS_DIR, mungeCwd(cwd), `${uuid}.jsonl`);
}

// The raw listing: one tmux spawn + a sync registry read + the registry-order sort.
// ok mirrors the tmux result so the cache can refuse to memoize failures — a resolved
// EAGAIN/timeout under memory pressure must never pin an empty fleet for the TTL
// (spec §4, R1-F1). tmux's legit "no server running" empty state is also !ok and
// therefore uncached; with zero sessions there is no poll fan-out, so the extra
// spawns match HEAD's baseline.
async function _listSessionsRaw() {
  const r = await run(tmuxListArgs());
  if (!r.ok) return { ok: false, sessions: [] };
  const live = parseSessions(r.stdout);
  const order = registry.readAll().map((s) => s.id);
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return { ok: true, sessions: live.sort((a, b) => rank(a.id) - rank(b.id)) };
}
const _sessionsCache = createTtlCache(_listSessionsRaw, {
  ttlMs: envInt('COMMAND_DECK_SESSIONS_TTL_MS', 1000),
  cacheIf: (r) => r.ok,
});
async function listSessions() { return (await _sessionsCache.get()).sessions ?? []; }
// Every in-process mutation busts the memo; external writers (tmux CLI, closetab —
// a separate process) are bounded by the TTL, and the four cwd-authorizing routes
// re-verify liveness server-side (spec §2/§4).
function invalidateSessions() { _sessionsCache.invalidate(); }

// Persist a new tab order (drag-to-reorder). Ids are validated; the registry array
// order is the source of truth that listSessions sorts by.
function reorder(ids) {
  if (!Array.isArray(ids)) return { ok: false };
  registry.reorder(ids.filter((x) => isSafeId(x)));
  invalidateSessions();
  return { ok: true };
}
async function hasSession(id) { return isSafeId(id) && (await run(['has-session', '-t', id])).ok; }
async function killSession(id) {
  if (!isSafeId(id)) return { ok: false, error: 'bad id' };
  const r = await run(tmuxKillArgs(id));
  const gone = r.ok || !(await hasSession(id));
  if (gone) registry.remove(id);
  invalidateSessions();
  return gone ? { ok: true } : { ok: false, error: (r.stderr || '').trim() || 'kill failed; session still live' };
}
async function renameSession(id, label) {
  if (!isSafeId(id)) return { ok: false };
  const name = sanitizeLabel(label);
  registry.setLabel(id, name);                  // persist the new name across reboot
  const r = await run(tmuxSetNameArgs(id, name));
  invalidateSessions();
  return r;
}
// Inject an operator response into a blocked session's pane and submit it — the intervention
// surface for answering an AskUserQuestion / approving an ExitPlanMode from the cockpit without
// attaching the xterm. Literal text, then a delayed Enter (composer race). Returns {ok,error}.
async function respond(id, text, opts = {}) {
  if (!isSafeId(id)) return { ok: false, error: 'bad session id' };
  const body = sanitizeResponse(text);
  if (!body) return { ok: false, error: 'empty response' };
  if (!(await hasSession(id))) return { ok: false, error: 'unknown session' };
  const sent = await run(tmuxSendLiteralArgs(id, body));
  if (!sent.ok) return { ok: false, error: (sent.stderr || '').trim() || 'send-keys failed' };
  await sleep(RESPOND_ENTER_DELAY_MS);          // let the TUI accept the text before submitting
  await run(tmuxEnterArgs(id));
  if (opts.multiSelect) {
    // Text+Enter only CHECKS the matching option in a multiSelect dialog; the dialog then
    // waits on its Submit control (top strip, reached with Right). Without this the ask
    // stays open forever (observed live 2026-08-16). Harmless if the dialog already closed:
    // Right is a no-op in the composer and the bare Enter submits an empty composer line.
    await sleep(RESPOND_ENTER_DELAY_MS);
    await run(['send-keys', '-t', id, 'Right']);
    await sleep(RESPOND_ENTER_DELAY_MS);
    await run(tmuxEnterArgs(id));
  }
  return { ok: true };
}
// Set a pty's winsize via stty (no native deps). The tty comes from tmux's own
// #{client_tty} and is format-validated, so nothing arbitrary reaches execFile.
function sttySize(tty, cols, rows) {
  return new Promise((resolve) => {
    execFile('stty', ['-F', tty, 'rows', String(rows), 'cols', String(cols)], { timeout: 3000 }, (err) => resolve(!err));
  });
}
// A window drag sends one resize per animation frame and the WS bridge fires each without awaiting.
// Every apply is three async spawns with no ordering between calls, so a straggler from mid-drag could
// land AFTER the final size and leave the window or the attached client at a stale mid-drag size while
// xterm sat at the final one (seen live 2026-09-01: client 89x28 vs xterm+window 81x31 — text drawn
// against the wrong geometry until the next resize). One apply in flight per session; a newer request
// replaces the pending one (latest wins), so the last size asked for is always the last one applied.
const resizeQueue = new Map();   // id -> { pending: {cols, rows} | null, running: Promise | null }
function resize(id, cols, rows) {
  if (!isSafeId(id)) return Promise.resolve({ ok: false });
  let q = resizeQueue.get(id);
  if (!q) { q = { pending: null, running: null }; resizeQueue.set(id, q); }
  q.pending = clampDims(cols, rows);
  if (!q.running) {
    q.running = (async () => {
      let res = { ok: false };
      while (q.pending) { const { cols: c, rows: r } = q.pending; q.pending = null; res = await applyResize(id, c, r); }
      resizeQueue.delete(id);
      return res;
    })();
  }
  return q.running;
}
async function applyResize(id, c, r) {
  const res = await run(tmuxResizeArgs(id, c, r));
  // tmux draws to a NORMAL client at that client's terminal size, not the window size.
  // The attach PTY (util-linux `script`) is a fixed 80x24, so resize-window alone leaves
  // the render clipped to 80x24 in the top-left of a larger xterm (the "stuck in a corner"
  // bug). Push the new size onto each attached client's pty via stty → SIGWINCH → tmux
  // redraws full-size to it. #{client_tty} is validated to /dev/pts/N before use.
  const clients = await run(['list-clients', '-t', id, '-F', '#{client_tty}']);
  if (clients.ok) {
    await Promise.all(
      clients.stdout.split('\n').map((s) => s.trim())
        .filter((tty) => /^\/dev\/pts\/\d+$/.test(tty))
        .map((tty) => sttySize(tty, c, r)),
    );
  }
  return res;
}

// Scrollback lives in tmux (the attach uses tmux's alternate screen), so scrolling is
// driven through tmux copy-mode rather than the browser. State for the scrollbar/jump
// button: in-copy-mode?, lines scrolled up from bottom, total history, viewport height.
async function scrollState(id) {
  if (!isSafeId(id)) return { ok: false };
  const r = await run(['display-message', '-p', '-t', id, '#{pane_in_mode}|#{scroll_position}|#{history_size}|#{pane_height}']);
  if (!r.ok) return { ok: false };
  const [m, pos, hist, ph] = r.stdout.trim().split('|');
  return { ok: true, inMode: m === '1', pos: Number(pos) || 0, hist: Number(hist) || 0, height: Number(ph) || 0 };
}
// Drive a scroll: 'bottom' returns to live; 'goto' jumps to an absolute line up from the
// bottom; 'up'/'down' nudge by n lines; 'previnput' jumps backward to the previous Claude
// user input (each call walks one older). Enters copy-mode as needed; n is clamped.
async function scrollOp(id, op, n) {
  if (!isSafeId(id)) return { ok: false };
  const lines = Math.max(0, Math.floor(Number(n) || 0));
  if (op === 'bottom') { await run(['send-keys', '-t', id, '-X', 'cancel']); return { ok: true }; }
  // -e: scroll-down reaching the bottom EXITS copy-mode natively. Without it, exit relied on the
  // client posting a separate 'bottom' op — droppable when two browser windows share one tmux
  // session's scroll state, leaving pane_in_mode=1 at pos 0: a frozen "live" view that eats wheel
  // input (2026-07-16 incident). No-op if already in copy-mode.
  await run(['copy-mode', '-e', '-t', id]);
  if (op === 'goto') await run(['send-keys', '-t', id, '-X', 'goto-line', String(lines)]);
  else if (op === 'up' || op === 'down') await run(['send-keys', '-t', id, '-X', '-N', String(Math.max(1, lines || 1)), op === 'up' ? 'scroll-up' : 'scroll-down']);
  else if (op === 'previnput') await run(tmuxPrevInputArgs(id));
  else return { ok: false };
  return { ok: true };
}

// Dump the pane's scrollback as plain text for the "Copy text" panel. Claude's TUI runs on the
// NORMAL screen (alternate_on=0), so tmux keeps real history; -S -8000 grabs up to 8000 lines back
// through the visible bottom, -J joins soft-wrapped lines so a long line copies as one, and no -e
// means no color escapes — just text. Trailing pad/blank lines are trimmed for a clean copy.
async function captureScrollback(id) {
  if (!isSafeId(id)) return { ok: false, error: 'bad session id' };
  const r = await run(['capture-pane', '-p', '-J', '-t', id, '-S', '-8000']);
  if (!r.ok) return { ok: false, error: (r.stderr || '').trim() || 'capture failed' };
  const text = String(r.stdout || '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  return { ok: true, text, lines: text ? text.split('\n').length : 0 };
}

// ── Codex resume-uuid capture (backfill) ────────────────────────────────────
// Codex writes its rollout — and thus reveals its self-minted session id — only AFTER the tab takes
// its first turn. The server calls this each telemetry tick for a codex tab that has no uuid yet;
// once the rollout appears we stamp the id into tmux (@cd_codex_uuid — survives a registry loss) and
// the registry, so a reboot can `codex resume <uuid>`. `allSessions` supplies the claimed-uuid set
// that disambiguates two codex tabs sharing a cwd. Best-effort: returns the captured uuid or null.
function captureMs(envName, fallback) {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const CODEX_CAPTURE_WINDOW_MS = captureMs('COMMAND_DECK_CODEX_CAPTURE_WINDOW_MS', 300000);
const CODEX_CAPTURE_NEAR_TIE_MS = captureMs('COMMAND_DECK_CODEX_CAPTURE_NEAR_TIE_MS', 1000);

async function backfillCodexUuid(session, allSessions = [], deps = {}) {
  if (!session || runtimeConflict(session) || runtimeOf(session) !== 'codex' || session.codexUuid || !isSafeId(session.id)) return null;
  const reg = deps.registry || registry;
  let saved = [];
  try { saved = reg.readAll(); } catch {}
  const savedById = new Map((Array.isArray(saved) ? saved : []).map((s) => [s && s.id, s]));
  const anchorFor = (s) => {
    const savedSession = savedById.get(s && s.id);
    const anchor = Number((savedSession && savedSession.createdAt) || (s && s.createdAt));
    return Number.isFinite(anchor) && anchor > 0 ? anchor : null;
  };
  const anchor = anchorFor(session);
  if (anchor == null) return null;
  const claimed = new Set(allSessions.map((x) => x && x.codexUuid).filter(Boolean));
  const listCandidates = deps.listCodexSessionCandidates || listCodexSessionCandidates;
  const rawCandidates = listCandidates({ cwd: session.cwd, sinceMs: anchor, claimed }, deps.base);
  const candidates = Array.isArray(rawCandidates) ? rawCandidates
    .filter((c) => c && /^[0-9a-f-]{36}$/i.test(c.uuid || '') && Number.isFinite(c.startMs)) : [];
  if (!candidates.length) return null;
  const ranked = candidates.map((candidate) => ({ ...candidate, distance: Math.abs(candidate.startMs - anchor) }))
    .sort((a, b) => a.distance - b.distance || a.startMs - b.startMs || a.uuid.localeCompare(b.uuid));
  const best = ranked[0];
  const windowMs = deps.captureWindowMs == null ? CODEX_CAPTURE_WINDOW_MS : deps.captureWindowMs;
  const nearTieMs = deps.nearTieMs == null ? CODEX_CAPTURE_NEAR_TIE_MS : deps.nearTieMs;
  if (best.distance > windowMs) return null;
  if (ranked[1] && ranked[1].distance - best.distance <= nearTieMs) return null;
  const cohort = allSessions.filter((s) => s && s !== session && !runtimeConflict(s) && runtimeOf(s) === 'codex' && !s.codexUuid && s.cwd === session.cwd);
  for (const sibling of cohort) {
    const siblingAnchor = anchorFor(sibling);
    if (siblingAnchor == null || Math.abs(best.startMs - siblingAnchor) <= best.distance) return null;
  }
  const runner = deps.run || run;
  await runner(tmuxSetCodexUuidArgs(session.id, best.uuid));    // tmux marker (registry-loss durable)
  reg.upsert({ id: session.id, codexUuid: best.uuid });          // merges — preserves label/cwd/codex/model
  invalidateSessions();
  session.codexUuid = best.uuid;                                 // patch this listSessions snapshot before the next sibling
  return best.uuid;
}

module.exports = {
  PREFIX, TMUX_BIN, CLAUDE_BIN, codexBin, LIST_FORMAT,
  LOCAL_MODEL_DEFAULT, LOCAL_MODELS, normalizeLocalModel,
  CODEX_MODEL_DEFAULT, CODEX_MODELS, normalizeCodexModel,
  CODEX_HOOK_ENRICHMENT, codexHookLaunchArgs,
  LABEL_MAX, isSafeId, newSessionId, sanitizeLabel, mintSessionName, sanitizePrompt, isEphemeralLabel, tmuxArgs, clampDims, tuneSocket, shquote, launchCmd, codexLaunchCmd, codexResumeCmd,
  tmuxNewArgs, tmuxSetNameArgs, tmuxSetCwdArgs, tmuxSetUuidArgs, tmuxSetLocalArgs, tmuxSetLocalModelArgs, tmuxSetManualArgs, tmuxSetEscapeArgs,
  tmuxSetCodexArgs, tmuxSetCodexModelArgs, tmuxSetCodexUuidArgs, tmuxSetShellArgs, tmuxSetAutonomousArgs,
  tmuxStatusStyleArgs, tmuxModeStyleArgs,
  tmuxAttachArgs, tmuxKillArgs, tmuxResizeArgs, tmuxListArgs, bringUpPlan, parseSessions, transcriptPath,
  PROMPT_SEARCH_RE, tmuxPrevInputArgs,
  sanitizeResponse, tmuxSendLiteralArgs, tmuxEnterArgs, respond,
  createSession, listSessions, invalidateSessions, hasSession, killSession, renameSession, resize,
  resolveDir, resumeSession, resumeSaved, resumeSummary, reorder, scrollState, scrollOp, captureScrollback, backfillCodexUuid,
  admissionDecision, admissionCheck, memAvailableMb,
  shouldSelfHeal, startSelfHealWatchdog,
};
