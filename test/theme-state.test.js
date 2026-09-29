'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/vendor/terminal-theme.js'), 'utf8');

function boot({ saved = null, dark = false, blocked = false, noMedia = false } = {}) {
  const attrs = {}, events = {}, controls = [control(), control()];
  const media = { matches: dark, addEventListener: (_name, callback) => { media.change = callback; } };
  const storage = new Map([['cd-theme', saved]]);
  const root = { style: {}, setAttribute: (name, value) => { attrs[name] = value; } };
  let chrome;
  const context = {
    document: {
      readyState: 'loading', documentElement: root,
      querySelector: () => ({ setAttribute: (_name, value) => { chrome = value; } }),
      querySelectorAll: () => controls,
      addEventListener: (name, callback) => { events[name] = callback; },
    },
    localStorage: {
      getItem: key => { if (blocked) throw new Error('storage blocked'); return storage.get(key); },
      setItem: (key, value) => { if (blocked) throw new Error('storage blocked'); storage.set(key, value); },
    },
    window: {
      matchMedia: () => { if (noMedia) throw new Error('unavailable'); return media; },
      addEventListener: (name, callback) => { events[name] = callback; },
    },
  };
  vm.runInNewContext(source, context);
  return { attrs, root, controls, events, media, storage, chrome: () => chrome, theme: context.window.CommandDeckTheme };
}

function control() {
  return { value: '', addEventListener(_name, callback) { this.change = callback; } };
}

test('first paint resolves the device theme before controls are wired', () => {
  const page = boot({ dark: true });
  assert.equal(page.attrs['data-theme'], 'dark');
  assert.equal(page.attrs['data-theme-pref'], 'auto');
  assert.equal(page.root.style.colorScheme, 'dark');
  assert.equal(page.chrome(), '#131a14');
});

test('explicit preference ignores device changes until Auto is selected', () => {
  const page = boot({ saved: 'light', dark: true });
  page.events.DOMContentLoaded();
  assert.equal(page.attrs['data-theme'], 'light');
  page.media.change();
  assert.equal(page.attrs['data-theme'], 'light');
  page.controls[0].value = 'auto'; page.controls[0].change();
  assert.equal(page.attrs['data-theme'], 'dark');
  assert.equal(page.controls[1].value, 'auto');
  page.media.matches = false; page.media.change();
  assert.equal(page.attrs['data-theme'], 'light');
  assert.equal(page.chrome(), '#eee3cd');
  assert.equal(page.storage.get('cd-theme'), 'auto');
});

test('invalid preferences use Auto and blocked storage still allows manual changes', () => {
  assert.equal(boot({ saved: 'unexpected', dark: true }).attrs['data-theme'], 'dark');
  const page = boot({ blocked: true, dark: true });
  assert.equal(page.theme.getPreference(), 'auto');
  page.theme.set('light');
  assert.equal(page.attrs['data-theme'], 'light');
  assert.equal(page.theme.getPreference(), 'light');
});

test('missing device preference falls back to light without preventing dark selection', () => {
  const page = boot({ noMedia: true });
  assert.equal(page.theme.getResolved(), 'light');
  page.theme.set('dark');
  assert.equal(page.theme.getResolved(), 'dark');
});

test('browser tabs synchronize changes and storage clear returns to Auto', () => {
  const page = boot({ saved: 'dark' });
  page.events.storage({ key: 'unrelated', newValue: 'light' });
  assert.equal(page.theme.getResolved(), 'dark');
  page.events.storage({ key: 'cd-theme', newValue: 'light' });
  assert.equal(page.theme.getResolved(), 'light');
  page.media.matches = true;
  page.events.storage({ key: null, newValue: null });
  assert.equal(page.theme.getResolved(), 'dark');
  assert.equal(page.theme.getPreference(), 'auto');
});
