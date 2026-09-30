'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { previewFixture } = require('./fixtures/preview-media');
const { checkPreviews } = require('../scripts/check-previews');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-previews-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return previewFixture(root);
}

test('reviewed preview pairs require their exact independent release and bytes', t => {
  const f = fixture(t);
  assert.deepEqual(checkPreviews(f).issues, []);
  fs.appendFileSync(path.join(f.previewDir, 'shell-preview-v1.webm'), 'changed');
  assert.match(checkPreviews(f).issues.join('\n'), /reviewed bytes/);
});

test('unreviewed clips, missing formats and arbitrary paths cannot publish', t => {
  const f = fixture(t);
  f.manifest.reviewed = false;
  f.manifest.assets[0].path = '../unlisted.mp4';
  f.manifest.assets.pop();
  f.write();
  const errors = checkPreviews(f).issues.join('\n');
  assert.match(errors, /review is incomplete/);
  assert.match(errors, /asset set/);
});

test('a preview source cannot be redirected to another repository or floating release', t => {
  const f = fixture(t);
  f.manifest.repository = 'example/other';
  f.manifest.releaseTag = 'latest';
  f.write();
  assert.match(checkPreviews(f).issues.join('\n'), /pinned/);
});

test('extra files and symlink inputs are rejected without exposing unreviewed names', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.previewDir, 'private-note.txt'), 'unreviewed text');
  fs.renameSync(path.join(f.previewDir, 'shell-preview-v1.mp4'), path.join(f.root, 'outside.mp4'));
  fs.symlinkSync(path.join(f.root, 'outside.mp4'), path.join(f.previewDir, 'shell-preview-v1.mp4'));
  const errors = checkPreviews(f).issues.join('\n');
  assert.match(errors, /unexpected input/);
  assert.doesNotMatch(errors, /private-note|unreviewed text/);
  fs.unlinkSync(path.join(f.previewDir, 'private-note.txt'));
  assert.match(checkPreviews(f).issues.join('\n'), /regular file/);
});

test('symlink directories and invalid metadata fail before a build', t => {
  const f = fixture(t);
  f.manifest.clips[0].durationSeconds = 600;
  f.manifest.clips[1].id = 'shell';
  f.write();
  assert.match(checkPreviews(f).issues.join('\n'), /clip metadata/);
  const other = path.join(f.root, 'other');
  fs.renameSync(f.previewDir, other);
  fs.symlinkSync(other, f.previewDir);
  assert.match(checkPreviews(f).issues.join('\n'), /regular directory/);
});

test('malformed preview manifests and omitted input fail closed', t => {
  const f = fixture(t);
  assert.match(checkPreviews({ root: f.root }).issues.join('\n'), /preview-dir/);
  fs.writeFileSync(path.join(f.site, 'preview-manifest.json'), 'null');
  assert.ok(checkPreviews(f).issues.length);
});
