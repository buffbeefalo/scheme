'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

// Exercise the actual staged public artifact, including decoded preview frames.
// Release media and browser tools stay outside the source archive.
test('public site motion and film controls in a browser', {
  skip: (process.env.SCHEME_BROWSER_TESTS !== '1' || !process.env.SCHEME_SITE_DIR)
    && 'set SCHEME_BROWSER_TESTS=1 and SCHEME_SITE_DIR to a reviewed static build',
}, async t => {
  const { chromium } = require(process.env.SCHEME_PLAYWRIGHT_MODULE || 'playwright');
  const root = path.resolve(process.env.SCHEME_SITE_DIR);
  const server = http.createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
    try {
      const body = await fs.readFile(file);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript',
        '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webm': 'video/webm',
        '.mp4': 'video/mp4', '.vtt': 'text/vtt' })[path.extname(file)] || 'application/octet-stream');
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.SCHEME_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SCHEME_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function open(options = {}) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, ...options });
    page.setDefaultTimeout(8000);
    const errors = [];
    const appRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) appRequests.push(request.url()); });
    t.after(async () => { assert.deepEqual(errors, []); assert.deepEqual(appRequests, []); await page.close(); });
    return page;
  }
  const playing = (page, id) => page.waitForFunction(id => {
    const video = document.getElementById(id);
    return video && !video.paused && video.currentTime > 0.1
      && video.getVideoPlaybackQuality().totalVideoFrames > 0;
  }, id);

  await t.test('visible previews decode frames and a manual pause survives scrolling', async () => {
    const page = await open();
    await page.goto(base);
    assert.equal(await page.locator('video[data-preview]').count(), 3);
    await playing(page, 'shell-preview');
    assert.deepEqual(await page.locator('#shell-preview').evaluate(video => ({
      muted: video.muted, loop: video.loop, controls: video.controls,
    })), { muted: true, loop: true, controls: false });
    const button = page.locator('[data-preview-toggle="shell-preview"]');
    await button.click();
    assert.equal(await page.locator('#shell-preview').evaluate(video => video.paused), true);
    await page.locator('#sessions-preview').scrollIntoViewIfNeeded();
    await playing(page, 'sessions-preview');
    await page.locator('#shell-preview').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#shell-preview').evaluate(video => video.paused), true);
    await button.focus();
    await page.keyboard.press('Enter');
    await playing(page, 'shell-preview');
  });

  await t.test('reduced motion defers clip downloads until the viewer requests playback', async () => {
    const page = await open({ reducedMotion: 'reduce' });
    const requests = [];
    page.on('request', request => { if (request.url().includes('-preview-v1.')) requests.push(request.url()); });
    await page.goto(base);
    await page.waitForTimeout(300);
    assert.deepEqual(requests, []);
    assert.equal(await page.locator('#shell-preview').evaluate(video => video.paused), true);
    await page.locator('[data-preview-toggle="shell-preview"]').click();
    await playing(page, 'shell-preview');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Deliver the first media-query change before toggling back; browsers may
    // coalesce two preference changes made in the same rendering frame.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.getElementById('shell-preview').paused);
  });

  await t.test('films pause previews and each other, while a preview never interrupts a film', async () => {
    const page = await open();
    await page.goto(base);
    await playing(page, 'shell-preview');
    // This Chromium may lack H.264. Use reviewed WebM bytes to test real playback
    // coordination; the original films get a separate codec-capable playback check.
    await page.evaluate(() => {
      for (const id of ['capabilities-film', 'product-film']) {
        const video = document.getElementById(id);
        video.querySelector('source').remove();
        video.src = 'previews/sessions-preview-v1.webm';
        video.load();
      }
    });
    await page.locator('[data-film-play="capabilities-film"]').click();
    await playing(page, 'capabilities-film');
    assert.equal(await page.locator('#shell-preview').evaluate(video => video.paused), true);
    await page.locator('#sessions-preview').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#sessions-preview').evaluate(video => video.paused), true);
    assert.equal(await page.locator('#capabilities-film').evaluate(video => video.paused), false);
    await page.locator('[data-film-play="product-film"]').click();
    await playing(page, 'product-film');
    assert.equal(await page.locator('#capabilities-film').evaluate(video => video.paused), true);
    await page.locator('#product-film').evaluate(video => { video.currentTime = 3; });
    await page.locator('[data-player="product-film"][data-time="0"]').click();
    await page.waitForFunction(() => document.getElementById('product-film').currentTime < 2);
    assert.equal(await page.locator('[data-player="product-film"][data-time="0"]').getAttribute('aria-current'), 'true');
    await page.locator('#product-film').evaluate(video => video.pause());
    await page.locator('#sessions-preview').scrollIntoViewIfNeeded();
    await playing(page, 'sessions-preview');
  });

  await t.test('looping resumes from the start and hidden-page signals suspend decoding', async () => {
    const page = await open();
    await page.goto(base);
    await playing(page, 'shell-preview');
    await page.locator('#shell-preview').evaluate(video => { video.currentTime = video.duration - 0.1; });
    await page.waitForFunction(() => document.getElementById('shell-preview').currentTime < 1);
    // Simulate the browser visibility boundary without depending on the headless
    // window manager deciding which of its tabs is in the foreground.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.locator('#shell-preview').evaluate(video => video.paused), true);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await playing(page, 'shell-preview');
  });

  await t.test('blocked autoplay leaves a working manual play button', async () => {
    const page = await open();
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        HTMLMediaElement.prototype.play = play;
        return Promise.reject(new DOMException('Autoplay denied for test', 'NotAllowedError'));
      };
    });
    await page.goto(base);
    await page.waitForFunction(() => document.getElementById('shell-preview').readyState >= 1);
    assert.equal(await page.locator('#shell-preview').evaluate(video => video.paused), true);
    await page.locator('[data-preview-toggle="shell-preview"]').click();
    await playing(page, 'shell-preview');
  });

  await t.test('unavailable preview files leave the poster and explain the unavailable control', async () => {
    const page = await open();
    await page.route('**/previews/**', route => route.abort());
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('[data-preview-toggle="shell-preview"]').disabled);
    assert.match(await page.locator('[data-preview-toggle="shell-preview"]').textContent(), /unavailable/i);
    assert.equal(await page.locator('#shell-preview').getAttribute('poster'), 'assets/scheme-desktop-demo.png');
  });

  await t.test('phone layout plays its view-only clip without horizontal overflow', async () => {
    const page = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(base + '/#inside');
    await page.locator('#phone-preview').scrollIntoViewIfNeeded();
    await playing(page, 'phone-preview');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('[data-preview-toggle="phone-preview"]').tap();
    assert.equal(await page.locator('#phone-preview').evaluate(video => video.paused), true);
  });

  await t.test('without JavaScript posters and native film controls remain usable', async () => {
    const page = await open({ javaScriptEnabled: false });
    await page.goto(base);
    assert.equal(await page.locator('video[data-preview]').count(), 3);
    assert.equal(await page.locator('video[data-preview][poster]').count(), 3);
    assert.equal(await page.locator('video[data-film][controls]').count(), 3);
    assert.equal(await page.locator('[data-preview-toggle]:visible').count(), 0);
    assert.equal(await page.locator('[data-film-play]:visible').count(), 0);
  });
});
