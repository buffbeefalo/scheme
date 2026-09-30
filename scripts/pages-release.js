#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const repository = 'buffbeefalo/scheme';
const stableTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const commitSha = /^[a-f0-9]{40}$/;

function publishedStable(release) {
  return release && release.draft === false && release.prerelease === false
    && Number.isSafeInteger(release.id) && release.id > 0 && stableTag.test(release.tag_name)
    && typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at));
}

function githubApi({ token, fetchImpl = fetch } = {}) {
  return async (route) => {
    if (!route.startsWith(`/repos/${repository}/`)) throw new Error('Unexpected GitHub API route');
    const response = await fetchImpl(`https://api.github.com${route}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Cache-Control': 'no-cache',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status})`);
    return response.json();
  };
}

async function selectRelease({ context, api }) {
  if (context.repository !== repository) throw new Error('Pages is restricted to the public Scheme repository');
  if (context.eventName === 'workflow_dispatch') {
    if (context.ref !== 'refs/heads/main') throw new Error('Manual Pages runs must start from main');
  } else if (context.eventName !== 'release') throw new Error('Unsupported Pages event');

  // GitHub's published latest release is authoritative. Higher draft or unassociated
  // Git tags are irrelevant; do not infer release readiness from tag ordering.
  const release = await api(`/repos/${repository}/releases/latest`);
  if (!publishedStable(release)) throw new Error('GitHub did not return a published stable release');
  if (context.eventName === 'release' && (context.event.action !== 'published'
    || !publishedStable(context.event.release) || context.event.release.id !== release.id
    || context.event.release.tag_name !== release.tag_name || context.ref !== `refs/tags/${release.tag_name}`)) {
    throw new Error('Release event does not identify the current published stable release');
  }
  // Resolve the tag namespace explicitly; a branch with the same name must not
  // shadow it. Both lightweight and annotated tags are supported.
  let target = (await api(`/repos/${repository}/git/ref/tags/${encodeURIComponent(release.tag_name)}`))?.object;
  const seen = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!target || !commitSha.test(target.sha) || seen.has(target.sha)) break;
    if (target.type === 'commit') return { tag: release.tag_name, sha: target.sha, releaseId: release.id };
    if (target.type !== 'tag') break;
    seen.add(target.sha);
    target = (await api(`/repos/${repository}/git/tags/${target.sha}`))?.object;
  }
  throw new Error('Release tag did not resolve to a commit');
}

async function recheckRelease({ context, api, expected, head, version }) {
  if (!expected || !stableTag.test(expected.tag) || !commitSha.test(expected.sha)
    || !Number.isSafeInteger(expected.releaseId) || expected.releaseId <= 0) throw new Error('Invalid built release identity');
  if (head !== expected.sha) throw new Error('The checked-out commit does not match the built release');
  if (`v${version}` !== expected.tag) throw new Error('The package version does not match the built release');
  const current = await selectRelease({ context, api });
  if (current.tag !== expected.tag || current.sha !== expected.sha || current.releaseId !== expected.releaseId) {
    throw new Error('The published release or tag commit changed since the build; start a fresh main Pages run');
  }
  return current;
}

async function main() {
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
  };
  const api = githubApi({ token: process.env.GITHUB_TOKEN });
  if (process.argv[2] === 'select') {
    const selected = await selectRelease({ context, api });
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `tag=${selected.tag}\nsha=${selected.sha}\nrelease_id=${selected.releaseId}\n`);
    console.log(`Selected published release ${selected.tag} at ${selected.sha}`);
  } else if (process.argv[2] === 'verify') {
    const expected = { tag: process.env.SCHEME_RELEASE_TAG, sha: process.env.SCHEME_RELEASE_SHA,
      releaseId: Number(process.env.SCHEME_RELEASE_ID) };
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    await recheckRelease({ context, api, expected, head, version });
    console.log(`Verified current published release ${expected.tag} at ${expected.sha}`);
  } else throw new Error('Usage: node scripts/pages-release.js select|verify');
}

if (require.main === module) main().catch((error) => {
  console.error(`Pages release guard: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { selectRelease, recheckRelease, githubApi };
