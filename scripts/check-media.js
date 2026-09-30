#!/usr/bin/env node
'use strict';

// The release's reviewed media contract is deliberately an exact set.
// Hashes record a content review; this script cannot perform that review.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ASSETS = Object.freeze([
  { path: 'media/scheme-product.mp4', source: 'release' },
  { path: 'media/scheme-setup.mp4', source: 'release' },
  { path: 'media/scheme-capabilities.mp4', source: 'release' },
  { path: 'captions/scheme-product.vtt', source: 'repository' },
  { path: 'captions/scheme-setup.vtt', source: 'repository' },
  { path: 'captions/scheme-capabilities.vtt', source: 'repository' },
  { path: 'transcripts/product-transcript.md', source: 'repository' },
  { path: 'transcripts/setup-transcript.md', source: 'repository' },
  { path: 'transcripts/capabilities-transcript.md', source: 'repository' },
]);
const MIB = 1024 * 1024;
const ROOT_FIELDS = ['schemaVersion', 'repository', 'releaseTag', 'reviewed', 'assets', 'films'];
function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}
function sha256(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(MIB);
  const fd = fs.openSync(file, 'r');
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, read));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function readText(file) {
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
}
function captionTime(value) {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : NaN;
}
function checkCaptions(text, duration) {
  if (!/^WEBVTT(?:[ \t][^\r\n]*)?\r?\n/.test(text) || text.includes('\u0000')) return 'invalid WebVTT';
  let cues = 0;
  let previousEnd = 0;
  for (const block of text.trim().split(/\r?\n[ \t]*\r?\n/).slice(1)) {
    if (/^NOTE(?:[ \t\r\n]|$)/.test(block)) continue;
    const lines = block.split(/\r?\n/);
    const index = lines[0].includes('-->') ? 0 : 1;
    const timing = /^(\S+) --> (\S+)$/.exec(lines[index] || '');
    if (!timing || !lines.slice(index + 1).join('').trim()) return 'invalid WebVTT cue';
    const start = captionTime(timing[1]);
    const end = captionTime(timing[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd - 0.001
      || end <= start || end > duration + 0.1) return 'caption timing is outside the film or out of order';
    previousEnd = end;
    cues++;
  }
  return cues ? null : 'WebVTT has no caption cues';
}

function checkMedia({ root = path.join(__dirname, '..'), mediaDir } = {}) {
  const issues = [];
  const report = (label, message) => issues.push(`${label}: ${message}`);
  const site = path.join(path.resolve(root), 'site');
  const directories = new Map();
  function directory(dir, label, expected) {
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) { report(label, 'symlink is not allowed'); return false; }
      if (!stat.isDirectory()) { report(label, 'not a directory'); return false; }
      if (expected) {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          // Never print names or contents of potentially private, unexpected files.
          if (!expected.has(item.name)) report(label, 'unexpected file or directory; review the input set');
          if (item.isSymbolicLink()) report(label, 'symlink is not allowed');
        }
      }
      return true;
    } catch { report(label, 'directory is missing or unreadable'); return false; }
  }
  if (!directory(site, 'site')) return { issues, manifest: null };
  let manifest;
  try {
    const file = path.join(site, 'media-manifest.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MIB) throw new Error('invalid');
    manifest = JSON.parse(readText(file));
  } catch {
    report('media manifest', 'must be a regular UTF-8 JSON file');
    return { issues, manifest: null };
  }
  if (!exactFields(manifest, ROOT_FIELDS)) {
    report('media manifest', 'unexpected or missing manifest fields');
    if (!manifest || typeof manifest !== 'object') return { issues, manifest: null };
  }
  if (manifest.schemaVersion !== 1 || manifest.repository !== 'buffbeefalo/scheme' || manifest.releaseTag !== 'v1.1.0') {
    report('media manifest', 'pinned release must be buffbeefalo/scheme v1.1.0, schema 1');
  }
  if (manifest.reviewed !== true) report('media manifest', 'content review is incomplete');
  if (!Array.isArray(manifest.assets)) {
    report('media manifest', 'assets must be the exact reviewed set');
    return { issues, manifest };
  }
  const expected = new Map(ASSETS.map((asset) => [asset.path, asset]));
  const assets = new Map();
  for (const asset of manifest.assets) {
    if (!exactFields(asset, ['path', 'source', 'sha256', 'bytes']) || !expected.has(asset.path)) {
      report('media manifest', 'unexpected asset or asset fields');
      continue;
    }
    if (assets.has(asset.path)) report(asset.path, 'duplicate asset');
    assets.set(asset.path, asset);
    if (asset.source !== expected.get(asset.path).source) report(asset.path, 'incorrect asset source');
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) report(asset.path, 'reviewed SHA-256 is missing or invalid');
    const maximum = asset.source === 'release' ? 750 * MIB : MIB;
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > maximum) report(asset.path, 'reviewed byte count is missing or out of bounds');
  }
  for (const asset of ASSETS) if (!assets.has(asset.path)) report(asset.path, 'missing asset in manifest');
  const films = new Map();
  if (!Array.isArray(manifest.films) || manifest.films.length !== 3) report('media manifest', 'exactly three films are required');
  for (const film of Array.isArray(manifest.films) ? manifest.films : []) {
    if (!exactFields(film, ['id', 'durationSeconds', 'width', 'height', 'chapters'])
      || !['product', 'setup', 'capabilities'].includes(film.id) || films.has(film.id)) {
      report('media manifest', 'unexpected or duplicate film');
      continue;
    }
    films.set(film.id, film);
    if (!Number.isFinite(film.durationSeconds) || film.durationSeconds <= 0 || film.durationSeconds > 1800
      || !Number.isSafeInteger(film.width) || !Number.isSafeInteger(film.height)
      || film.width < 320 || film.width > 7680 || film.height < 180 || film.height > 4320) report(film.id, 'reviewed film dimensions or duration are invalid');
    let previous = -1;
    if (!Array.isArray(film.chapters) || !film.chapters.length) report(film.id, 'chapters are missing');
    for (const [i, chapter] of (Array.isArray(film.chapters) ? film.chapters : []).entries()) {
      if (!exactFields(chapter, ['time', 'title']) || !Number.isFinite(chapter.time)
        || chapter.time <= previous || chapter.time >= film.durationSeconds || (i === 0 && chapter.time !== 0)
        || typeof chapter.title !== 'string' || !chapter.title.trim() || chapter.title.length > 100
        || /[\u0000-\u001f\u007f]/u.test(chapter.title)) report(film.id, 'chapters must be titled, ordered, and inside the film, starting at zero');
      previous = chapter?.time;
    }
  }
  for (const id of ['product', 'setup', 'capabilities']) if (!films.has(id)) report(id, 'film metadata is missing');

  directories.set('captions', directory(path.join(site, 'captions'), 'captions', new Set(['scheme-product.vtt', 'scheme-setup.vtt', 'scheme-capabilities.vtt'])));
  directories.set('transcripts', directory(path.join(site, 'transcripts'), 'transcripts', new Set(['product-transcript.md', 'setup-transcript.md', 'capabilities-transcript.md'])));
  directories.set('media', typeof mediaDir === 'string' && mediaDir.length > 0
    ? directory(path.resolve(mediaDir), 'release media', new Set(['scheme-product.mp4', 'scheme-setup.mp4', 'scheme-capabilities.mp4'])) : false);
  if (!mediaDir) report('release media', 'provide --media-dir with the three reviewed MP4 files');
  for (const contract of ASSETS) {
    const asset = assets.get(contract.path);
    if (!asset || !directories.get(contract.path.split('/')[0])) continue;
    const file = contract.source === 'release' ? path.join(path.resolve(mediaDir), path.basename(contract.path)) : path.join(site, contract.path);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { report(contract.path, 'symlink is not allowed'); continue; }
      if (!stat.isFile()) { report(contract.path, 'not a regular file'); continue; }
      if (stat.size > (contract.source === 'release' ? 750 * MIB : MIB)) { report(contract.path, 'file exceeds the size limit'); continue; }
      if (stat.size !== asset.bytes) report(contract.path, 'size differs from reviewed byte count');
      if (sha256(file) !== asset.sha256) report(contract.path, 'SHA-256 differs from reviewed content');
      if (contract.source === 'release') {
        const header = Buffer.alloc(12);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
        if (header.toString('ascii', 4, 8) !== 'ftyp' || header.readUInt32BE(0) < 8 || header.readUInt32BE(0) > stat.size) report(contract.path, 'not an MP4 container');
      } else {
        const text = readText(file);
        if (contract.path.endsWith('.vtt')) {
          const id = path.basename(contract.path, '.vtt').slice('scheme-'.length);
          const error = checkCaptions(text, films.get(id)?.durationSeconds || 0);
          if (error) report(contract.path, error);
        } else if (!/^# .+/m.test(text) || text.trim().length < 30 || text.includes('\u0000')) report(contract.path, 'readable transcript with a title is required');
      }
    } catch { report(contract.path, 'file is missing, unreadable, or not UTF-8 text'); }
  }
  const total = [...assets.values()].reduce((sum, asset) => sum + (Number.isSafeInteger(asset.bytes) ? asset.bytes : 0), 0);
  if (total > 900 * MIB) report('release media', 'combined media exceeds the 900 MiB site budget');
  return { issues, manifest };
}

function options(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(key) || Object.hasOwn(result, key) || !value || value.startsWith('--')) throw new Error('invalid arguments');
    result[key] = value;
  }
  return result;
}
if (require.main === module) {
  try {
    const args = options(process.argv.slice(2), ['--media-dir']);
    const result = checkMedia({ mediaDir: args['--media-dir'] });
    if (result.issues.length) {
      console.error(`Media check failed:\n${result.issues.map((issue) => `  ${issue}`).join('\n')}`);
      process.exitCode = 1;
    } else console.log('Media check passed: nine reviewed assets for v1.1.0.');
  } catch {
    console.error('Media check failed. Usage: node scripts/check-media.js --media-dir /path/to/reviewed-media');
    process.exitCode = 1;
  }
}
module.exports = { ASSETS, checkMedia, sha256, readText, options };
