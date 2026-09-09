'use strict';

// Analyzer that turns a Claude Code session JSONL into the Studio telemetry rail
// data: model, automode, token usage, active plugins/skills, and Codex activity.
// Fixtures mirror real event shapes captured from a live transcript.
//   node --test test/telemetry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTranscript, mungeCwd, MODEL_SHORT } = require('../lib/telemetry');

// One JSONL line per event (objects here; analyzer also accepts a raw string).
const LINES = [
  { type: 'system', subtype: 'init', cwd: '/home/you/.config/workspace' },
  { type: 'user', message: { role: 'user', content: 'fix the cron bug' }, timestamp: '2026-05-30T19:00:00Z' },
  { type: 'permission-mode', permissionMode: 'auto', timestamp: '2026-05-30T19:00:01Z' },
  { type: 'assistant', attributionPlugin: 'superpowers', attributionSkill: 'superpowers:test-driven-development',
    message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'reading' }],
      usage: { input_tokens: 131, output_tokens: 855, cache_read_input_tokens: 262059, cache_creation_input_tokens: 1070 } },
    timestamp: '2026-05-30T19:00:05Z' },
  { type: 'assistant', message: { model: 'claude-opus-4-8', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: 'poller.js' } }] }, timestamp: '2026-05-30T19:00:06Z' },
  { type: 'assistant', attributionPlugin: 'codex', attributionSkill: 'codex:rescue',
    message: { model: 'claude-opus-4-8', content: [
      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'codex:codex-rescue', description: 'review tz logic', prompt: '--background --wait audit it' } }] },
    timestamp: '2026-05-30T19:00:07Z' },
];

test('mungeCwd maps a path to the claude projects dir name', () => {
  assert.equal(mungeCwd('/home/you/.config/workspace'), '-home-you--config-workspace');
  assert.equal(mungeCwd('/tmp'), '-tmp');
  // Underscores are hyphenated too — checked against the real transcript tree, where a session
  // in projects/sample_app lives under ".../-projects-sample-app". Getting this wrong builds a path
  // that never exists, so the tab's telemetry silently reads nothing and its light stays dark.
  assert.equal(mungeCwd('/home/you/.config/workspace/projects/sample_app'), '-home-you--config-workspace-projects-sample-app');
  assert.equal(mungeCwd('/home/you/.config/workspace/projects/another_app'), '-home-you--config-workspace-projects-another-app');
  assert.equal(mungeCwd('/home/you/.config/workspace/projects/_shared'), '-home-you--config-workspace-projects--shared');
});

test('extracts model (short form) and automode', () => {
  const t = analyzeTranscript(LINES);
  assert.equal(t.model, 'claude-opus-4-8');
  assert.equal(t.modelShort, 'opus-4-8');
  assert.equal(t.automode, 'auto');
});

test('reads the latest usage block into a token summary', () => {
  const t = analyzeTranscript(LINES);
  assert.equal(t.tokens.input, 131);
  assert.equal(t.tokens.output, 855);
  assert.equal(t.tokens.cacheRead, 262059);
  assert.equal(t.tokens.cacheCreate, 1070);
  // context window = the live footprint the model is carrying
  assert.equal(t.tokens.context, 131 + 262059 + 1070);
});

test('collects distinct active plugins and skills', () => {
  const t = analyzeTranscript(LINES);
  assert.deepEqual(t.plugins.sort(), ['codex', 'superpowers']);
  assert.deepEqual(t.skills.sort(), ['codex:rescue', 'superpowers:test-driven-development']);
});

test('detects a Codex run via the Agent tool, with how-it-was-used', () => {
  const t = analyzeTranscript(LINES);
  assert.equal(t.codex.length, 1);
  const c = t.codex[0];
  assert.equal(c.agent, 'codex:codex-rescue');
  assert.equal(c.description, 'review tz logic');
  assert.equal(c.mode, 'background');     // parsed from the --background flag in the prompt
});

test('counts tool usage', () => {
  const t = analyzeTranscript(LINES);
  assert.equal(t.tools.Edit, 1);
  assert.equal(t.tools.Agent, 1);
});

test('tracks the most recent tool_use as lastTool (+timestamp)', () => {
  const t = analyzeTranscript(LINES);
  assert.equal(t.lastTool, 'Agent');                 // last tool_use in the fixture
  assert.equal(t.lastToolAt, '2026-05-30T19:00:07Z');
});

