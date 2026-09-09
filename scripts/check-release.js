#!/usr/bin/env node
'use strict';

// Release hygiene, not a replacement for Gitleaks or a review of Git history.
// Walk the filesystem directly: ignored and untracked files must be noticed too.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const validPath = (name) => typeof name === 'string' && name.length > 0
  && !name.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(name)
  && !path.posix.isAbsolute(name) && name.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git');
const runtimeName = /^(?:\.env(?:\..*)?|\.claude|\.claude-local|\.codex|\.ssh|\.cc-uploads|node_modules|credentials\.json|sessions\.json|config\.toml|id_(?:rsa|ed25519|ecdsa)|.*\.(?:jsonl|log|pem|key|p12|pfx|sqlite3?|db|zip|tgz|gz))$/i;
const examples = new Set(['you', 'user', 'example', 'tester', 'dev']);
const credentialShape = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;

function personalHome(line) {
  const unix = [...line.matchAll(/\/(?:home|Users)\/([A-Za-z0-9._-]+)/g)];
  const windows = [...line.matchAll(/\b[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/g)];
  return [...unix, ...windows].some((match) => !examples.has(match[1].toLowerCase()));
}

function withoutFences(text) {
  return text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, '');
}

function anchors(text) {
  const found = new Set();
  const counts = new Map();
  for (const line of withoutFences(text).split('\n')) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      const base = heading[1].replace(/<[^>]*>/g, '').toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
      const count = counts.get(base) || 0;
      found.add(base + (count ? `-${count}` : ''));
      counts.set(base, count + 1);
    }
    for (const match of line.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) found.add(match[1]);
  }
  return found;
}

function checkRelease(root) {
  const issues = [];
  const report = (file, check) => issues.push(`${file}: ${check}`);
  const manifestPath = path.join(root, 'release-files.json');
  let manifest;
  try {
    if (!fs.lstatSync(manifestPath).isFile()) throw new Error('not a regular file');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.files) || !manifest.files.length || !manifest.files.every(validPath)
      || new Set(manifest.files).size !== manifest.files.length) throw new Error('invalid paths');
  } catch {
    return { files: 0, issues: ['release-files.json: manifest must contain unique safe file paths and be a regular JSON file'] };
  }
  const files = new Set(manifest.files);
  const directories = new Set();
  for (const name of files) {
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent);
  }
  const exceptions = new Set();
  for (const exception of manifest.lineExceptions || []) {
    if (!exception || !files.has(exception.path) || !['personal-home-path', 'credential-shape'].includes(exception.check)
      || !/^[a-f0-9]{64}$/.test(exception.sha256) || !exception.reason) {
      report('release-files.json', 'invalid text exception');
    } else exceptions.add(`${exception.path}:${exception.check}:${exception.sha256}`);
  }
  const usedExceptions = new Set();
  const actual = new Set();
  const texts = new Map();
  function walk(relative = '') {
    let entries;
    try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); }
    catch { report(relative || '.', 'cannot read directory'); return; }
    for (const entry of entries) {
      // Git object/history scanning is a separate required Gitleaks command.
      if (!relative && entry.name === '.git') continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { report(name, 'symlink is not allowed in a release'); continue; }
      if (runtimeName.test(entry.name)) { report(name, 'runtime data is not allowed in a release'); continue; }
      if (entry.isDirectory()) {
        if (!directories.has(name)) report(name, 'unreviewed directory; inspect it before release');
        walk(name);
        continue;
      }
      if (!entry.isFile()) { report(name, 'not a regular source file'); continue; }
      actual.add(name);
      if (!files.has(name)) { report(name, 'unreviewed file; inspect it before updating the manifest'); continue; }
      try {
        if (fs.statSync(path.join(root, name)).size > 5 * 1024 * 1024) {
          report(name, 'file exceeds the 5 MiB text-review limit'); continue;
        }
        const bytes = fs.readFileSync(path.join(root, name));
        if (manifest.binaryFiles && Object.hasOwn(manifest.binaryFiles, name)) {
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            report(name, 'reviewed image is not a PNG');
          }
          if (sha256(bytes) !== manifest.binaryFiles[name]) report(name, 'reviewed image hash changed; inspect the capture again');
          continue;
        }
        if (manifest.sha256 && manifest.sha256[name] && sha256(bytes) !== manifest.sha256[name]) {
          report(name, 'pinned vendor hash changed; review the update');
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (text.includes('\u0000')) { report(name, 'binary content is not allowed'); continue; }
        texts.set(name, text);
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          for (const [check, matches] of [['personal-home-path', personalHome(line)], ['credential-shape', credentialShape.test(line)]]) {
            if (!matches) continue;
            const key = `${name}:${check}:${sha256(line)}`;
            if (exceptions.has(key)) usedExceptions.add(key);
            else report(`${name}:${index + 1}`, check);
          }
        }
      } catch { report(name, 'cannot read as UTF-8 text'); }
    }
  }
  walk();
  for (const name of files) if (!actual.has(name)) report(name, 'reviewed file is missing or is not a regular source file');
  for (const key of exceptions) if (!usedExceptions.has(key)) report('release-files.json', `stale text exception for ${key.split(':')[0]}`);
  for (const [name, hash] of Object.entries(manifest.sha256 || {})) {
    if (!files.has(name) || !/^[a-f0-9]{64}$/.test(hash)) report('release-files.json', 'invalid vendor hash entry');
  }
  for (const [name, hash] of Object.entries(manifest.binaryFiles || {})) {
    if (!files.has(name) || !/^docs\/images\/[a-z0-9-]+\.png$/.test(name) || !/^[a-f0-9]{64}$/.test(hash)) {
      report('release-files.json', 'invalid reviewed PNG entry');
    }
  }

  // Deliberately small Markdown check: inline links, reference definitions, ATX headings, and HTML ids.
  // External URLs are reviewed separately; no network requests are made here.
  for (const [name, text] of texts) {
    if (!name.endsWith('.md')) continue;
    const prose = withoutFences(text);
    const links = [...prose.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g),
      ...prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm)];
    for (const link of links) {
      const raw = link[1].startsWith('<') ? link[1].slice(1, -1) : link[1].split(/\s/)[0];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
      let target;
      try { target = decodeURIComponent(raw); }
      catch { report(name, 'invalid escaped local link'); continue; }
      const [destination, fragment] = target.split('#');
      const local = destination ? path.posix.normalize(path.posix.join(path.posix.dirname(name), destination.split('?')[0])) : name;
      if (destination.startsWith('/') || !validPath(local)) { report(name, 'link points outside the release'); continue; }
      if (!files.has(local)) { report(name, `local link is missing: ${local}`); continue; }
      if (fragment && local.endsWith('.md') && texts.has(local) && !anchors(texts.get(local)).has(fragment)) {
        report(name, `local heading is missing: ${local}#${fragment}`);
      }
    }
  }
  return { files: actual.size, issues: issues.sort() };
}

if (require.main === module) {
  try {
    const result = checkRelease(path.resolve(process.argv[2] || path.join(__dirname, '..')));
    if (result.issues.length) {
      console.error(`Release check failed (${result.issues.length} findings):\n${result.issues.map((issue) => `  ${issue}`).join('\n')}`);
      process.exitCode = 1;
    } else console.log(`Release check passed: ${result.files} reviewed files. Run Gitleaks on the working tree and full Git history separately.`);
  } catch {
    console.error('Release check failed: invalid manifest or unreadable tree.');
    process.exitCode = 1;
  }
}

module.exports = { checkRelease };
