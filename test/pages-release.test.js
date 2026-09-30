'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRelease, recheckRelease, githubApi } = require('../scripts/pages-release.js');

const firstSha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const published = (tag = 'v1.1.1', id = 11) => ({
  id, tag_name: tag, draft: false, prerelease: false, published_at: '2026-09-30T12:00:00Z',
});
const manual = { repository: 'buffbeefalo/scheme', eventName: 'workflow_dispatch', ref: 'refs/heads/main', event: {} };
const releaseEvent = (release) => ({ ...manual, eventName: 'release', ref: `refs/tags/${release.tag_name}`, event: { action: 'published', release } });

function remote(release = published(), sha = firstSha) {
  const state = { release, sha, requests: [] };
  state.api = async (route) => {
    state.requests.push(route);
    if (route === '/repos/buffbeefalo/scheme/releases/latest') return structuredClone(state.release);
    if (route === `/repos/buffbeefalo/scheme/git/ref/tags/${encodeURIComponent(state.release.tag_name)}`) return { object: { type: 'commit', sha: state.sha } };
    throw new Error(`Unexpected API route: ${route}`);
  };
  return state;
}

test('manual main build selects GitHub latest published release and its resolved commit', async () => {
  const state = remote();
  assert.deepEqual(await selectRelease({ context: manual, api: state.api }), {
    tag: 'v1.1.1', sha: firstSha, releaseId: 11,
  });
  assert.deepEqual(state.requests, ['/repos/buffbeefalo/scheme/releases/latest', '/repos/buffbeefalo/scheme/git/ref/tags/v1.1.1']);
});

test('annotated release tags are peeled to commits without resolving a same-named branch', async () => {
  const requested = [];
  const api = async (route) => {
    requested.push(route);
    if (route.endsWith('/releases/latest')) return published();
    if (route.endsWith('/git/ref/tags/v1.1.1')) return { object: { type: 'tag', sha: nextSha } };
    if (route.endsWith(`/git/tags/${nextSha}`)) return { object: { type: 'commit', sha: firstSha } };
    if (route.endsWith('/commits/v1.1.1')) return { sha: 'c'.repeat(40) };
    throw new Error('Unexpected tag lookup');
  };
  const selected = await selectRelease({ context: manual, api });
  assert.equal(selected.sha, firstSha);
  assert.deepEqual(requested, ['/repos/buffbeefalo/scheme/releases/latest',
    '/repos/buffbeefalo/scheme/git/ref/tags/v1.1.1', `/repos/buffbeefalo/scheme/git/tags/${nextSha}`]);
});

test('non-commit tag targets and cyclic tag chains are refused', async () => {
  for (const type of ['tree', 'tag']) {
    let reads = 0;
    const api = async (route) => {
      reads += 1;
      if (reads > 12) throw new Error('unbounded tag chain');
      return route.endsWith('/releases/latest') ? published() : { object: { type, sha: firstSha } };
    };
    await assert.rejects(selectRelease({ context: manual, api }), /tag.*commit/);
  }
});

test('current published release event is accepted while old or prerelease events are refused', async () => {
  const state = remote();
  assert.equal((await selectRelease({ context: releaseEvent(published()), api: state.api })).sha, firstSha);
  for (const release of [published('v1.1.0', 10), { ...published(), prerelease: true }, { ...published(), draft: true }]) {
    await assert.rejects(selectRelease({ context: releaseEvent(release), api: state.api }), /current published stable release/);
  }
});

test('manual tag and branch runs, forks, and unsupported event types are refused', async () => {
  const state = remote();
  for (const context of [
    { ...manual, ref: 'refs/tags/v1.1.1' }, { ...manual, ref: 'refs/heads/preview' },
    { ...manual, repository: 'example/fork' }, { ...manual, eventName: 'push' },
  ]) await assert.rejects(selectRelease({ context, api: state.api }), /repository|main|event/);
});

test('latest-release data must prove publication and a safe stable tag', async () => {
  for (const release of [
    { ...published(), draft: true }, { ...published(), prerelease: true },
    { ...published(), published_at: null }, { ...published(), published_at: 'invalid' },
    { ...published(), tag_name: 'v2.0.0-beta.1' }, { ...published(), tag_name: 'v1.1.1\nsha=injected' },
    { ...published(), id: '11' },
  ]) {
    const state = remote(release);
    await assert.rejects(selectRelease({ context: manual, api: state.api }), /published stable release/);
    assert.equal(state.requests.length, 1, 'invalid release must not be used to resolve a tag');
  }
});

test('tag resolution and API errors fail closed', async () => {
  const invalid = remote(published(), 'main');
  await assert.rejects(selectRelease({ context: manual, api: invalid.api }), /commit/);
  await assert.rejects(selectRelease({ context: manual, api: async () => { throw new Error('offline'); } }), /offline/);
});

test('deployment recheck accepts exactly the release, commit, and package version built', async () => {
  const state = remote();
  const expected = await selectRelease({ context: manual, api: state.api });
  await recheckRelease({ context: manual, api: state.api, expected, head: firstSha, version: '1.1.1' });
  assert.equal(state.requests.length, 4, 'deployment must fetch release and tag again');
  await assert.rejects(recheckRelease({ context: manual, api: state.api, expected, head: nextSha, version: '1.1.1' }), /checked-out commit/);
  await assert.rejects(recheckRelease({ context: manual, api: state.api, expected, head: firstSha, version: '1.1.0' }), /package version/);
});

test('a newer release published while deployment is waiting prevents the queued build from deploying', async () => {
  const state = remote();
  const expected = await selectRelease({ context: manual, api: state.api });
  let releaseWait;
  const environmentWait = new Promise((resolve) => { releaseWait = resolve; });
  let deployed = false;
  const queued = (async () => {
    await environmentWait;
    await recheckRelease({ context: manual, api: state.api, expected, head: firstSha, version: '1.1.1' });
    deployed = true;
  })();
  state.release = published('v1.1.2', 12);
  state.sha = nextSha;
  releaseWait();
  await assert.rejects(queued, /changed since the build/);
  assert.equal(deployed, false);
});

test('moving the same release tag while waiting prevents deployment even when the version is unchanged', async () => {
  const state = remote();
  const expected = await selectRelease({ context: manual, api: state.api });
  await new Promise((resolve) => setImmediate(() => { state.sha = nextSha; resolve(); }));
  await assert.rejects(recheckRelease({ context: manual, api: state.api, expected, head: firstSha, version: '1.1.1' }), /changed since the build/);
});

test('deleting and recreating a release for the same tag does not reuse its earlier approval', async () => {
  const state = remote();
  const expected = await selectRelease({ context: manual, api: state.api });
  state.release.id = 12;
  await assert.rejects(recheckRelease({ context: manual, api: state.api, expected, head: firstSha, version: '1.1.1' }), /changed since the build/);
});

test('GitHub transport refuses redirects and non-success responses without printing response secrets', async () => {
  let request;
  const api = githubApi({ token: 'test-token', fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: false, status: 403, json: async () => ({ message: 'private response' }) };
  } });
  await assert.rejects(api('/repos/buffbeefalo/scheme/releases/latest'), (error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /private response|test-token/);
    return true;
  });
  assert.equal(request.url, 'https://api.github.com/repos/buffbeefalo/scheme/releases/latest');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['Cache-Control'], 'no-cache');
});