test('collects recently-edited files for the Changes panel', () => {
  const t = analyzeTranscript(LINES);
  assert.deepEqual(t.recentFiles, ['poller.js']);    // from the Edit tool_use
  assert.deepEqual(t.todos, []);                     // no TodoWrite in the fixture
});

test('recentFiles is most-recent-first, distinct, capped at 10; todos snapshot wins', () => {
  const mk = (name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: name } }] } });
  const lines = [];
  for (let i = 0; i < 14; i++) lines.push(mk('f' + i + '.js'));
  lines.push(mk('f3.js')); // re-edit -> should jump to front, not duplicate
  lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite',
    input: { todos: [{ content: 'ship it', status: 'in_progress' }] } }] } });
  const t = analyzeTranscript(lines);
  assert.equal(t.recentFiles.length, 10);
  assert.equal(t.recentFiles[0], 'f3.js');           // most-recent-first
  assert.equal(new Set(t.recentFiles).size, 10);     // distinct
  assert.equal(t.todos[0].content, 'ship it');
});

test('accepts a raw JSONL string and ignores blank/garbage lines', () => {
  const raw = LINES.map((l) => JSON.stringify(l)).join('\n') + '\n\nnot json\n';
  const t = analyzeTranscript(raw);
  assert.equal(t.model, 'claude-opus-4-8');
  assert.equal(t.tokens.output, 855);
});

test('empty transcript yields safe zeros, not throws', () => {
  const t = analyzeTranscript('');
  assert.equal(t.model, null);
  assert.equal(t.automode, null);
  assert.equal(t.tokens.context, 0);
  assert.deepEqual(t.plugins, []);
  assert.deepEqual(t.codex, []);
});

test('foreground Codex run (no --background) is labeled foreground', () => {
  const t = analyzeTranscript([
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'codex:codex-rescue', description: 'fix', prompt: '--wait do it' } }] } },
  ]);
  assert.equal(t.codex[0].mode, 'foreground');
});

test('non-codex Agent subagents are not counted as Codex', () => {
  const t = analyzeTranscript([
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'search' } }] } },
  ]);
  assert.deepEqual(t.codex, []);
});

test('counts end_turn in the tail (informational) and tracks the LATEST turn id (the done signal)', () => {
  const t = analyzeTranscript([
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', uuid: 'turn-a', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
    { type: 'assistant', uuid: 'turn-b', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done one' }] } },
    { type: 'user', message: { role: 'user', content: 'again' } },
    { type: 'assistant', uuid: 'turn-c', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done two' }] } },
  ]);
  assert.equal(t.turns, 2);              // two end_turn (the tool_use one is mid-turn) — count is tail-windowed
  assert.equal(t.lastTurnId, 'turn-c');  // identity of the latest completed turn → drives "done"
  assert.equal(t.working, false);        // last stop_reason was end_turn → idle / waiting for the user
});

test('lastTurnId falls back to the entry timestamp when it has no uuid', () => {
  const t = analyzeTranscript([
    { type: 'assistant', timestamp: '2026-06-03T01:00:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
  ]);
  assert.equal(t.lastTurnId, '2026-06-03T01:00:00Z');
});

test('working is true while the last assistant message is a tool call (mid-turn)', () => {
  const t = analyzeTranscript([
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
  ]);
  assert.equal(t.turns, 1);
  assert.equal(t.working, true);
});

test('a transcript with no stop_reason yields turns 0 and no turn id; an unanswered prompt means working', () => {
  const t = analyzeTranscript(LINES);
  assert.equal(t.turns, 0);
  assert.equal(t.lastTurnId, null);
  assert.equal(t.working, true);   // LINES ends mid-response to 'fix the cron bug' — no end_turn yet
});

// ---- working-state classification (drives the tab lights) -------------------
// Shapes below mirror REAL transcript entries verified on this box (2026-06-12):
// prompts are role:user with string content; tool results are role:user with
// tool_result blocks; meta lines carry isMeta:true; assistant entries always
// carry stop_reason; bookkeeping lines (last-prompt, ai-title, mode…) have no
// message and must not disturb the state.

const A_END = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
const A_TOOL = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } };
const U_PROMPT = { type: 'user', message: { role: 'user', content: 'new task please' } };
const U_RESULT = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } };
const BOOKKEEPING = { type: 'last-prompt' };

