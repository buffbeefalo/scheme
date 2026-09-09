'use strict';

// Pure analyzer: a Claude Code session JSONL transcript → the telemetry the Studio
// rail renders (model, automode, tokens, active plugins/skills, Codex activity).
// No I/O — server.js reads the file and hands the text/lines here, so this stays
// unit-testable. Field shapes verified against real transcripts.

// Claude Code stores a transcript under a directory derived from the session's cwd.
// Remove trailing slashes, then replace '/', '.' and '_' with '-'. For example,
// /home/you/projects/sample_app becomes -home-you-projects-sample-app.
// Keeping underscores would point telemetry at a directory that does not exist.
function mungeCwd(cwd) { return String(cwd || '').replace(/\/+$/, '').replace(/[/._]/g, '-'); }

function MODEL_SHORT(model) { return model ? String(model).replace(/^claude-/, '') : null; }

// Codex is dispatched as the Agent tool with a codex:* subagent_type; the rescue
// forwarder's prompt carries --background/--wait, which tells us how it was used.
function codexMode(prompt) {
  const p = String(prompt || '');
  if (/--background\b/.test(p)) return 'background';
  if (/--wait\b/.test(p)) return 'foreground';
  return 'foreground';
}

// Tools that touch a file on disk — used to build the Studio "Changes" panel.
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Tools that READ a file — the rail's digest shows what a research-heavy session is working
// over (readFiles), separately from what it mutated (recentFiles).
const FILE_READ_TOOLS = new Set(['Read', 'NotebookRead']);

// Named tools that BLOCK the turn waiting on the user (vs. a tool that's merely running):
// AskUserQuestion (pick an option / add notes) and ExitPlanMode (approve the plan). Both
// sit at the same stop_reason ('tool_use') as a running Bash/Edit, so the stop reason can't
// tell "waiting on you" from "working" — only the tool NAME can. → drives the needs-input light.
const BLOCKING_ASK_TOOLS = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };

// Pull a blocking ask's payload so the 2-minute auto-answer (server) can assess a choice. Bounded —
// just the question text + option labels/descriptions (AskUserQuestion) or a truncated plan (ExitPlanMode).
function extractAsk(name, input) {
  const inp = input || {};
  if (name === 'AskUserQuestion') {
    const qs = Array.isArray(inp.questions) ? inp.questions : [];
    return { kind: 'question', questions: qs.slice(0, 4).map((q) => ({
      question: String((q && q.question) || '').slice(0, 500),
      header: String((q && q.header) || '').slice(0, 40),
      multiSelect: !!(q && q.multiSelect),
      options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 8).map((op) => ({
        label: String((op && op.label) || '').slice(0, 200),
        description: String((op && op.description) || '').slice(0, 300),
      })),
    })) };
  }
  if (name === 'ExitPlanMode') return { kind: 'plan', plan: String(inp.plan || '').slice(0, 4000) };
  return null;
}

