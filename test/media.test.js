'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { checkMedia } = require('../scripts/check-media');
const { buildSite, markdown } = require('../scripts/build-site');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = path.join(root, 'site');
  const mediaDir = path.join(root, 'rendered');
  fs.mkdirSync(mediaDir);
  fs.mkdirSync(path.join(site, 'captions'), { recursive: true });
  fs.mkdirSync(path.join(site, 'transcripts'));
  const manifest = { schemaVersion: 1, repository: 'buffbeefalo/scheme', releaseTag: 'v1.1.0', reviewed: true, assets: [], films: [] };
  for (const id of ['product', 'setup', 'capabilities']) {
    const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
    const captions = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nExample narration.\n');
    const transcript = Buffer.from(`# Scheme ${id} film\n\n## 00:00 Getting started\n\nExample narration.\n`);
    for (const [assetPath, bytes, source] of [
      [`media/scheme-${id}.mp4`, video, 'release'],
      [`captions/scheme-${id}.vtt`, captions, 'repository'],
      [`transcripts/${id}-transcript.md`, transcript, 'repository'],
    ]) {
      const destination = source === 'release' ? path.join(mediaDir, path.basename(assetPath)) : path.join(site, assetPath);
      fs.writeFileSync(destination, bytes);
      manifest.assets.push({ path: assetPath, source, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    manifest.films.push({ id, durationSeconds: 60, width: 1920, height: 1080, chapters: [{ time: 0, title: 'Getting started' }, { time: 30, title: 'Continue' }] });
  }
  const write = () => fs.writeFileSync(path.join(site, 'media-manifest.json'), JSON.stringify(manifest));
  write();
  return { root, site, mediaDir, manifest, write, check: () => checkMedia({ root, mediaDir }) };
}

test('media review accepts only the complete pinned release with matching bytes', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.check().issues, []);
});

test('pending review or missing hashes cannot publish', (t) => {
  const f = fixture(t);
  f.manifest.reviewed = false;
  f.manifest.assets[0].sha256 = '';
  f.write();
  const issues = f.check().issues.join('\n');
  assert.match(issues, /review is incomplete/);
  assert.match(issues, /SHA-256/);
});

test('a null manifest is a rejected review record, not an unhandled exception', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.site, 'media-manifest.json'), 'null');
  assert.match(f.check().issues.join('\n'), /manifest fields/);
});

test('unknown files and changed media fail without exposing their contents', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.mediaDir, 'private-note.txt'), 'sensitive example that must not be printed');
  fs.appendFileSync(path.join(f.mediaDir, 'scheme-product.mp4'), 'changed');
  const issues = f.check().issues.join('\n');
  assert.match(issues, /unexpected file/);
  assert.match(issues, /size differs/);
  assert.match(issues, /SHA-256 differs/);
  assert.doesNotMatch(issues, /sensitive example/);
});

test('the fixed asset set rejects missing entries and path traversal', (t) => {
  const f = fixture(t);
  f.manifest.assets.pop();
  f.manifest.assets[0].path = '../scheme-product.mp4';
  f.write();
  const issues = f.check().issues.join('\n');
  assert.match(issues, /unexpected asset/);
  assert.match(issues, /missing asset/);
});

test('unlisted captions and symlinked media cannot be carried into the public site', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.site, 'captions', 'unreviewed.vtt'), 'WEBVTT\n');
  fs.renameSync(path.join(f.mediaDir, 'scheme-product.mp4'), path.join(f.root, 'outside.mp4'));
  fs.symlinkSync(path.join(f.root, 'outside.mp4'), path.join(f.mediaDir, 'scheme-product.mp4'));
  const issues = f.check().issues.join('\n');
  assert.match(issues, /unexpected file/);
  assert.match(issues, /symlink/);
});

test('a symlinked caption directory is rejected before content is read', (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.site, 'captions'), path.join(f.root, 'outside-captions'));
  fs.symlinkSync(path.join(f.root, 'outside-captions'), path.join(f.site, 'captions'));
  assert.match(f.check().issues.join('\n'), /symlink/);
});

test('captions with impossible times or no actual cues are rejected even after hashing', (t) => {
  const f = fixture(t);
  const asset = f.manifest.assets.find((item) => item.path === 'captions/scheme-product.vtt');
  const content = Buffer.from('WEBVTT\n\n00:00:59.000 --> 00:01:02.000\nPast the end.\n');
  fs.writeFileSync(path.join(f.site, asset.path), content);
  asset.sha256 = createHash('sha256').update(content).digest('hex');
  asset.bytes = content.length;
  f.write();
  assert.match(f.check().issues.join('\n'), /caption timing/);
});