test('working: a fresh user prompt after end_turn = working (the thinking gap)', () => {
  const t = analyzeTranscript([A_END, U_PROMPT]);
  assert.equal(t.working, true);
});

test('working: bookkeeping lines after a prompt do not reset the state', () => {
  const t = analyzeTranscript([A_END, U_PROMPT, BOOKKEEPING, { type: 'ai-title' }, { type: 'mode' }]);
  assert.equal(t.working, true);
});

test('working: a tool_result with no follow-up assistant message yet = still working', () => {
  const t = analyzeTranscript([A_TOOL, U_RESULT]);
  assert.equal(t.working, true);
});

test('idle: end_turn is authoritative even after earlier tool activity', () => {
  const t = analyzeTranscript([U_PROMPT, A_TOOL, U_RESULT, A_END]);
  assert.equal(t.working, false);
});

test('idle: an interrupt marker reads as idle, not as a fresh prompt', () => {
  const t = analyzeTranscript([A_TOOL,
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }]);
  assert.equal(t.working, false);
});

test('idle: meta user lines (isMeta) are ignored by the working classifier', () => {
  const t = analyzeTranscript([A_END,
    { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Caveat: local commands' }] } }]);
  assert.equal(t.working, false);
});

test('working: a prompt as text blocks (not a string) also counts', () => {
  const t = analyzeTranscript([A_END,
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }]);
  assert.equal(t.working, true);
});

test('idle: non-end_turn final stops (max_tokens) close the turn too', () => {
  const t = analyzeTranscript([U_PROMPT,
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'truncated' }] } }]);
  assert.equal(t.working, false);
});

// ---- needsInput: "Claude is BLOCKED on you" classification (drives the new light) ----
// A blocking ASK and a merely-RUNNING tool both sit at stop_reason:'tool_use', so the
// stop reason can't separate them — only the tool NAME can. AskUserQuestion (pick a/b/c/d,
// add notes) and ExitPlanMode (approve the plan) block; Bash/Edit/etc. don't.
const A_ASK = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'pick one' }] } }] } };
const A_PLAN = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'do X then Y' } }] } };

test('needsInput: an unanswered AskUserQuestion blocks on the user (question)', () => {
  const t = analyzeTranscript([U_PROMPT, A_ASK]);
  assert.equal(t.needsInput, true);
  assert.equal(t.needsInputKind, 'question');
});

test('needsInput: an unanswered ExitPlanMode blocks on the user (plan)', () => {
  const t = analyzeTranscript([U_PROMPT, A_PLAN]);
  assert.equal(t.needsInput, true);
  assert.equal(t.needsInputKind, 'plan');
});

test('needsInput: a pending plain tool (Bash) is NOT needs-input (no false positive)', () => {
  const t = analyzeTranscript([U_PROMPT, A_TOOL]);   // A_TOOL is a running Bash
  assert.equal(t.working, true);                     // it IS working…
  assert.equal(t.needsInput, false);                 // …but not blocked on the user
  assert.equal(t.needsInputKind, null);
});

test('needsInput: answering the question (a tool_result) clears it', () => {
  const t = analyzeTranscript([A_ASK, U_RESULT]);
  assert.equal(t.needsInput, false);
  assert.equal(t.needsInputKind, null);
});

test('needsInput: once the turn ends after the answer, still cleared', () => {
  const t = analyzeTranscript([A_ASK, U_RESULT, A_END]);
  assert.equal(t.needsInput, false);
});

test('needsInput: an interrupt during an ask clears it', () => {
  const t = analyzeTranscript([A_ASK,
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }]);
  assert.equal(t.needsInput, false);
});

test('needsInput: a fresh prompt instead of answering clears it', () => {
  const t = analyzeTranscript([A_ASK, U_PROMPT]);
  assert.equal(t.needsInput, false);
});

test('needsInput: only the LATEST ask state counts (answered earlier, asking now)', () => {
  const t = analyzeTranscript([A_ASK, U_RESULT, A_END, U_PROMPT, A_PLAN]);
  assert.equal(t.needsInput, true);
  assert.equal(t.needsInputKind, 'plan');
});

test('needsInput: empty transcript defaults to not-needed', () => {
  const t = analyzeTranscript('');
  assert.equal(t.needsInput, false);
  assert.equal(t.needsInputKind, null);
});

