'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

// These checks load the shipped page and xterm against fictional endpoints on an
// ephemeral loopback port. They never connect to Scheme or a real terminal.
test('reported frontend regressions in a real browser', {
  skip: process.env.SCHEME_BROWSER_TESTS !== '1' && 'set SCHEME_BROWSER_TESTS=1 for browser checks',
}, async t => {
  const { chromium } = require(process.env.SCHEME_PLAYWRIGHT_MODULE || 'playwright');
  const root = path.resolve(__dirname, '../public');
  const server = http.createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
    try {
      const body = await fs.readFile(file);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
      response.end(body);
    } catch (_) { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.SCHEME_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SCHEME_CHROMIUM_EXECUTABLE } : {}) });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sessions = [
    { id: 'cdexamplea', name: 'Example application', cwd: '/home/you/projects/example', codex: true },
    { id: 'cdexampleb', name: 'Example documentation', cwd: '/home/you/projects/guide', codex: true },
  ];
  const dataFrames = state => state.frames.filter(frame => frame.t === 'd');
  async function until(predicate, message) {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async function fixture({ mobile = false, legacyMedia = false, legacyObject = false,
    delayedRead = false, clock = false, shell = false, ready = true } = {}) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1360, height: 844 },
      hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const state = { frames: [], sockets: new Map(), errors: [], consoleErrors: [], scroll: [], uploads: [], pendingUploads: [],
      sessionResult: { ok: true, sessions: sessions.map(s => shell ? { ...s, codex: false, shell: true } : s) },
      sessionStatus: 200, sessionRequests: 0, holdUpload: false, holdList: false, pendingLists: [], pendingRenames: [] };
    page.on('pageerror', error => state.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') state.consoleErrors.push(message.text()); });
    await page.addInitScript(({ legacyMedia, legacyObject, delayedRead }) => {
      window.__qaEvents = [];
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { window.__qaEvents.push(this); this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
        close() { this.readyState = 2; }
      };
      window.__qaOpened = [];
      window.open = url => { window.__qaOpened.push(url); return null; };
      if (legacyObject) Object.hasOwn = undefined;
      if (legacyMedia) {
        const original = window.matchMedia.bind(window);
        window.matchMedia = query => {
          const media = original(query);
          media.addEventListener = undefined;
          media.removeEventListener = undefined;
          return media;
        };
      }
      if (delayedRead) {
        const Reader = window.FileReader;
        window.__qaReads = [];
        window.FileReader = class {
          readAsDataURL(file) {
            const reader = new Reader();
            reader.onload = () => {
              this.result = reader.result;
              window.__qaReads.push(() => this.onload?.({ target: this }));
            };
            reader.readAsDataURL(file);
          }
        };
      }
    }, { legacyMedia, legacyObject, delayedRead });
    if (clock) await page.clock.install();
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let result = { ok: true };
      if (url.pathname === '/api/connect-info') result = { ok: true, host: 'scheme-example', home: '/home/you', sshUser: 'you', port: 3000 };
      else if (url.pathname === '/api/term/sessions') {
        state.sessionRequests++;
        if (state.holdList) { state.pendingLists.push(route); return; }
        return route.fulfill({ status: state.sessionStatus, json: state.sessionResult });
      }
      else if (url.pathname === '/api/term/projects') result = { ok: true, projects: [] };
      else if (url.pathname === '/api/term/telemetry') result = { ok: true, started: false, telemetry: { runtime: 'codex', working: null, needsInput: null, waitingOnBackground: null } };
      else if (url.pathname === '/api/term/scrollstate') result = { ok: true, hist: 100, height: 30, pos: 20 };
      else if (url.pathname === '/api/term/scroll') state.scroll.push(route.request().postDataJSON());
      else if (url.pathname === '/api/term/rename' && state.holdRename) { state.pendingRenames.push(route); return; }
      else if (url.pathname === '/api/term/upload') {
        state.uploads.push(route.request().postDataJSON());
        if (state.holdUpload) { state.pendingUploads.push(route); return; }
        result = { ok: true, rel: '.cc-uploads/example.png' };
      }
      await route.fulfill({ json: result });
    });
    await page.routeWebSocket('**/api/term/attach?*', socket => {
      const id = new URL(socket.url()).searchParams.get('id');
      state.sockets.set(id, socket);
      socket.onMessage(raw => state.frames.push({ id, ...JSON.parse(String(raw)) }));
      socket.send(Buffer.from('\x1b[?2004hExample terminal ready\r\n'));
    });
    await page.goto(base);
    await page.waitForSelector('#boot', { state: 'detached' });
    if (ready) await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('Example terminal ready'));
    return { page, state };
  }

  async function pollList(page, state, result, status = 200) {
    state.sessionResult = result; state.sessionStatus = status;
    const before = state.sessionRequests;
    for (let i = 0; i < 8 && state.sessionRequests === before; i++) {
      await page.clock.runFor(3000);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(state.sessionRequests > before, 'a real periodic session request occurred');
    await page.clock.runFor(100);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  async function emit(page, payload) {
    await page.evaluate(payload => window.__qaEvents.at(-1).onmessage({ data: JSON.stringify(payload) }), payload);
  }
  async function switchTo(page, id) {
    await page.locator(`#cd-sessions [data-id="${id}"]`).click();
    await page.waitForFunction(id => window.CommandDeckTerminal.activeSessionId() === id, id);
  }
  async function beginSelection(page, state) {
    const host = await page.locator('#cd-host').boundingBox();
    await page.mouse.move(host.x + 70, host.y + 80);
    await page.mouse.down();
    await page.mouse.move(host.x + 70, host.y + 4);
    await until(() => state.scroll.length >= 2, 'selection drag did not begin scrolling');
  }
  async function assertScrollStopped(page, state, reason) {
    // One request can already be in flight when the cancellation event arrives.
    await page.waitForTimeout(100);
    const before = state.scroll.length;
    await page.waitForTimeout(220);
    assert.equal(state.scroll.length, before, reason);
  }

  await t.test('one missing session observation preserves its tab and draft; failed lists break the removal streak', async () => {
    const { page, state } = await fixture({ mobile: true, clock: true });
    try {
      await page.locator('#cd-write').click();
      await page.locator('#cd-draft').fill('Keep this draft through a transient list failure.');
      const missing = { ok: true, sessions: [sessions[1]] };
      await pollList(page, state, missing);
      assert.equal(await page.locator('#cd-sessions [data-id="cdexamplea"]').count(), 1, 'one omission must not remove a tab');
      assert.equal(await page.locator('#cd-draft').inputValue(), 'Keep this draft through a transient list failure.');
      await pollList(page, state, { ok: false, error: 'temporary listing failure' }, 503);
      await pollList(page, state, missing);
      assert.equal(await page.locator('#cd-sessions [data-id="cdexamplea"]').count(), 1, 'a failed request must break the consecutive omission streak');
      await pollList(page, state, missing);
      assert.equal(await page.locator('#cd-sessions [data-id="cdexamplea"]').count(), 0, 'two consecutive successful omissions remove the closed session');
      assert.equal(await page.evaluate(() => window.CommandDeckTerminal.activeSessionId()), 'cdexampleb', 'confirmed active closure selects the remaining tab');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('cd-draft:cdexamplea')), null, 'confirmed closure releases its draft');
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  await t.test('failed and malformed session responses keep tabs and drafts while reporting retrying', async () => {
    const { page, state } = await fixture({ mobile: true, clock: true });
    try {
      await page.locator('#cd-write').click();
      await page.locator('#cd-draft').fill('Keep this text when the list is unavailable.');
      for (const [result, status] of [
        [{ ok: true, sessions: [] }, 503],
        [{ ok: true, sessions: 'not a list' }, 200],
        [{ ok: true, sessions: [null] }, 200],
        [null, 200],
      ]) {
        await pollList(page, state, result, status);
        assert.equal(await page.locator('#cd-sessions .cd-sess').count(), 2);
        assert.equal(await page.locator('#cd-draft').inputValue(), 'Keep this text when the list is unavailable.');
        assert.match(await page.locator('#cd-switch').getAttribute('aria-label'), /unavailable.*retrying/);
      }
      await pollList(page, state, { ok: true, sessions });
      assert.doesNotMatch(await page.locator('#cd-switch').getAttribute('aria-label'), /unavailable/);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  await t.test('a session list requested before explicit closure cannot resurrect that session', async () => {
    const { page, state } = await fixture({ clock: true });
    try {
      state.holdList = true;
      await pollList(page, state, { ok: true, sessions });
      assert.equal(state.pendingLists.length, 1);
      state.holdList = false;
      state.sessionResult = { ok: true, sessions: [sessions[1]] };
      await page.locator('#cd-sessions [data-id="cdexamplea"] .cd-x').click();
      await page.locator('.cd-modal-ok').click();
      await page.waitForFunction(() => window.CommandDeckTerminal.activeSessionId() === 'cdexampleb');
      await state.pendingLists.shift().fulfill({ json: { ok: true, sessions } });
      await page.clock.runFor(200);
      await page.waitForTimeout(50);
      assert.equal(await page.locator('#cd-sessions [data-id="cdexamplea"]').count(), 0);
      assert.equal(await page.evaluate(() => window.CommandDeckTerminal.activeSessionId()), 'cdexampleb');
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  await t.test('a rename completed after its session closes is ignored without an error dialog', async () => {
    const { page, state } = await fixture();
    try {
      state.holdRename = true;
      await page.locator('#cd-sessions [data-id="cdexamplea"] .nm').dblclick();
      await page.locator('.cd-modal-input').fill('Renamed example');
      await page.locator('.cd-modal-ok').click();
      await until(() => state.pendingRenames.length === 1, 'rename did not start');
      state.sessionResult = { ok: true, sessions: [sessions[1]] };
      await page.locator('#cd-sessions [data-id="cdexamplea"] .cd-x').click();
      await page.locator('.cd-modal-ok').click();
      await page.waitForFunction(() => window.CommandDeckTerminal.activeSessionId() === 'cdexampleb');
      await state.pendingRenames.shift().fulfill({ json: { ok: true } });
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#cd-modal').getAttribute('aria-hidden'), 'true');
      assert.equal(await page.locator('#cd-sessions [data-id="cdexamplea"]').count(), 0);
    } finally { await page.close(); }
  });

  for (const chord of ['Alt+k', 'Control+k']) {
    await t.test(`${chord} opens the switcher while the real terminal has focus`, async () => {
      const { page, state } = await fixture();
      try {
        await page.locator('.xterm-helper-textarea').focus();
        await page.keyboard.press(chord);
        assert.equal(await page.locator('#cd-switcher').isVisible(), true);
        assert.deepEqual(dataFrames(state), [], 'the global shortcut must not type into the terminal');
      } finally { await page.close(); }
    });
  }
  await t.test('Ctrl+K remains a terminal keystroke in a plain shell', async () => {
    const { page, state } = await fixture({ shell: true });
    try {
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.press('Control+k');
      await until(() => dataFrames(state).length > 0, 'shell did not receive Ctrl+K');
      assert.equal(await page.locator('#cd-switcher').isVisible(), false);
      assert.deepEqual(dataFrames(state), [{ id: 'cdexamplea', t: 'd', d: '\x0b' }]);
    } finally { await page.close(); }
  });
  await t.test('switcher shortcuts preserve editing inside the draft', async () => {
    const { page, state } = await fixture({ mobile: true });
    try {
      await page.locator('#cd-write').click();
      await page.locator('#cd-draft').fill('An unfinished draft');
      await page.keyboard.press('Control+k');
      assert.equal(await page.locator('#cd-switcher').isVisible(), false);
      assert.deepEqual(dataFrames(state), []);
    } finally { await page.close(); }
  });
  await t.test('ordinary typing in the focused terminal still reaches its session', async () => {
    const { page, state } = await fixture();
    try {
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type('hello');
      await page.keyboard.press('Enter');
      await until(() => dataFrames(state).map(frame => frame.d).join('') === 'hello\r', 'ordinary typing did not reach its terminal');
      assert.ok(dataFrames(state).every(frame => frame.id === 'cdexamplea'));
      assert.equal(await page.locator('#cd-switcher').isVisible(), false);
    } finally { await page.close(); }
  });

  for (const source of ['file picker', 'clipboard']) await t.test(`an image from the ${source} stays with its initiating session while the file is read`, async () => {
    const { page, state } = await fixture({ delayedRead: true });
    try {
      if (source === 'file picker') await page.locator('#cd-file').setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: Buffer.from('fictional image') });
      else await page.locator('.xterm-helper-textarea').evaluate(el => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['fictional image'], 'example.png', { type: 'image/png' }));
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
      });
      await page.waitForFunction(() => window.__qaReads.length === 1);
      await switchTo(page, 'cdexampleb');
      await page.evaluate(() => window.__qaReads.shift()());
      await until(() => state.uploads.length === 1 && dataFrames(state).length === 1, 'image did not finish uploading');
      assert.equal(state.uploads[0].id, 'cdexamplea', 'the file-read delay must not retarget the upload');
      assert.deepEqual(dataFrames(state), [{ id: 'cdexamplea', t: 'd', d: '@.cc-uploads/example.png ' }]);
    } finally { await page.close(); }
  });
  await t.test('an image stays with its initiating session while the upload is pending', async () => {
    const { page, state } = await fixture();
    try {
      state.holdUpload = true;
      await page.locator('#cd-file').setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: Buffer.from('fictional image') });
      await until(() => state.pendingUploads.length === 1, 'image upload did not start');
      await switchTo(page, 'cdexampleb');
      await state.pendingUploads.shift().fulfill({ json: { ok: true, rel: '.cc-uploads/example.png' } });
      await until(() => dataFrames(state).length === 1, 'uploaded image reference was not inserted');
      assert.deepEqual(dataFrames(state), [{ id: 'cdexamplea', t: 'd', d: '@.cc-uploads/example.png ' }]);
    } finally { await page.close(); }
  });

  for (const cancellation of ['pointer release', 'released buttons', 'window blur', 'hidden document', 'session switch', 'view switch']) {
    await t.test(`selection autoscroll stops after ${cancellation}`, async () => {
      const { page, state } = await fixture();
      try {
        await beginSelection(page, state);
        if (cancellation === 'pointer release') await page.mouse.up();
        else if (cancellation === 'released buttons') await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 70, clientY: 100, buttons: 0 })));
        else if (cancellation === 'window blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        else if (cancellation === 'hidden document') await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        else if (cancellation === 'session switch') await page.locator('#cd-sessions [data-id="cdexampleb"]').evaluate(el => el.click());
        else await page.locator('#tab-connect').evaluate(el => el.click());
        await assertScrollStopped(page, state, `scrolling continued after ${cancellation}`);
      } finally { await page.close(); }
    });
  }

  for (const [name, payload] of [
    ['a frame without attention', { ts: 1, host: 'still alive' }],
    ['an unavailable attention field', { ts: 1, termAttention: null }],
    ['a failed session telemetry record', { ts: 1, termLights: { cdexamplea: { err: true } } }],
    ['an empty attention map from a failed session read', { ts: 1, termAttention: {}, termLights: { cdexamplea: { err: true } } }],
  ]) {
    await t.test(`an answer draft survives ${name}`, async () => {
      const { page, state } = await fixture();
      try {
        await emit(page, { ts: 1, termAttention: { cdexamplea: 'question' } });
        await page.locator('.need-input').fill('Keep my answer');
        await emit(page, payload);
        assert.equal(await page.locator('#needbar').isVisible(), true, 'unknown attention cannot dismiss the answer');
        assert.equal(await page.locator('.need-input').inputValue(), 'Keep my answer');
        await emit(page, { ts: 2, termAttention: {}, termLights: {} });
        assert.equal(await page.locator('#needbar').isVisible(), false, 'a successful empty attention map clears the bar');
        assert.deepEqual(state.errors, []);
      } finally { await page.close(); }
    });
  }

  await t.test('live telemetry works when Object.hasOwn is unavailable', async () => {
    const { page, state } = await fixture({ legacyObject: true });
    try {
      await emit(page, { ts: 1, host: 'updated-host', termLights: { cdexamplea: { working: true, needsInput: false, waitingOnBackground: false } } });
      assert.equal(await page.locator('#cd-sessions [data-id="cdexamplea"]').getAttribute('data-state'), 'busy');
      assert.equal(await page.locator('#host').textContent(), 'updated-host');
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  await t.test('legacy media-query listeners still boot the terminal and follow phone layout changes', async () => {
    const { page, state } = await fixture({ mobile: true, legacyMedia: true, ready: false });
    try {
      assert.deepEqual(state.errors, [], 'missing modern media-query listeners must not abort startup');
      await page.waitForSelector('.xterm');
      await page.locator('#cd-write').click();
      await page.locator('#cd-draft').fill('Preserve my phone draft');
      await page.setViewportSize({ width: 904, height: 844 });
      await page.waitForFunction(() => document.getElementById('cd-draft-panel').hidden);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#cd-write').click();
      assert.equal(await page.locator('#cd-draft').inputValue(), 'Preserve my phone draft');
    } finally { await page.close(); }
  });

  for (const [name, prefixFor, url] of [
    ['plain text', () => 'plain ', 'https://example.test/read'],
    ['CJK text', () => '猫猫 ', 'https://example.test/read'],
    ['combining text', () => 'e\u0301 ', 'https://example.test/read'],
    ['wrapped CJK text', cols => 'x'.repeat(cols - 6) + '猫猫 ', 'https://example.test/read'],
    ['a wide character wrapping within the URL', cols => 'x'.repeat(cols - 23) + ' ', 'https://example.test/猫/read'],
  ]) {
    await t.test(`the last URL character remains clickable after ${name}`, async () => {
      const { page, state } = await fixture();
      try {
        const cols = Number((await page.locator('#cd-dims').textContent()).split('×')[0]);
        const prefix = prefixFor(cols);
        state.sockets.get('cdexamplea').send(Buffer.from('\x1b[2J\x1b[H' + prefix + url + ' end\r\n'));
        await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('/read'));
        const point = await page.locator('.xterm-rows').evaluate(rows => {
          const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
          for (let node; (node = walker.nextNode());) {
            const i = node.textContent.indexOf('/read');
            if (i < 0) continue;
            const range = document.createRange();
            range.setStart(node, i + 4); range.setEnd(node, i + 5);
            const rect = range.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, after: rect.right + rect.width / 2 };
          }
          throw new Error('URL text node not found');
        });
        await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(150); // xterm resolves link hover before accepting activation.
        await page.mouse.click(point.x, point.y);
        assert.deepEqual(await page.evaluate(() => window.__qaOpened), [url]);
        await page.evaluate(() => { window.__qaOpened = []; });
        await page.mouse.move(point.after, point.y);
        await page.waitForTimeout(150);
        await page.mouse.click(point.after, point.y);
        assert.deepEqual(await page.evaluate(() => window.__qaOpened), [], 'the cell after a URL is not part of its hit target');
      } finally { await page.close(); }
    });
  }

  await t.test('a horizontal phone-keybar swipe scrolls without typing a terminal key', async () => {
    const { page, state } = await fixture({ mobile: true });
    try {
      const session = await page.context().newCDPSession(page);
      const rect = await page.locator('#cd-keybar [data-k="tab"]').boundingBox();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (const delta of [20, 45, 75, 100]) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - delta, y }] });
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.deepEqual(dataFrames(state), [], 'scrolling across a key cannot type that key');
      assert.ok(await page.locator('#cd-keybar').evaluate(el => el.scrollLeft > 0), 'the keybar remains horizontally scrollable');
      await session.detach();
    } finally { await page.close(); }
  });
  await t.test('a phone-keybar tap sends exactly one key', async () => {
    const { page, state } = await fixture({ mobile: true });
    try {
      await page.locator('.xterm-helper-textarea').focus();
      await page.locator('#cd-keybar [data-k="enter"]').tap();
      await until(() => dataFrames(state).length > 0, 'keybar tap did not reach the terminal');
      assert.deepEqual(dataFrames(state), [{ id: 'cdexamplea', t: 'd', d: '\r' }]);
      assert.equal(await page.locator('.xterm-helper-textarea').evaluate(el => el === document.activeElement), true, 'tapping a key keeps terminal input focused');
    } finally { await page.close(); }
  });
  for (const ending of ['long press', 'touch cancellation']) {
    await t.test(`a phone-keybar ${ending} does not type a key`, async () => {
      const { page, state } = await fixture({ mobile: true });
      try {
        const session = await page.context().newCDPSession(page);
        const rect = await page.locator('#cd-keybar [data-k="tab"]').boundingBox();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        if (ending === 'long press') await page.waitForTimeout(800);
        await session.send('Input.dispatchTouchEvent', { type: ending === 'long press' ? 'touchEnd' : 'touchCancel', touchPoints: [] });
        assert.deepEqual(dataFrames(state), []);
        await session.detach();
      } finally { await page.close(); }
    });
  }
  await t.test('a phone-keybar button remains usable from the keyboard', async () => {
    const { page, state } = await fixture({ mobile: true });
    try {
      await page.locator('#cd-keybar [data-k="enter"]').focus();
      await page.keyboard.press('Enter');
      await until(() => dataFrames(state).length > 0, 'keyboard activation did not reach the terminal');
      assert.deepEqual(dataFrames(state), [{ id: 'cdexamplea', t: 'd', d: '\r' }]);
    } finally { await page.close(); }
  });
});
