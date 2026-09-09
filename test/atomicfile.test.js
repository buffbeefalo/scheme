'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteFile } = require('../lib/atomicfile');

test('atomicWriteFile replaces a file and leaves no temp behind', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, 'before');
  await atomicWriteFile(file, 'after');
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  assert.deepEqual(fs.readdirSync(dir), ['notes.md']);
});

test('atomicWriteFile preserves the prior file when rename fails', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-atomic-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, 'before');
  const fsp = Object.create(fs.promises);
  fsp.rename = async () => { throw new Error('simulated rename failure'); };
  await assert.rejects(atomicWriteFile(file, 'after', fsp), /simulated rename failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual(fs.readdirSync(dir), ['notes.md']);
});