// ---- pendingAsk: the ask payload the 2-minute auto-answer assesses ----
test('pendingAsk: an unanswered AskUserQuestion exposes the question + option labels', () => {
  const ask = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [
      { question: 'Which datastore?', header: 'Store', options: [
        { label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'embedded' }] }] } }] } };
  const t = analyzeTranscript([U_PROMPT, ask]);
  assert.equal(t.needsInputKind, 'question');
  assert.equal(t.pendingAsk.kind, 'question');
  assert.equal(t.pendingAsk.questions[0].question, 'Which datastore?');
  assert.deepEqual(t.pendingAsk.questions[0].options.map((o) => o.label), ['Postgres', 'SQLite']);
});

test('pendingAsk: clears once the ask is answered', () => {
  const ask = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'x', options: [{ label: 'a' }] }] } }] } };
  const t = analyzeTranscript([ask, U_RESULT, A_END]);
  assert.equal(t.pendingAsk, null);
});

// ---- waitingOnBackground: idle, but a spawned subagent/workflow is still running (blue light) ----
const bgUse = (id) => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'Workflow', input: {} }] } });
const bgResult = (useId, taskId) => ({ type: 'user', message: { role: 'user',
  content: [{ type: 'tool_result', tool_use_id: useId, content: `Workflow launched in background. Task ID: ${taskId}\nSummary: go` }] } });
const bgDone = (taskId) => ({ type: 'queue-operation', operation: 'enqueue',
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>` });

test('waitingOnBackground: launched + idle (end_turn) → true, pendingBg 1', () => {
  const t = analyzeTranscript([U_PROMPT, bgUse('u1'), bgResult('u1', 'wtask1'), A_END]);
  assert.equal(t.pendingBg, 1);
  assert.equal(t.waitingOnBackground, true);
});

test('waitingOnBackground: still WORKING (mid-turn) stays busy, not blue', () => {
  const t = analyzeTranscript([U_PROMPT, bgUse('u1'), bgResult('u1', 'wtask1')]);   // no end_turn → working
  assert.equal(t.working, true);
  assert.equal(t.waitingOnBackground, false);
});

test('waitingOnBackground: the completion notification clears it → green', () => {
  const t = analyzeTranscript([U_PROMPT, bgUse('u1'), bgResult('u1', 'wtask1'), A_END, bgDone('wtask1')]);
  assert.equal(t.pendingBg, 0);
  assert.equal(t.waitingOnBackground, false);
});

test('waitingOnBackground: a Bash whose OUTPUT merely PRINTS a launch line does NOT count (pollution-immune)', () => {
  // Foreground Bash tool_use (u9) whose result text prints another session's launch string. Because u9 is
  // not a background launch, its "Task ID: wphantom" is ignored — the exact self-pollution seen live.
  const fgBash = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'u9', name: 'Bash', input: { command: 'grep ... transcripts' } }] } };
  const fgResult = { type: 'user', message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'u9', content: 'Workflow launched in background. Task ID: wphantom Summary: other' }] } };
  const t = analyzeTranscript([U_PROMPT, fgBash, fgResult, A_END]);
  assert.equal(t.pendingBg, 0);
  assert.equal(t.waitingOnBackground, false);
});

// ---- harness task list (TaskCreate/TaskUpdate — the successor to TodoWrite) ----------------
// Real shapes captured from a live transcript 2026-07-11: the create's tool_result announces
// the assigned id ("Task #3 created successfully: <subject>"), updates address it by taskId.
const tcUse = (uid, subject) => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: uid, name: 'TaskCreate', input: { subject, description: 'd' } }] } });
const tcResult = (uid, n, subject) => ({ type: 'user', message: { role: 'user',
  content: [{ type: 'tool_result', tool_use_id: uid, content: [{ type: 'text', text: `Task #${n} created successfully: ${subject}` }] }] } });
const tuUse = (uid, input) => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: uid, name: 'TaskUpdate', input }] } });

test('tasks: creates pair with their results and list in creation order as pending', () => {
  const t = analyzeTranscript([U_PROMPT,
    tcUse('c1', 'fix the probe'), tcResult('c1', 1, 'fix the probe'),
    tcUse('c2', 'update the wiki'), tcResult('c2', 2, 'update the wiki'), A_END]);
  assert.deepEqual(t.tasks, [
    { id: '1', subject: 'fix the probe', status: 'pending' },
    { id: '2', subject: 'update the wiki', status: 'pending' },
  ]);
});

