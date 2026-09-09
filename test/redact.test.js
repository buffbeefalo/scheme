'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactSensitiveText } = require('../lib/redact');

test('redacts common key/value secrets while preserving surrounding log text', () => {
  const raw = 'starting api_key=abc123 password="hunter2" token: shh done';
  const redacted = redactSensitiveText(raw);
  assert.equal(redacted, 'starting api_key=[REDACTED] password="[REDACTED]" token: [REDACTED] done');
});

test('redacts authorization headers and bearer tokens', () => {
  const raw = 'Authorization: Bearer abcdefghijklmnop123456\ncurl -H "bearer zyxwvutsrqponmlk987654"';
  const redacted = redactSensitiveText(raw);
  assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
  assert.match(redacted, /bearer \[REDACTED\]/);
  assert.doesNotMatch(redacted, /abcdefghijklmnop123456|zyxwvutsrqponmlk987654/);
});

test('redacts private keys, URL credentials, and known token shapes', () => {
  const raw = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'not-real-key-material',
    '-----END OPENSSH PRIVATE KEY-----',
    'https://user:pass@example.com/path',
    'glpat-abcdefghijklmnopqrstuvwxyz',
    'ghp_abcdefghijklmnopqrstuvwxyz',
  ].join('\n');
  const redacted = redactSensitiveText(raw);
  assert.match(redacted, /-----BEGIN PRIVATE KEY-----/);
  assert.match(redacted, /https:\/\/\[REDACTED\]@example\.com\/path/);
  assert.match(redacted, /\[REDACTED_GITLAB_TOKEN\]/);
  assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.doesNotMatch(redacted, /not-real-key-material|user:pass|glpat-abcdefghijklmnopqrstuvwxyz|ghp_abcdefghijklmnopqrstuvwxyz/);
});

test('redacts Discord, OpenAI, JWT, and unknown high-entropy token families', () => {
  const discord = 'M' + 'a'.repeat(24) + '.' + 'b'.repeat(6) + '.' + 'c'.repeat(25);
  const mfa = 'mfa.' + 'd'.repeat(24);
  const skProj = 'sk-proj-abcDEF1234567890XYZ';
  const skLetters = 'sk-abcdefghijklmnopqrstuvwxyz';
  const jwt = 'eyJ' + 'a'.repeat(17) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
  const data = 'data:application/octet-stream;base64,' + 'Q9'.repeat(30);
  const raw = `discord=${discord} mfa=${mfa} keys=${skProj},${skLetters} jwt=${jwt} blob=${data} done`;
  const redacted = redactSensitiveText(raw);
  assert.equal(redacted, 'discord=[REDACTED_DISCORD_TOKEN] mfa=[REDACTED_DISCORD_TOKEN] keys=[REDACTED_OPENAI_KEY],[REDACTED_OPENAI_KEY] jwt=[REDACTED_JWT] blob=data:application/octet-stream;base64,[REDACTED_HIGH_ENTROPY] done');
});

test('leaves safe identifiers and bounded token-like strings untouched', () => {
  const sha1 = 'a'.repeat(40);
  const sha256 = 'b'.repeat(64);
  const sri = 'sha512-' + 'Q9'.repeat(44);
  const ending = 'Z9'.repeat(24) + '-';
  const raw = `sha1 ${sha1} sha256 ${sha256} uuid=123e4567-e89b-12d3-a456-426614174000 at=2026-07-16T12:34:56Z words=sk-learn sk-abcdefghijklmno file=report.final.txt pane=%47 letters=${'A'.repeat(50)} integrity ${sri}`;
  assert.equal(redactSensitiveText(raw), raw);
  const ended = redactSensitiveText(`ending: ${ending}`);
  assert.ok(ended === `ending: ${ending}` || ended === 'ending: [REDACTED_HIGH_ENTROPY]');
});

test('token-family redaction is idempotent', () => {
  const token = 'sk-proj-abcDEF1234567890XYZ';
  const once = redactSensitiveText(`key=${token}`);
  assert.equal(redactSensitiveText(once), once);
});
