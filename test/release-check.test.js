'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const checker = path.resolve(__dirname, '../scripts/check-release.js');

function fixture(t, files = { 'README.md': '# Example\n' }, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheme-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, value);
  };
  for (const [name, value] of Object.entries(files)) write(name, value);
  write('release-files.json', JSON.stringify({ files: ['release-files.json', ...Object.keys(files)], ...extra }));
  return {
    root, write,
    run: () => spawnSync(process.execPath, [checker, root], { encoding: 'utf8', timeout: 5000 }),
  };
}

test('release check accepts reviewed source and valid local links without requiring Git', (t) => {
  const f = fixture(t, {
    'README.md': '# Example\n[Guide](docs/guide.md#first-session)\n',
    'docs/guide.md': '# Guide\n## First session\n[Home](../README.md)\n',
  });
  f.write('.git/config', 'local-only Git metadata');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('release check rejects an ignored untracked file without echoing its contents', (t) => {
  const f = fixture(t, { '.gitignore': '.env\n', 'README.md': '# Example\n' });
  const content = 'a-private-value-that-must-never-be-printed';
  f.write('.env', content);
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /\.env.*(?:runtime|unreviewed)/i);
  assert.ok(!(r.stdout + r.stderr).includes(content));
});

test('release check refuses runtime data even if someone adds it to the manifest', (t) => {
  const f = fixture(t, { 'sessions.json': '{"sessions":[]}' });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /sessions\.json.*runtime/i);
});

test('release check notices empty runtime directories and arbitrary extra source files', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.cc-uploads'));
  f.write('accidental-copy.js', 'module.exports = 1;');
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /\.cc-uploads.*runtime/i);
  assert.match(r.stdout + r.stderr, /accidental-copy\.js.*unreviewed/i);
});

test('release check does not follow source symlinks out of the release tree', (t) => {
  const f = fixture(t);
  fs.symlinkSync('/a/path/that/does/not/exist', path.join(f.root, 'outside'));
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /outside.*symlink/i);
});

test('release check flags a credential shape in a reviewed file without printing it', (t) => {
  const secret = 'gh' + 'p_' + 'Ab3'.repeat(16);
  const f = fixture(t, { 'settings.js': `const example = '${secret}';\n` });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /settings\.js:1.*credential/i);
  assert.ok(!(r.stdout + r.stderr).includes(secret));
});

test('release check distinguishes example home paths from personal ones', (t) => {
  const f = fixture(t, { 'README.md': 'Example: /home/you/code\nPrivate: /home/' + 'actual-person/private\n' });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /README\.md:2.*personal-home-path/i);
  assert.doesNotMatch(r.stdout + r.stderr, /README\.md:1:/);
});

test('release check catches missing documents and heading anchors', (t) => {
  const f = fixture(t, { 'README.md': '# Example\n[Missing](missing.md)\n[Heading](#not-a-heading)\n' });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /missing\.md/);
  assert.match(r.stdout + r.stderr, /not-a-heading/);
});

test('release check validates reference links and refuses paths outside the release', (t) => {
  const f = fixture(t, { 'README.md': '# Example\n[Setup][guide]\n\n[guide]: missing.md\n[Outside](../private.md)\n' });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /missing\.md/);
  assert.match(r.stdout + r.stderr, /outside.*release/i);
});

test('a line exception covers only that exact file, check, and line content', (t) => {
  const line = "const demo = 'gh" + 'p_' + 'Z9'.repeat(20) + "';";
  const f = fixture(t, { 'fixture.js': line + '\n' }, {
    lineExceptions: [{ path: 'fixture.js', check: 'credential-shape',
      sha256: createHash('sha256').update(line).digest('hex'), reason: 'Synthetic test value.' }],
  });
  assert.equal(f.run().status, 0);
  f.write('fixture.js', line + '\n' + line.replace('demo', 'other') + '\n');
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /fixture\.js:2.*credential/i);
});

test('release check rejects manifest traversal and non-UTF-8 source', (t) => {
  const f = fixture(t, { 'bad.js': Buffer.from([0xff]) });
  f.write('release-files.json', JSON.stringify({ files: ['../outside', 'bad.js', 'release-files.json'] }));
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /manifest.*path/i);
});

test('release check reports non-UTF-8 text and changed pinned vendor files', (t) => {
  const f = fixture(t, { 'bad.js': Buffer.from([0xff]), 'vendor.js': 'new bytes\n' }, {
    sha256: { 'vendor.js': createHash('sha256').update('reviewed bytes\n').digest('hex') },
  });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /bad\.js.*UTF-8/i);
  assert.match(r.stdout + r.stderr, /vendor\.js.*hash/i);
});

test('release check permits individually reviewed PNGs and notices any byte change', (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const f = fixture(t, { 'docs/images/demo.png': png }, {
    binaryFiles: { 'docs/images/demo.png': createHash('sha256').update(png).digest('hex') },
  });
  const first = f.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  f.write('docs/images/demo.png', Buffer.concat([png, Buffer.from('changed content')]));
  const changed = f.run();
  assert.equal(changed.status, 1);
  assert.match(changed.stdout + changed.stderr, /demo\.png.*hash/i);
});

test('release check refuses a non-PNG binary exception even when its hash matches', (t) => {
  const content = Buffer.from('This is not an image');
  const f = fixture(t, { 'docs/images/demo.png': content }, {
    binaryFiles: { 'docs/images/demo.png': createHash('sha256').update(content).digest('hex') },
  });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /demo\.png.*PNG/i);
});
