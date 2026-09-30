#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256, readText, options } = require('./check-media');

const IDS = ['shell', 'sessions', 'phone'];
const PREVIEW_FILES = IDS.flatMap(id => ['mp4', 'webm'].map(extension => `${id}-preview-v1.${extension}`));
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MIB = 1024 * 1024;

function checkPreviews({ root = path.join(__dirname, '..'), previewDir } = {}) {
  const issues = [];
  const reject = message => issues.push(message);
  let manifest;
  try {
    const site = path.join(root, 'site');
    const directory = fs.lstatSync(site);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error();
    const file = path.join(site, 'preview-manifest.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MIB) throw new Error();
    manifest = JSON.parse(readText(file));
  } catch { return { manifest: null, issues: ['Preview manifest must be regular UTF-8 JSON.'] }; }
  if (!exact(manifest, ['schemaVersion', 'repository', 'releaseTag', 'reviewed', 'provenance', 'assets', 'clips'])) {
    return { manifest, issues: ['Preview manifest fields are invalid.'] };
  }
  if (manifest.schemaVersion !== 1 || manifest.repository !== 'buffbeefalo/scheme' || manifest.releaseTag !== 'v1.1.1') {
    reject('Preview sources must stay pinned to buffbeefalo/scheme v1.1.1, schema 1.');
  }
  if (manifest.reviewed !== true) reject('Preview content review is incomplete.');
  if (typeof manifest.provenance !== 'string' || !manifest.provenance.trim()) reject('Preview provenance is missing.');
  const clips = Array.isArray(manifest.clips) ? manifest.clips : [];
  if (clips.length !== IDS.length || new Set(clips.map(clip => clip?.id)).size !== IDS.length) reject('Preview clip metadata must identify three different clips.');
  for (const clip of clips) {
    if (!exact(clip, ['id', 'durationSeconds', 'width', 'height', 'sourceCaptureSha256', 'sourceStartSeconds', 'description'])
      || !IDS.includes(clip.id) || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0 || clip.durationSeconds > 20
      || !Number.isSafeInteger(clip.width) || clip.width < 320 || clip.width > 1920
      || !Number.isSafeInteger(clip.height) || clip.height < 180 || clip.height > 1080
      || !hash(clip.sourceCaptureSha256) || !Number.isFinite(clip.sourceStartSeconds) || clip.sourceStartSeconds < 0
      || typeof clip.description !== 'string' || !clip.description.trim()) reject('Preview clip metadata is invalid.');
  }
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const expected = new Set(PREVIEW_FILES.map(file => `previews/${file}`));
  const seen = new Set();
  for (const asset of assets) {
    if (!exact(asset, ['path', 'sha256', 'bytes']) || !expected.has(asset.path) || seen.has(asset.path)
      || !hash(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 12 || asset.bytes > 2 * MIB) {
      reject('Preview asset set or reviewed metadata is invalid.');
      continue;
    }
    seen.add(asset.path);
  }
  if (assets.length !== expected.size || seen.size !== expected.size) reject('Preview asset set must include exactly the six reviewed formats.');
  if (!previewDir) return { manifest, issues: [...issues, 'Provide --preview-dir containing only the six reviewed preview files.'] };
  try {
    const stat = fs.lstatSync(previewDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    if (fs.readdirSync(previewDir).some(name => !PREVIEW_FILES.includes(name))) reject('Preview directory contains unexpected input; review the set.');
  } catch { return { manifest, issues: [...issues, 'Preview input must be a regular directory.'] }; }
  // Do not read a path derived from unvalidated manifest data.
  if (issues.length) return { manifest, issues };
  for (const asset of assets) {
    const file = path.join(previewDir, path.basename(asset.path));
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * MIB) throw new Error();
      if (stat.size !== asset.bytes || sha256(file) !== asset.sha256) { reject(`${asset.path}: differs from reviewed bytes.`); continue; }
      const bytes = fs.readFileSync(file);
      if (file.endsWith('.mp4') ? bytes.toString('ascii', 4, 8) !== 'ftyp'
        : bytes.subarray(0, 4).toString('hex') !== '1a45dfa3') reject(`${asset.path}: wrong video container.`);
    } catch { reject(`${asset.path}: must be a regular file with reviewed bytes.`); }
  }
  if (assets.reduce((sum, asset) => sum + asset.bytes, 0) > 6 * MIB) reject('Previews exceed the combined 6 MiB budget.');
  return { manifest, issues };
}

if (require.main === module) {
  try {
    const args = options(process.argv.slice(2), ['--preview-dir']);
    const result = checkPreviews({ previewDir: args['--preview-dir'] });
    if (result.issues.length) throw new Error(result.issues.join('\n'));
    console.log('Preview check passed: six reviewed silent preview formats pinned to v1.1.1.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { PREVIEW_FILES, checkPreviews };
