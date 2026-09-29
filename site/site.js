'use strict';

for (const link of document.querySelectorAll('[data-player][data-time]')) {
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const video = document.getElementById(link.dataset.player);
    const time = Number(link.dataset.time);
    if (!(video instanceof HTMLVideoElement) || !Number.isFinite(time) || time < 0) return;
    event.preventDefault();
    const seek = () => {
      if (!Number.isFinite(video.duration) || time >= video.duration) return;
      video.currentTime = time;
      video.play().catch(() => { /* Native controls remain available if playback needs another gesture. */ });
    };
    if (video.readyState >= 1) seek();
    else {
      video.addEventListener('loadedmetadata', seek, { once: true });
      video.load();
    }
    video.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    video.focus({ preventScroll: true });
  });
}
for (const video of document.querySelectorAll('video')) {
  const error = document.querySelector(`[data-error-for="${video.id}"]`);
  const showError = () => { if (error) error.hidden = false; };
  video.addEventListener('error', showError);
  for (const source of video.querySelectorAll('source')) source.addEventListener('error', showError);
  video.addEventListener('loadedmetadata', () => { if (error) error.hidden = true; });
  video.addEventListener('play', () => {
    for (const other of document.querySelectorAll('video')) if (other !== video) other.pause();
  });
  video.addEventListener('timeupdate', () => {
    const chapters = [...document.querySelectorAll(`[data-player="${video.id}"][data-time]`)];
    const current = chapters.findLast((link) => Number(link.dataset.time) <= video.currentTime);
    for (const chapter of chapters) {
      if (chapter === current) chapter.setAttribute('aria-current', 'true');
      else chapter.removeAttribute('aria-current');
    }
  });
}
