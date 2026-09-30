'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function previewFixture(root) {
  const site = path.join(root, 'site');
  const previewDir = path.join(root, 'preview-input');
  fs.mkdirSync(site, { recursive: true });
  fs.mkdirSync(previewDir);
  const manifest = { schemaVersion: 1, repository: 'buffbeefalo/scheme', releaseTag: 'v1.1.1',
    reviewed: true, provenance: 'Neutral demonstration captures used in the original public films.', assets: [], clips: [] };
  for (const id of ['shell', 'sessions', 'phone']) {
    manifest.clips.push({ id, durationSeconds: 6, width: 640, height: 360,
      sourceCaptureSha256: 'a'.repeat(64), sourceStartSeconds: 0, description: 'An example workflow.' });
    for (const extension of ['mp4', 'webm']) {
      const bytes = extension === 'mp4'
        ? Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
        : Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
      const name = `${id}-preview-v1.${extension}`;
      fs.writeFileSync(path.join(previewDir, name), bytes);
      manifest.assets.push({ path: `previews/${name}`, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  const write = () => fs.writeFileSync(path.join(site, 'preview-manifest.json'), JSON.stringify(manifest));
  write();
  return { root, site, previewDir, manifest, write };
}

module.exports = { previewFixture };
