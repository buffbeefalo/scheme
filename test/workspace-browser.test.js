'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

// Optional browser checks use a static loopback fixture and fictional sessions only.
// Set SCHEME_BROWSER_TESTS=1 with Playwright installed, or point
// SCHEME_PLAYWRIGHT_MODULE and SCHEME_CHROMIUM_EXECUTABLE to existing QA tools.
test('portable terminal workspace in a real browser', {
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
  async function screenshot(page, name) {
    if (!process.env.SCHEME_UI_SCREENSHOTS) return;
    await fs.mkdir(process.env.SCHEME_UI_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.SCHEME_UI_SCREENSHOTS, name + '.png') });
  }
  async function nextDump(state) {
    const deadline = Date.now() + 6000;
    while (!state.pending.length) {
      if (Date.now() > deadline) throw new Error('reader did not request output');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return state.pending.shift();
  }
  const sessions = [
    { id: 'cdexamplea', name: 'Review the example application', cwd: '/home/you/projects/example', codex: true },
    { id: 'cdexampleb', name: 'Check the documentation', cwd: '/home/you/projects/guide', codex: true },
  ];

  async function fixture({ mobile = false, blockedStorage = false, colorScheme = 'light', width = 390 } = {}) {
    const page = await browser.newPage({ viewport: { width: mobile ? width : 1360, height: 844 },
      hasTouch: mobile, isMobile: mobile, colorScheme, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const state = { frames: [], sockets: new Map(), errors: [], dumps: [], hold: false, pending: [], scroll: [] };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.addInitScript(({ blockedStorage }) => {
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 0); }
        close() { this.readyState = 2; }
      };
      if (blockedStorage) {
        for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { get() { throw new Error('storage blocked'); } });
      }
    }, { blockedStorage });
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), id = url.searchParams.get('id');
      let result = { ok: true };
      if (url.pathname === '/api/connect-info') result = { ok: true, host: 'scheme-example', home: '/home/you', sshUser: 'you', port: 3000 };
      else if (url.pathname === '/api/term/sessions') result = { ok: true, sessions };
      else if (url.pathname === '/api/term/projects') result = { ok: true, projects: [{ name: 'Example', path: '/home/you/projects/example' }] };
      else if (url.pathname === '/api/term/telemetry') result = { ok: true, started: false, telemetry: { runtime: 'codex', working: null, needsInput: null, waitingOnBackground: null } };
      else if (url.pathname === '/api/term/scrollstate') result = { ok: true, hist: 100, height: 30, pos: 0 };
      else if (url.pathname === '/api/term/scroll') state.scroll.push(route.request().postDataJSON());
      else if (url.pathname === '/api/term/dump') {
        state.dumps.push({ id, lines: url.searchParams.get('lines') });
        if (state.hold) { state.pending.push(route); return; }
        result = { ok: true, text: `Output for ${id}\n` + 'A readable line of example output.\n'.repeat(100), lines: 101, truncated: true };
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
    await page.waitForSelector('.xterm');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('Example terminal ready'));
    return { page, state };
  }

  await t.test('Auto, explicit themes and blocked storage preserve the real terminal', async () => {
    const { page, state } = await fixture({ blockedStorage: true, colorScheme: 'dark' });
    try {
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await page.locator('header [data-theme-select]').selectOption('light');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(238, 227, 205)');
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(238, 227, 205)');
      assert.equal(await page.locator('.xterm-viewport').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(23, 33, 26)');
      await screenshot(page, 'desktop-light');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.locator('header [data-theme-select]').selectOption('auto');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor === 'rgb(19, 26, 20)');
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(19, 26, 20)');
      await screenshot(page, 'desktop-dark');
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  await t.test('phone widths keep readable controls and use available keyboard space', async () => {
    const { page, state } = await fixture({ mobile: true });
    try {
      for (const width of [320, 344, 390, 700, 701, 904]) {
        await page.setViewportSize({ width, height: 844 });
        const size = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          buttons: ['cd-read', 'cd-write'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right }; }),
        }));
        assert.equal(size.overflow, false, `no horizontal page overflow at ${width}px`);
        if (width <= 700) assert.ok(size.buttons.every(b => b.w >= 44 && b.h >= 44 && b.right <= width));
        else assert.ok(size.buttons.every(b => b.w === 0 && b.h === 0));
      }
      await page.setViewportSize({ width: 320, height: 844 });
      await screenshot(page, 'phone-terminal');
      await page.locator('#cd-write').click();
      await page.locator('#cd-draft').fill('A draft\nwith room to edit.');
      await page.setViewportSize({ width: 320, height: 390 });
      await page.waitForFunction(() => document.body.classList.contains('cd-keyboard'));
      const draft = await page.locator('#cd-draft').boundingBox(), send = await page.locator('#cd-draft-send').boundingBox();
      assert.ok(draft.height >= 120, 'at least five lines remain available');
      assert.ok(send.y + send.height <= 390, 'send stays above the keyboard');
      await screenshot(page, 'phone-keyboard');
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  await t.test('theme text contrast and keyboard focus remain visible', async () => {
    const { page, state } = await fixture();
    try {
      for (const theme of ['light', 'dark']) {
        await page.locator('header [data-theme-select]').selectOption(theme);
        const failures = await page.evaluate(() => {
          const sample = document.createElement('span'); document.body.appendChild(sample);
          const luminance = color => {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255)
              .map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
            return channels.reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
          };
          const failures = [];
          for (const text of ['txt', 'mut', 'dim', 'faint', 'green2', 'cyan2', 'amber2', 'red2', 'violet2']) {
            for (const surface of ['bg', 's1', 's2', 's3', 'sage']) {
              sample.style.color = `var(--${text})`; sample.style.background = `var(--${surface})`;
              const css = getComputedStyle(sample), a = luminance(css.color), b = luminance(css.backgroundColor);
              const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
              if (ratio < 4.5) failures.push({ text, surface, ratio });
            }
          }
          sample.remove(); return failures;
        });
        assert.deepEqual(failures, [], `small text meets 4.5:1 in ${theme}`);
      }
      const choice = page.locator('header [data-theme-select]');
      await choice.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      assert.ok(await choice.evaluate(el => el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth) >= 2));
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  await t.test('drafts stay with their session and only explicit safe sending writes bytes', async () => {
    const { page, state } = await fixture({ mobile: true });
    try {
      await page.locator('#cd-write').click();
      await page.locator('#cd-draft').fill('First draft\n  keep indentation');
      await page.locator('#cd-sessions [data-id="cdexampleb"]').click();
      assert.equal(await page.locator('#cd-draft').inputValue(), '');
      await page.locator('#cd-draft').fill('Second draft');
      await page.locator('#cd-sessions [data-id="cdexamplea"]').click();
      assert.equal(await page.locator('#cd-draft').inputValue(), 'First draft\n  keep indentation');
      assert.equal(state.frames.filter(frame => frame.t === 'd').length, 0);
      state.sockets.get('cdexamplea').send(Buffer.from('\x1b[?2004lpaste disabled\r\n'));
      await page.waitForFunction(() => document.querySelector('.cd-term:not([style*="none"]) .xterm-rows')?.textContent.includes('paste disabled'));
      await page.locator('#cd-draft-insert').click();
      assert.ok((await page.locator('#cd-draft-status').innerText()).includes('not ready'));
      assert.equal(state.frames.filter(frame => frame.t === 'd').length, 0);
      state.sockets.get('cdexamplea').send(Buffer.from('\x1b[?2004hpaste enabled\r\n'));
      await page.waitForFunction(() => document.querySelector('.cd-term:not([style*="none"]) .xterm-rows')?.textContent.includes('paste enabled'));
      await page.locator('#cd-draft').fill('Safe\u001b[201~\n  text\u0003');
      await page.locator('#cd-draft-insert').click();
      assert.deepEqual(state.frames.filter(frame => frame.t === 'd'), [{ id: 'cdexamplea', t: 'd', d: '\x1b[200~Safe[201~\n  text\x1b[201~' }]);
      await page.locator('#cd-draft-insert').evaluate(el => el.click());
      assert.equal(state.frames.filter(frame => frame.t === 'd').length, 1, 'a sent draft cannot double-send');
      await page.reload();
      await page.waitForSelector('#boot', { state: 'detached' });
      await page.locator('#cd-write').click();
      assert.equal(await page.locator('#cd-draft').inputValue(), 'Safe\u001b[201~\n  text\u0003');
      assert.equal(await page.locator('#cd-draft-insert').isVisible(), false, 'reload preserves the already-inserted marker');
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  await t.test('reader ignores old responses after a session switch and keeps snapshots stable', async () => {
    const { page, state } = await fixture({ mobile: true });
    try {
      state.hold = true;
      await page.locator('#cd-read').click();
      await page.waitForFunction(() => document.getElementById('cd-copypanel').getAttribute('aria-busy') === 'true');
      const first = await nextDump(state);
      await page.locator('#cd-sessions [data-id="cdexampleb"]').click();
      const second = await nextDump(state);
      await second.fulfill({ json: { ok: true, text: 'Current session output', lines: 1 } });
      await page.waitForFunction(() => document.getElementById('cd-copyarea').value === 'Current session output');
      await first.fulfill({ json: { ok: true, text: 'Stale response from previous session', lines: 1 } });
      assert.equal(await page.locator('#cd-copyarea').inputValue(), 'Current session output');
      await page.locator('#cd-copyclose').click();
      state.hold = false;
      const count = state.dumps.length;
      await page.locator('#cd-read').click();
      assert.equal(await page.locator('#cd-copyarea').inputValue(), 'Current session output');
      assert.equal(state.dumps.length, count, 'reopening retains the snapshot until Refresh');
      await page.locator('#cd-reader-refresh').click();
      await page.waitForFunction(() => document.getElementById('cd-copyarea').value.includes('Output for cdexampleb'));
      await screenshot(page, 'phone-reader');
      assert.equal(state.dumps.at(-1).lines, '500');
      assert.deepEqual(state.scroll, [], 'reading never moves the terminal history');
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  await t.test('reconnection and changing screen size never submit a saved draft', async () => {
    const { page, state } = await fixture({ mobile: true });
    try {
      await page.locator('#cd-write').click();
      await page.locator('#cd-draft').fill('Keep this message until I send it.');
      state.sockets.get('cdexamplea').close();
      await page.waitForFunction(() => document.getElementById('cd-draft-insert').disabled);
      assert.equal(await page.locator('#cd-draft').inputValue(), 'Keep this message until I send it.');
      await page.waitForFunction(() => !document.getElementById('cd-draft-insert').disabled);
      assert.equal(state.frames.filter(frame => frame.t === 'd').length, 0);
      await page.setViewportSize({ width: 904, height: 844 });
      await page.waitForFunction(() => document.getElementById('cd-draft-panel').hidden);
      await page.locator('#cd-draft-send').evaluate(el => el.click());
      assert.equal(state.frames.filter(frame => frame.t === 'd').length, 0, 'a hidden control cannot send');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#cd-write').click();
      assert.equal(await page.locator('#cd-draft').inputValue(), 'Keep this message until I send it.');
      await page.locator('#cd-draft-send').click();
      assert.deepEqual(state.frames.filter(frame => frame.t === 'd'), [{ id: 'cdexamplea', t: 'd', d: '\x1b[200~Keep this message until I send it.\x1b[201~\r' }]);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  await t.test('search matches observed work and reports unread activity as unknown', async () => {
    const { page, state } = await fixture();
    try {
      await page.locator('#cd-switch').click();
      assert.ok((await page.locator('#cd-sw-list').textContent()).includes('activity unknown'));
      await page.evaluate(() => window.CommandDeckTerminal.lights({ cdexamplea: {
        working: true, needsInput: false, waitingOnBackground: false,
        ask: 'Check keyboard navigation', where: { label: 'Example', path: '/home/you/projects/example' },
        task: { sentence: 'Review the example application', from: 'first request' },
        lastAction: 'Read keyboard handling', lastActionAt: new Date().toISOString(),
      } }));
      await page.locator('#cd-sw-q').fill('keyboard navigation');
      assert.equal(await page.locator('.cd-sw-row').count(), 1);
      assert.ok((await page.locator('.cd-sw-row').textContent()).includes('working'));
      await screenshot(page, 'session-search');
      await page.evaluate(() => window.CommandDeckTerminal.lights({ cdexamplea: { working: null, needsInput: null, waitingOnBackground: null } }));
      assert.equal(await page.locator('.cd-sw-row').count(), 0, 'absent evidence leaves the old search results');
      await page.locator('#cd-sw-q').fill('');
      assert.ok((await page.locator('#cd-sw-list').textContent()).includes('activity unknown'));
      await page.locator('#cd-sw-close').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#cd-switcher').isVisible(), false);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
});