test('tasks: TaskUpdate moves status through in_progress to completed', () => {
  const t = analyzeTranscript([U_PROMPT,
    tcUse('c1', 'fix the probe'), tcResult('c1', 1, 'fix the probe'),
    tuUse('u1', { taskId: '1', status: 'in_progress' }),
    tuUse('u2', { taskId: '1', status: 'completed' }), A_END]);
  assert.deepEqual(t.tasks, [{ id: '1', subject: 'fix the probe', status: 'completed' }]);
});

test('tasks: deleted removes the row', () => {
  const t = analyzeTranscript([U_PROMPT,
    tcUse('c1', 'oops'), tcResult('c1', 1, 'oops'),
    tcUse('c2', 'keep me'), tcResult('c2', 2, 'keep me'),
    tuUse('u1', { taskId: '1', status: 'deleted' }), A_END]);
  assert.deepEqual(t.tasks, [{ id: '2', subject: 'keep me', status: 'pending' }]);
});

test('tasks: an update for an id whose create scrolled out of the tail is ignored — and flags partial', () => {
  const t = analyzeTranscript([U_PROMPT, tuUse('u1', { taskId: '9', status: 'completed' }), A_END]);
  assert.deepEqual(t.tasks, []);
  assert.equal(t.tasksPartial, true);   // the rail labels the list "(partial)" instead of lying by omission
});

test('tasks: fully-paired history is NOT partial', () => {
  const t = analyzeTranscript([U_PROMPT,
    tcUse('c1', 'fix the probe'), tcResult('c1', 1, 'fix the probe'),
    tuUse('u1', { taskId: '1', status: 'in_progress' }), A_END]);
  assert.equal(t.tasksPartial, false);
});

test('tasks: an unpaired create (result outside the tail) still lists, id null', () => {
  const t = analyzeTranscript([U_PROMPT, tcUse('c1', 'young task'), A_END]);
  assert.deepEqual(t.tasks, [{ id: null, subject: 'young task', status: 'pending' }]);
});

test('tasks: TaskUpdate can rename the subject', () => {
  const t = analyzeTranscript([U_PROMPT,
    tcUse('c1', 'old name'), tcResult('c1', 1, 'old name'),
    tuUse('u1', { taskId: '1', subject: 'new name' }), A_END]);
  assert.deepEqual(t.tasks, [{ id: '1', subject: 'new name', status: 'pending' }]);
});

test('tasks: TodoWrite keeps populating todos independently of tasks', () => {
  const todo = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'w1', name: 'TodoWrite', input: { todos: [{ content: 'legacy', status: 'pending' }] } }] } };
  const t = analyzeTranscript([U_PROMPT, todo, tcUse('c1', 'modern'), tcResult('c1', 1, 'modern'), A_END]);
  assert.deepEqual(t.todos, [{ content: 'legacy', status: 'pending' }]);
  assert.deepEqual(t.tasks, [{ id: '1', subject: 'modern', status: 'pending' }]);
});

test('readFiles: distinct Read/NotebookRead targets, most-recent-first, excluding edited files', () => {
  const lines = [{ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5', content: [
    { type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/b.js' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/b.js' } },
    { type: 'tool_use', name: 'NotebookRead', input: { notebook_path: '/n.ipynb' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } },   // re-read → one entry, ranked latest
  ] }, timestamp: '2026-07-12T10:00:00Z' }];
  const t = analyzeTranscript(lines);
  assert.deepEqual(t.recentFiles, ['/b.js']);            // edited list keeps its exact shape
  assert.deepEqual(t.readFiles, ['/a.js', '/n.ipynb']);  // /b.js excluded — it's already an edit row
});

test('readFiles caps at 10 distinct files (most recent first)', () => {
  const content = [];
  for (let i = 0; i < 14; i++) content.push({ type: 'tool_use', name: 'Read', input: { file_path: `/f${i}.js` } });
  const t = analyzeTranscript([{ type: 'assistant', message: { role: 'assistant', content } }]);
  assert.equal(t.readFiles.length, 10);
  assert.equal(t.readFiles[0], '/f13.js');
});
