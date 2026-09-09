'use strict';

// Truthful per-model context windows for the terminal-rail meter. The map is static and
// hand-verified — ollama /api/show is NOT a truth source (the harness sets num_ctx per
// request) — and an unknown model must yield null so the UI never invents a denominator.
//   node --test test/ctxwindow.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { contextWindowFor } = require('../lib/ctxwindow');

test('cloud 1M-window models resolve (Fable/Mythos, Opus 4.6–4.8, Sonnet 5/4.6)', () => {
  for (const m of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7',
    'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6']) {
    assert.equal(contextWindowFor(m), 1000000, m);
  }
});

// Measured, not assumed: claude-opus-5 is the most-used model in this box's transcripts (24,208
// "model" rows) and a real session was observed holding 512,408 context tokens — which rules out
// every published window below 1M. Without this entry the fleet's commonest model showed raw
// tokens and no percentage on the terminal rail and in the session switcher.
test('claude-opus-5 resolves to 1M — observed at 512,408 tokens on this box', () => {
  assert.equal(contextWindowFor('claude-opus-5'), 1000000);
  assert.equal(contextWindowFor('claude-opus-5-20260601'), 1000000);
  assert.equal(contextWindowFor('claude-opus-55'), null, 'a lookalike must not bleed');
});

test('haiku-4-5 resolves to 200k, including date-suffixed ids', () => {
  assert.equal(contextWindowFor('claude-haiku-4-5'), 200000);
  assert.equal(contextWindowFor('claude-haiku-4-5-20251001'), 200000);
});

test('a prefix only matches at an id boundary — no lookalike bleed', () => {
  assert.equal(contextWindowFor('claude-sonnet-5-20260115'), 1000000);   // date suffix = boundary
  assert.equal(contextWindowFor('claude-opus-4-85'), null);              // NOT opus-4-8
  assert.equal(contextWindowFor('claude-fable-55'), null);
});

test('verified local model: ornith:9b = 131072 (claude-local raised it 2026-07-11)', () => {
  assert.equal(contextWindowFor('ornith:9b'), 131072);
});

test('unknown or unverified models yield null — never a made-up denominator', () => {
  for (const m of ['qwen3-coder:30b', 'glm-4.7-flash', 'qwen3-coder-next', 'gpt-5.5',
    'claude-sonnet-4-5', '', null, undefined]) {
    assert.equal(contextWindowFor(m), null, String(m));
  }
});