function analyzeTranscript(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split('\n');
  const t = {
    model: null, modelShort: null, automode: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, context: 0 },
    plugins: [], skills: [], codex: [], tools: {}, lastActivity: null,
    lastTool: null, lastToolAt: null, recentFiles: [], readFiles: [], todos: [], tasks: [], tasksPartial: false,
    turns: 0, working: false, lastTurnId: null,
    needsInput: false, needsInputKind: null, pendingAsk: null,
    pendingBg: 0, waitingOnBackground: false, stateSince: null,
  };
  const plugins = new Set(), skills = new Set();
  const fileHits = [], readHits = []; let latestTodos = null;
  // Harness task list (TaskCreate/TaskUpdate — TodoWrite's successor). Creates are tracked by
  // tool_use id until their tool_result announces the assigned number ("Task #N created…");
  // updates address tasks by that number. Best-effort within the read tail: an update whose
  // create scrolled out is skipped (unknown id), a create whose result hasn't landed yet lists
  // with id null.
  const taskByUse = new Map(), taskById = new Map(), taskList = [];
  let turns = 0, lastTurnId = null;   // tail-window turn count + latest end_turn identity
  // Working-state machine for the tab lights. Each message-bearing line flips it:
  //   working ← assistant stop_reason 'tool_use' (a tool is running), an assistant entry with
  //             no stop yet (mid-response), a real user prompt (the model is thinking — covers
  //             the gap before its first tool call), or a tool_result (the model continues).
  //   idle    ← assistant with any FINAL stop ('end_turn', 'max_tokens', …) or an interrupt
  //             marker ('[Request interrupted…' — Esc leaves no end_turn behind).
  // Bookkeeping lines (last-prompt, ai-title, mode…) and isMeta user lines don't touch it.
  let working = false;
  // Needs-input machine (same forward pass): a BLOCKING_ASK tool_use raises it; any final
  // assistant stop, any real user/tool response, or an interrupt lowers it. The last event
  // in the tail wins → an unanswered ask ends raised, a running Bash never raises it.
  let needsInput = false, needsInputKind = null, pendingAsk = null;
  // Background-task tracking for the "waiting on a subagent/workflow" tab light. A background launch
  // (Workflow / background Agent / background Bash) returns a tool_result carrying "Task ID: <id>"; the
  // harness later enqueues a <task-notification> with that <task-id> + a terminal <status>. Pairing by
  // id (not a fragile substring count) is immune to tool-schema/prose text that merely QUOTES these markers.
  const pendingTasks = new Set();
  // tool_use ids of REAL background launches in THIS transcript. A "Task ID: X" is only counted when its
  // tool_result pairs (by tool_use_id) to one of these — so a Bash/grep whose OUTPUT merely PRINTS a
  // "launched in background… Task ID:" line (e.g. dumping another transcript) can never inflate the count.
  const bgUseIds = new Set();
  // Current-state DURATION (council a6363f19 §c). The switcher must say how long the session has
  // been in the state it is showing — a different fact from session age, and the one the council
  // forbade faking. The tail can only prove it by WITNESSING the transition, so stateSince is
  // stamped from the timestamp of the line that CHANGED the derived state. It stays null when the
  // read window opens mid-state (the establishing event may have scrolled out of the tail) or when
  // that line carries no parseable timestamp. Never mtime, never session creation, never now().
  let stateSince = null, curState = null;
  const noteState = (ts) => {
    const st = needsInput ? 'needs-input'
      : (!working && pendingTasks.size > 0) ? 'waiting'
        : working ? 'busy' : 'idle';
    if (st === curState) return;
    stateSince = curState === null || typeof ts !== 'string' || !Number.isFinite(Date.parse(ts)) ? null : ts;
    curState = st;
  };

  for (const raw of lines) {
    let o = raw;
    if (typeof raw === 'string') { const s = raw.trim(); if (!s) continue; try { o = JSON.parse(s); } catch { continue; } }
    if (!o || typeof o !== 'object') continue;

    // Background-task COMPLETION arrives as a harness "queue-operation" line (no .message) carrying the
    // task id + a terminal status → clear it from pendingTasks so the waiting light goes out. Handle here,
    // before the `!m` guard below drops these message-less lines.
    if (o.type === 'queue-operation' && typeof o.content === 'string' && o.content.indexOf('<task-notification>') !== -1) {
      const idm = o.content.match(/<task-id>([^<]+)<\/task-id>/);
      if (idm && /<status>\s*(completed|failed|error|killed|cancelled|canceled|stopped|timed_out|timeout)\b/i.test(o.content)) {
        pendingTasks.delete(idm[1].trim());
        noteState(o.timestamp);   // clearing the last background task can end a 'waiting' state
      }
    }

    if (o.permissionMode) t.automode = o.permissionMode;
    if (o.attributionPlugin) plugins.add(o.attributionPlugin);
    if (o.attributionSkill) skills.add(o.attributionSkill);
    if (o.timestamp) t.lastActivity = o.timestamp;

    const m = o.message;
    if (!m || typeof m !== 'object') continue;
    if (m.model) { t.model = m.model; t.modelShort = MODEL_SHORT(m.model); }
    if (m.role === 'assistant') {
      // stop_reason rides on assistant messages: 'end_turn' = a completed turn (the ground-truth
      // "done" signal — immune to replay/echo/pauses); 'tool_use' = mid-turn (a tool is running).
      working = m.stop_reason == null || m.stop_reason === 'tool_use';
      // A real final stop (end_turn, max_tokens, …) ends any pending ask. 'tool_use' does
      // NOT — that's the ask itself, still waiting; it gets raised in the content scan below.
      if (m.stop_reason && m.stop_reason !== 'tool_use') { needsInput = false; needsInputKind = null; pendingAsk = null; }
      // Capture the IDENTITY of each completed turn. The transcript is read from a truncated tail,
      // so a COUNT isn't monotonic (old end_turns scroll out of the window) — but the LATEST
      // end_turn is always in the tail, so its id is a reliable "new turn completed" signal.
      if (m.stop_reason === 'end_turn') { turns++; lastTurnId = o.uuid || o.timestamp || m.id || lastTurnId; }
    } else if (m.role === 'user' && !o.isMeta) {
      // Any real user/tool response (answer, fresh prompt, or interrupt) resolves a pending ask.
      needsInput = false; needsInputKind = null; pendingAsk = null;
      const blocks = Array.isArray(m.content) ? m.content : null;
      if (blocks && blocks.some((c) => c && c.type === 'tool_result')) {
        working = true;                                                                          // model continues after a result
        // A background launch's tool_result announces "Task ID: <id>" → track it as pending until the
        // completion notification (above) clears it. Restricted to tool_result text so schema/prose that
        // merely mentions "Task ID" cannot inflate the count. The same pass pairs a TaskCreate's
        // result ("Task #N created…") back to its task so updates can address it by number.
        for (const c of blocks) {
          if (!c || c.type !== 'tool_result') continue;
          const rt = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n') : '';
          if (bgUseIds.has(c.tool_use_id)) {                                    // must pair to a real bg launch
            const mm = rt.match(/\bTask ID:\s*(\w+)/);
            if (mm) pendingTasks.add(mm[1]);
          }
          const task = taskByUse.get(c.tool_use_id);
          if (task && task.id == null) {
            const tm = rt.match(/\bTask #(\d+) created/);
            if (tm) { task.id = tm[1]; taskById.set(tm[1], task); }
          }
        }
      }
      else {
        const text = blocks
          ? blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n')
          : String(m.content || '');
        if (text.startsWith('[Request interrupted')) working = false;                            // Esc — turn is over, no end_turn follows
        else if (text.trim()) working = true;                                                    // real prompt → model is thinking
      }
    }

    // latest usage wins — represents the current context footprint
    if (m.usage) {
      const u = m.usage;
      t.tokens = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
        context: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      };
    }

    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (!c || c.type !== 'tool_use') continue;
        t.tools[c.name] = (t.tools[c.name] || 0) + 1;
        // Remember tool_use ids that spawn BACKGROUND work: Workflow/Monitor always; Agent/Task unless
        // explicitly foreground (run_in_background:false); Bash only when run_in_background:true. Their
        // "Task ID: X" result (paired above) raises the waiting-on-background light.
        if (c.name === 'Workflow' || c.name === 'Monitor'
          || ((c.name === 'Agent' || c.name === 'Task') && !(c.input && c.input.run_in_background === false))
          || (c.name === 'Bash' && c.input && c.input.run_in_background === true)) bgUseIds.add(c.id);
        if (BLOCKING_ASK_TOOLS[c.name]) { needsInput = true; needsInputKind = BLOCKING_ASK_TOOLS[c.name]; pendingAsk = extractAsk(c.name, c.input); }
        // remember the most recent tool + when it ran, surfaced on the Studio rail
        // as the session's current activity (e.g. "reading", "editing", "running").
        t.lastTool = c.name; t.lastToolAt = o.timestamp || t.lastActivity || null;
        const inp = c.input || {};
        if (FILE_EDIT_TOOLS.has(c.name) && (inp.file_path || inp.notebook_path)) fileHits.push(String(inp.file_path || inp.notebook_path));
        if (FILE_READ_TOOLS.has(c.name) && (inp.file_path || inp.notebook_path)) readHits.push(String(inp.file_path || inp.notebook_path));
        if (c.name === 'TodoWrite' && Array.isArray(inp.todos)) latestTodos = inp.todos;
        if (c.name === 'TaskCreate') {
          const task = { id: null, subject: String(inp.subject || ''), status: 'pending', drop: false };
          taskByUse.set(c.id, task); taskList.push(task);
        }
        if (c.name === 'TaskUpdate' && inp.taskId != null) {
          const task = taskById.get(String(inp.taskId));
          if (task) {
            if (inp.subject) task.subject = String(inp.subject);
            if (inp.status === 'deleted') task.drop = true;
            else if (inp.status) task.status = String(inp.status);
          } else t.tasksPartial = true;   // its create predates the read window — the list is incomplete
        }
        if (c.name === 'Agent' && /^codex:/.test(String(inp.subagent_type || ''))) {
          t.codex.push({ agent: inp.subagent_type, description: inp.description || '', mode: codexMode(inp.prompt) });
        }
      }
    }
    noteState(o.timestamp);   // one line = one event: judge the state after ALL of its effects
  }
  t.plugins = [...plugins];
  t.skills = [...skills];
  // most-recent-first distinct edited files (cap 10) + the latest todo snapshot
  const seen = new Set();
  for (let i = fileHits.length - 1; i >= 0 && t.recentFiles.length < 10; i--) {
    if (!seen.has(fileHits[i])) { seen.add(fileHits[i]); t.recentFiles.push(fileHits[i]); }
  }
  // …then read files the same way, EXCLUDING anything already listed as an edit — a file both
  // read and edited shows once, as the (stronger) edit row.
  for (let i = readHits.length - 1; i >= 0 && t.readFiles.length < 10; i--) {
    if (!seen.has(readHits[i])) { seen.add(readHits[i]); t.readFiles.push(readHits[i]); }
  }
  if (latestTodos) t.todos = latestTodos;
  t.tasks = taskList.filter((x) => !x.drop).map(({ id, subject, status }) => ({ id, subject, status }));
  t.turns = turns;                       // completed turns WITHIN the read tail (informational; NOT monotonic)
  t.lastTurnId = lastTurnId;             // identity of the latest completed turn → the truncation-safe "done" signal
  t.working = working;                   // see the state machine above — mid-turn OR thinking on a fresh prompt
  t.needsInput = needsInput;             // session is BLOCKED waiting on the user (a named ask), not just working
  t.needsInputKind = needsInputKind;     // 'question' (AskUserQuestion) | 'plan' (ExitPlanMode) | null
  t.pendingAsk = pendingAsk;             // the unanswered ask's question+options (drives the 2-min auto-answer)
  t.pendingBg = pendingTasks.size;       // background tasks launched but not yet notified complete
  // The tab is idle for the user (no active turn, no ask) yet a subagent/workflow it spawned is still
  // running → the "waiting on background work" light. Gated on !working so an actively-generating turn
  // stays 'busy', and on !needsInput so a real ask still wins.
  t.waitingOnBackground = !working && !needsInput && pendingTasks.size > 0;
  t.stateSince = stateSince;             // when the CURRENT state began, or null if the tail can't prove it
  return t;
}

module.exports = { analyzeTranscript, mungeCwd, MODEL_SHORT, codexMode, extractAsk };