test('chapters must begin at zero and remain ordered inside the reviewed duration', (t) => {
  const f = fixture(t);
  f.manifest.films[0].chapters = [{ time: 30, title: 'Late start' }, { time: 10, title: 'Backwards' }];
  f.write();
  assert.match(f.check().issues.join('\n'), /chapters/);
});

test('capabilities captions use their own film duration instead of the setup duration', (t) => {
  const f = fixture(t);
  f.manifest.films.find((film) => film.id === 'capabilities').durationSeconds = 35;
  const asset = f.manifest.assets.find((item) => item.path === 'captions/scheme-capabilities.vtt');
  const content = Buffer.from('WEBVTT\n\n00:00:34.000 --> 00:00:36.000\nPast this film, inside the setup film.\n');
  fs.writeFileSync(path.join(f.site, asset.path), content);
  asset.sha256 = createHash('sha256').update(content).digest('hex');
  asset.bytes = content.length;
  f.write();
  assert.match(f.check().issues.join('\n'), /scheme-capabilities.vtt: caption timing/);
});

test('the new film cannot disappear from the reviewed set or change after review', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.mediaDir, 'scheme-capabilities.mp4'), 'changed');
  assert.match(f.check().issues.join('\n'), /scheme-capabilities.mp4: SHA-256 differs/);
  f.manifest.assets = f.manifest.assets.filter((asset) => asset.path !== 'media/scheme-capabilities.mp4');
  f.write();
  assert.match(f.check().issues.join('\n'), /scheme-capabilities.mp4: missing asset/);
});

test('an unpinned repository, tag, or undeclared field cannot change the download source', (t) => {
  const f = fixture(t);
  f.manifest.repository = 'example/other';
  f.manifest.releaseTag = 'latest';
  f.manifest.downloadUrl = 'https://example.com/file';
  f.write();
  assert.match(f.check().issues.join('\n'), /manifest fields|pinned release/);
});

test('transcripts preserve readable headings while escaping active HTML', () => {
  const rendered = markdown('# A title\n\n## 00:00 Start\n\nAn **important** step and `<example>`.\n\n<script>alert(1)</script>');
  assert.match(rendered, /<h2>A title<\/h2>/);
  assert.match(rendered, /<h3>00:00 Start<\/h3>/);
  assert.match(rendered, /<strong>important<\/strong>/);
  assert.match(rendered, /&lt;script&gt;/);
  assert.doesNotMatch(rendered, /<script>/);
});

test('the static build includes readable transcripts and excludes runtime or extra source files', (t) => {
  const f = fixture(t);
  const actualRoot = path.join(__dirname, '..');
  for (const file of ['index.html', 'styles.css', 'site.js', 'icon.svg']) fs.copyFileSync(path.join(actualRoot, 'site', file), path.join(f.site, file));
  fs.mkdirSync(path.join(f.root, 'docs', 'images'), { recursive: true });
  for (const file of ['scheme-desktop-demo.png', 'scheme-mobile-demo.png', 'scheme-sessions-demo.png']) fs.writeFileSync(path.join(f.root, 'docs', 'images', file), 'reviewed image fixture');
  fs.writeFileSync(path.join(f.root, 'server.js'), 'private runtime fixture');
  fs.writeFileSync(path.join(f.site, 'unlisted.txt'), 'unlisted source fixture');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-site-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const result = buildSite({ root: f.root, mediaDir: f.mediaDir, out });
  assert.equal(result.files, 21);
  assert.equal(fs.existsSync(path.join(out, 'server.js')), false);
  assert.equal(fs.existsSync(path.join(out, 'unlisted.txt')), false);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\{\{/);
  assert.match(html, /src="captions\/scheme-product.vtt"/);
  assert.match(html, /src="captions\/scheme-capabilities.vtt"/);
  assert.match(html, /data-player="capabilities-film" data-time="30"/);
  assert.match(html, /data-player="setup-film" data-time="30"/);
  assert.match(fs.readFileSync(path.join(out, 'transcripts', 'setup-transcript.html'), 'utf8'), /<p>Example narration\.<\/p>/);
  const capabilities = fs.readFileSync(path.join(out, 'transcripts', 'capabilities-transcript.html'), 'utf8');
  assert.match(capabilities, /Scheme capabilities film/);
  assert.match(capabilities, /href="\.\.\/#watch"/);
  assert.throws(() => buildSite({ root: f.root, mediaDir: f.mediaDir, out }), /must be empty/);
});

test('a failed media review creates no publishable output', (t) => {
  const f = fixture(t);
  f.manifest.reviewed = false;
  f.write();
  const out = path.join(os.tmpdir(), `scheme-rejected-${path.basename(f.root)}`);
  assert.throws(() => buildSite({ root: f.root, mediaDir: f.mediaDir, out }), /review must pass/);
  assert.equal(fs.existsSync(out), false);
});
