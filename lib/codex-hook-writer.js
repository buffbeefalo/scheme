'use strict';

const path = require('node:path');
const { appendHookRecord, journalPath, validIdentity } = require('./codex-hook-journal');

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function firstString(...values) { return values.find((value) => typeof value === 'string' && value) || undefined; }

function mapHookInput(input) {
  const event = input.hook_event_name;
  const base = { at: firstString(input.timestamp, new Date().toISOString()) };
  if (event === 'SessionStart') return { ...base, kind: 'session_start', source: firstString(input.source, input.session_start_source) };
  if (event === 'PermissionRequest') return {
    ...base, kind: 'permission_request',
    requestId: firstString(input.request_id, input.tool_use_id, input.tool_call_id, input.call_id),
    toolCallId: firstString(input.tool_use_id, input.tool_call_id, input.call_id),
    toolName: firstString(input.tool_name),
    question: firstString(input.reason, input.permission_reason),
  };
  if (event === 'SubagentStart') return {
    ...base, kind: 'subagent_start',
    subagentId: firstString(input.agent_id, input.subagent_id, input.thread_id),
    agentType: firstString(input.agent_type, input.subagent_type),
  };
  if (event === 'SubagentStop') return {
    ...base, kind: 'subagent_stop',
    subagentId: firstString(input.agent_id, input.subagent_id, input.thread_id),
    agentType: firstString(input.agent_type, input.subagent_type), status: firstString(input.status, 'completed'),
  };
  if (event === 'Stop') return { ...base, kind: 'stop', status: firstString(input.stop_reason, input.status, 'completed') };

  const toolName = firstString(input.tool_name, input.name);
  const toolCallId = firstString(input.tool_use_id, input.tool_call_id, input.call_id);
  const args = object(input.tool_input || input.arguments);
  if (event === 'PreToolUse') {
    if (toolName === 'update_plan' && Array.isArray(args.plan)) return { ...base, kind: 'plan', toolName, toolCallId, plan: args.plan };
    if (toolName === 'request_user_input') {
      const question = Array.isArray(args.questions) ? args.questions[0] : null;
      return {
        ...base, kind: 'question_request', requestId: toolCallId, toolCallId, toolName,
        question: firstString(question && question.question), options: question && question.options,
      };
    }
    if (['read_file', 'Read', 'NotebookRead', 'view_image'].includes(toolName)) {
      const filePath = firstString(args.file_path, args.notebook_path, args.path);
      if (filePath && path.isAbsolute(filePath)) return { ...base, kind: 'read', toolName, toolCallId, filePath };
    }
    return { ...base, kind: 'tool_start', toolName, toolCallId };
  }
  if (event === 'PostToolUse') return { ...base, kind: 'tool_end', toolName, toolCallId, status: firstString(input.status, 'completed') };
  return null;
}

function writeHookInput(env, input) {
  try {
    const identity = {
      sessionId: input && input.session_id,
      tabId: env && env.COMMAND_DECK_TAB_ID,
      generationId: env && env.COMMAND_DECK_CODEX_GENERATION,
    };
    const root = env && env.COMMAND_DECK_CODEX_TELEMETRY_DIR;
    if (!validIdentity(identity) || typeof root !== 'string' || !path.isAbsolute(root)) return { ok: false };
    const mapped = mapHookInput(object(input));
    if (!mapped) return { ok: false };
    return appendHookRecord(journalPath(root, identity), { v: 1, ...identity, ...mapped });
  } catch { return { ok: false }; }
}

if (require.main === module) {
  let input = '', overflow = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (input.length + chunk.length <= 65536) input += chunk;
    else overflow = true;
  });
  process.stdin.on('end', () => {
    if (!overflow) { try { writeHookInput(process.env, JSON.parse(input)); } catch {} }
    process.exitCode = 0;
  });
}

module.exports = { mapHookInput, writeHookInput };
