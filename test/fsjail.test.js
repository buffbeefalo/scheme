'use strict';

// Path-jail + image-attach safety for the Studio terminal's file affordances.
// These guard loopback-only endpoints, so the traversal/symlink cases are the
// load-bearing ones.  node --test test/fsjail.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { jailResolve, listDir, findFiles, saveUpload } = require('../lib/fsjail');

// Build a throwaway project tree to exercise the jail.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsjail-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.js'), 'console.log(1)');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), 'x');
  try { fs.symlinkSync(os.tmpdir(), path.join(root, 'escape')); } catch {}   // symlink OUT of root
  return root;
}
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

test('jailResolve keeps paths inside the root and blocks traversal', () => {
  const root = fixture();
  try {
    assert.equal(jailResolve(root, 'sub/../a.txt'), fs.realpathSync(path.join(root, 'a.txt')));
    assert.equal(jailResolve(root, ''), fs.realpathSync(root));
    assert.equal(jailResolve(root, '../../../etc/passwd'), null);             // climb-out blocked
    assert.equal(jailResolve(root, '/etc/passwd'), null);                     // absolute outside blocked
    assert.equal(jailResolve(root, 'escape'), null);                          // symlink-out blocked
  } finally { rmrf(root); }
});

test('listDir lists one level (dirs first) and refuses to escape', () => {
  const root = fixture();
  try {
    const r = listDir(root, '');
    assert.equal(r.ok, true);
    const names = r.entries.map((e) => e.name);
    assert.ok(names.includes('a.txt') && names.includes('sub'));
    assert.equal(r.entries[0].dir, true);                                     // a directory sorts first
    assert.equal(listDir(root, '../..').ok, false);                          // traversal rejected
  } finally { rmrf(root); }
});

test('findFiles matches under cwd and skips node_modules', () => {
  const root = fixture();
  try {
    assert.deepEqual(findFiles(root, 'b.js'), ['sub/b.js']);
    assert.deepEqual(findFiles(root, 'junk'), []);                            // node_modules pruned
    assert.ok(findFiles(root, '').length >= 2);                              // empty query lists files
  } finally { rmrf(root); }
});

test('saveUpload writes ANY file type into .cc-uploads, rejecting only empties + escapes', () => {
  const root = fixture();
  try {
    const onePx = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const ok = saveUpload(root, 'shot.png', onePx);
    assert.equal(ok.ok, true);
    assert.ok(ok.path.startsWith(path.join(root, '.cc-uploads') + path.sep));
    assert.equal(fs.existsSync(ok.path), true);

    // documents/data/code are now accepted (Claude reads them; they're never executed)
    for (const n of ['report.pdf', 'sheet.xlsx', 'schema.sql', 'notes.txt', 'data.csv']) {
      assert.equal(saveUpload(root, n, onePx).ok, true, `${n} should save`);
    }
    assert.equal(saveUpload(root, 'empty.pdf', '').ok, false);               // empty still rejected
    // a malicious name can't break out — basename strips the traversal
    const esc = saveUpload(root, '../../../../tmp/pwned.txt', onePx);
    assert.equal(esc.ok, true);
    assert.ok(esc.path.startsWith(path.join(root, '.cc-uploads') + path.sep));
  } finally { rmrf(root); }
});

test('saveUpload returns a mention-safe rel with spaces and punctuation collapsed', () => {
  const root = fixture();
  try {
    const data = 'aGVsbG8=';
    const r = saveUpload(root, 'Screenshot 2026-07-16 (1).png', data);
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.rel, / /);
    assert.match(r.rel, /Screenshot_2026-07-16__1_\.png$/);
  } finally { rmrf(root); }
});

test('saveUpload refuses a pre-planted .cc-uploads symlink (no jail escape)', () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsjail-out-'));
  try {
    fs.symlinkSync(outside, path.join(root, '.cc-uploads'));                 // attacker redirects uploads
    const onePx = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const r = saveUpload(root, 'shot.png', onePx);
    assert.equal(r.ok, false);                                              // escape rejected
    assert.equal(fs.readdirSync(outside).length, 0);                        // nothing written outside
  } finally { rmrf(root); rmrf(outside); }
});
