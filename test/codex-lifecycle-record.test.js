'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LifecycleRecordParser, MAX_DEPTH, MAX_METADATA_CHARS } = require('../lib/codex-lifecycle-record');
const { lifecycleEvent } = require('../lib/codex-lifecycle');

function classify(text, chunkBytes = 7) {
  const parser = new LifecycleRecordParser();
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += chunkBytes) parser.write(bytes.subarray(i, i + chunkBytes));
  return parser.finish();
}

test('streaming classification agrees with complete native envelopes, member order and last duplicate keys', () => {
  const cases = [
    '{"payload":{"type":"task_started"},"type":"event_msg"}',
    '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"done"},"timestamp":"2026-09-17T00:00:00Z"}',
    '{"ty\\u0070e":"event_msg","pay\\u006coad":{"ty\\u0070e":"turn_aborted"}}',
    '{"type":"event_msg","type":"response_item","payload":{"type":"task_started"}}',
    '{"type":"response_item","type":"event_msg","payload":{"type":"task_started"}}',
    '{"type":"event_msg","payload":{"type":"task_started"},"payload":null}',
    '{"type":"event_msg","payload":{"type":"task_started"},"payload":{"type":"turn_aborted"}}',
    '{"type":"event_msg","payload":{"type":"task_started","type":[]}}',
    '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"old","turn_id":{}}}',
    '{"nested":{"type":"event_msg","payload":{"type":"task_started"}}}',
    '{"type":"event_msg","payload":{"nested":{"type":"task_started"},"type":"item_completed"}}',
    '{"type":"event_msg","payload":[{"type":"task_started"}]}',
    '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"☃😀\\n\\t\\uD800"}}',
    '{"type":"event_msg","payload":{"type":"task_started"},"values":[0,-0,1e99,-12.345E-5,true,false,null,{},[]]}',
    'null', '[]', '"text"', '123', 'true', '{}',
  ];
  for (const value of cases) for (const chunkBytes of [1, 7, 64]) {
    const result = classify(value, chunkBytes), expected = lifecycleEvent(value);
    assert.equal(result.kind, expected ? 'event' : 'unrelated', value);
    assert.deepEqual(result.event || null, expected, value);
  }
});

test('malformed suffixes, invalid escapes, numbers and container punctuation cannot fabricate events', () => {
  const native = '"type":"event_msg","payload":{"type":"task_started"}';
  const cases = ['', ' ', '{', '{' + native + '}junk', '{' + native + ',}',
    '{' + native + ',"bad":"\\q"}', '{' + native + ',"bad":"\\u00x0"}',
    '{' + native + ',"bad":"raw\tcontrol"}', '{' + native + ',"bad":01}',
    '{' + native + ',"bad":1.}', '{' + native + ',"bad":1e+}',
    '{' + native + ',"bad":tru}', '{' + native + ',"bad":[1,]}',
    '{' + native + ',"bad":[,1]}', '{' + native + ',"bad":{1:2}}',
    '{' + native + ',"bad":true false}', '{' + native + ',"bad":+1}',
    '{' + native + ',"bad":NaN}', '{' + native + ',"bad":"unfinished}',
    '{' + native + ',"bad":1}\u00a0', '{' + native + ']'];
  for (const value of cases) assert.equal(classify(value).kind, 'malformed', value);
});

test('giant discarded strings and optional metadata do not hide completion or abort', () => {
  for (const type of ['task_complete', 'turn_aborted']) for (const atEnd of [true, false]) {
    const fields = `"type":"event_msg","payload":{"type":"${type}","turn_id":"${'t'.repeat(3000)}"}`;
    const padding = `"output":"${'x'.repeat(3 * 1024 * 1024)}","timestamp":"${'9'.repeat(3000)}"`;
    const result = classify(`{${atEnd ? padding + ',' + fields : fields + ',' + padding}}`, 65536);
    assert.deepEqual(result, { kind: 'event', event: { working: false, lastTurnId: null, observedAt: null } });
  }
});

test('retained strings and nesting stay bounded while unclassifiable depth reports uncertainty', () => {
  const parser = new LifecycleRecordParser();
  parser.write(Buffer.from('{"type":"event_msg","payload":{"type":"task_started"},"timestamp":"'));
  for (let i = 0; i < 100; i++) {
    parser.write(Buffer.from('x'.repeat(65536)));
    assert.ok(parser.token.text.length <= MAX_METADATA_CHARS);
    assert.ok(parser.stack.length <= MAX_DEPTH);
  }
  parser.write(Buffer.from('"}'));
  assert.equal(parser.finish().event.working, true);
  const deep = new LifecycleRecordParser();
  deep.write(Buffer.from('['.repeat(MAX_DEPTH + 1)));
  assert.ok(deep.stack.length <= MAX_DEPTH);
  assert.equal(deep.finish().kind, 'unknown');
});
