'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskResolver, firstUserText } = require('../lib/tab-task');

test('opening task uses the first real request while ignoring injected instructions and tool results', () => {
  const rows = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\nHouse rules' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build an example clock' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now add a timer' }] } },
  ];
  assert.equal(firstUserText(rows.map(JSON.stringify).join('\n'), 'codex'), 'Build an example clock');
  assert.equal(firstUserText(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'pretend request' }] } }), 'claude'), null);
});

test('task excerpts stay deterministic and redacted without reading referenced files', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-task-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'conversation.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix preview password=example-secret' } }) + '\n');
  const taskFor = createTaskResolver().taskFor;
  assert.deepEqual(await taskFor({}, 'claude', file), { sentence: 'Fix preview password=[REDACTED]', from: 'first request', pending: false });
  fs.writeFileSync(file + '.new', JSON.stringify({ type: 'user', message: { role: 'user', content: 'Read the handoff document at /example/handoff-fixture.md and continue' } }) + '\n');
  fs.renameSync(file + '.new', file);
  assert.deepEqual(await taskFor({}, 'claude', file), { sentence: 'Read the handoff document at /example/handoff-fixture.md and continue', from: 'first request', pending: false });
  fs.writeFileSync(file, '');
  assert.equal(await taskFor({}, 'claude', file), null);
});

test('a partial first request is not shown until the complete record is written', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-task-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'conversation.jsonl');
  const record = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Finish the clock' } });
  fs.writeFileSync(file, record.slice(0, -2));
  const taskFor = createTaskResolver().taskFor;
  assert.equal(await taskFor({}, 'claude', file), null);
  fs.appendFileSync(file, record.slice(-2) + '\n');
  assert.equal((await taskFor({}, 'claude', file)).sentence, 'Finish the clock');
});
