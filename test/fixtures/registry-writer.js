'use strict';

// Child-process fixture for deterministic registry contention. It widens only
// this process's first registry read after capturing the bytes, so unlocked
// writers all act on the same stale snapshot while locked writers serialize.
const fs = require('node:fs');
const path = require('node:path');

// `node --test` recursively discovers JavaScript below test/. With no encoded
// operation this file is being discovered, not launched as a contention child.
if (!process.argv[2]) process.exit(0);

const registryFile = path.resolve(process.env.COMMAND_DECK_REGISTRY || '');
const operation = JSON.parse(process.argv[2] || '{}');
const waitWord = new Int32Array(new SharedArrayBuffer(4));
const originalRead = fs.readFileSync.bind(fs);
let delayed = false;

fs.readFileSync = function delayedRegistryRead(file, ...args) {
  const value = originalRead(file, ...args);
  if (!delayed && path.resolve(String(file)) === registryFile) {
    delayed = true;
    Atomics.wait(waitWord, 0, 0, 20);
  }
  return value;
};

const registry = require('../../lib/registry');

process.stdout.write('ready\n');
process.stdin.once('data', () => {
  let ok = false;
  if (operation.type === 'upsert') ok = registry.upsert(operation.meta);
  else if (operation.type === 'setLabel') ok = registry.setLabel(operation.id, operation.label);
  else if (operation.type === 'reorder') ok = registry.reorder(operation.ids);
  process.stdout.write(`${JSON.stringify({ ok })}\n`);
});
