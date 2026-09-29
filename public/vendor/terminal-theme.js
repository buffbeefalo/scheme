'use strict';

/* Runs synchronously in the head so stored/device colors are resolved before paint.
 * Storage is optional: a browser that blocks it still gets Auto and working controls. */
(function () {
  const root = document.documentElement;
  const valid = value => value === 'light' || value === 'dark' ? value : 'auto';
  let preference = 'auto', media = null;
  try { preference = valid(localStorage.getItem('cd-theme')); } catch (_) {}
  try { media = window.matchMedia('(prefers-color-scheme: dark)'); } catch (_) {}
  let resolved;

  function apply() {
    resolved = preference === 'dark' || (preference === 'auto' && media && media.matches) ? 'dark' : 'light';
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-theme-pref', preference);
    root.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#131a14' : '#eee3cd');
    document.querySelectorAll('[data-theme-select]').forEach(control => { control.value = preference; });
  }

  function set(value) {
    preference = valid(value);
    try { localStorage.setItem('cd-theme', preference); } catch (_) {}
    apply();
  }

  function wire() {
    document.querySelectorAll('[data-theme-select]').forEach(control => {
      control.addEventListener('change', () => set(control.value));
    });
    apply();
  }

  apply();
  if (media) {
    const changed = () => { if (preference === 'auto') apply(); };
    if (media.addEventListener) media.addEventListener('change', changed);
    else if (media.addListener) media.addListener(changed);
  }
  window.addEventListener('storage', event => {
    if (event.key === 'cd-theme' || event.key === null) { preference = valid(event.newValue); apply(); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();
  window.CommandDeckTheme = { set, getPreference: () => preference, getResolved: () => resolved };
})();
