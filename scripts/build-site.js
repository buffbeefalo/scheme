#!/usr/bin/env node
'use strict';

// Build only the public presentation. Scheme's runtime and state are never inputs.
const fs = require('node:fs');
const path = require('node:path');
const { ASSETS, checkMedia, sha256, readText, options } = require('./check-media');

const STATIC_FILES = ['styles.css', 'site.js', 'icon.svg'];
const IMAGES = ['scheme-desktop-demo.png', 'scheme-mobile-demo.png', 'scheme-sessions-demo.png'];
const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function inline(text) {
  // Transcript authors can use emphasis and inline code. Raw HTML and links remain text.
  return escapeHTML(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function markdown(text) {
  const result = [];
  let paragraph = [];
  let list = [];
  const flush = () => {
    if (paragraph.length) result.push(`<p>${inline(paragraph.join(' '))}</p>`);
    if (list.length) result.push(`<ul>${list.map((line) => `<li>${inline(line)}</li>`).join('')}</ul>`);
    paragraph = [];
    list = [];
  };
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      // A page already has its own main heading; transcript headings begin at level two.
      const level = Math.min(heading[1].length + 1, 6);
      result.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet) {
      if (paragraph.length) flush();
      list.push(bullet[1]);
    } else if (!line.trim()) flush();
    else {
      if (list.length) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return result.join('\n');
}
function timeLabel(seconds) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('A site source is not a regular file.');
  return file;
}
function buildSite({ root = path.join(__dirname, '..'), mediaDir, out } = {}) {
  const checked = checkMedia({ root, mediaDir });
  if (checked.issues.length) throw new Error(`Media review must pass before building:\n${checked.issues.join('\n')}`);
  const sourceRoot = path.resolve(root);
  if (!out) throw new Error('An output directory is required.');
  const destination = path.resolve(out);
  const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
  if (inside(sourceRoot, destination) || inside(destination, sourceRoot) || inside(path.resolve(mediaDir), destination)
    || inside(destination, path.resolve(mediaDir))) throw new Error('Keep the site output outside the source and render directories.');
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(destination).length) throw new Error('The output directory must be empty and not a symlink.');
  }
  const site = path.join(sourceRoot, 'site');
  const content = new Map();
  const tokens = {};
  for (const film of checked.manifest.films) {
    const transcript = readText(regular(path.join(site, 'transcripts', `${film.id}-transcript.md`)));
    const html = markdown(transcript);
    tokens[`${film.id}Transcript`] = html;
    tokens[`${film.id}Duration`] = timeLabel(film.durationSeconds);
    tokens[`${film.id}Chapters`] = film.chapters.map((chapter) => `<a href="media/scheme-${film.id}.mp4#t=${chapter.time}" data-player="${film.id}-film" data-time="${chapter.time}"><time>${timeLabel(chapter.time)}</time><span>${escapeHTML(chapter.title)}</span></a>`).join('\n');
    const title = film.id === 'product' ? 'Scheme product film' : 'Scheme setup walkthrough';
    content.set(`transcripts/${film.id}-transcript.html`, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — transcript</title><link rel="icon" href="../icon.svg" type="image/svg+xml"><link rel="stylesheet" href="../styles.css"></head><body><main class="transcript-page"><a class="back-link" href="../#${film.id === 'product' ? 'watch' : 'setup'}">Back to the film</a><h1>${title}</h1><p>Complete transcript · ${timeLabel(film.durationSeconds)} · <a href="${film.id}-transcript.md" download>Download text</a></p><article class="transcript-text">${html}</article></main></body></html>\n`);
  }
  const template = readText(regular(path.join(site, 'index.html')));
  const used = new Set();
  const html = template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(tokens, key)) throw new Error('Unknown site template field.');
    used.add(key);
    return tokens[key];
  });
  if (used.size !== Object.keys(tokens).length) throw new Error('A required film field is missing from the site template.');
  content.set('index.html', html);
  content.set('.nojekyll', '');
  // Resolve every source before writing any output. Only these reviewed paths are copied.
  const copies = [
    ...STATIC_FILES.map((file) => [regular(path.join(site, file)), file]),
    ...IMAGES.map((file) => [regular(path.join(sourceRoot, 'docs', 'images', file)), `assets/${file}`]),
    ...ASSETS.map((asset) => [regular(asset.source === 'release' ? path.join(mediaDir, path.basename(asset.path)) : path.join(site, asset.path)), asset.path]),
    [regular(path.join(site, 'media-manifest.json')), 'media-manifest.json'],
  ];
  fs.mkdirSync(destination, { recursive: true });
  for (const [source, relative] of copies) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  // Verify the staged bytes as well: a changed input cannot silently pass after the first check.
  for (const asset of checked.manifest.assets) if (sha256(path.join(destination, asset.path)) !== asset.sha256) throw new Error('Staged media changed after review; discard this build.');
  for (const [relative, text] of content) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, { flag: 'wx' });
  }
  return { files: copies.length + content.size, destination };
}
if (require.main === module) {
  try {
    const args = options(process.argv.slice(2), ['--media-dir', '--out']);
    const result = buildSite({ mediaDir: args['--media-dir'], out: args['--out'] });
    console.log(`Static site built: ${result.files} explicit public files. No Scheme runtime is included.`);
  } catch (error) {
    console.error(`Site build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
module.exports = { buildSite, markdown, timeLabel };
