'use strict';

const films = [...document.querySelectorAll('video[data-film]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const previews = [...document.querySelectorAll('video[data-preview]')].map(video => ({
  video,
  button: document.querySelector(`[data-preview-toggle="${video.id}"]`),
  visible: false,
  wantsMotion: !reducedMotion.matches,
  loaded: false,
  pending: false,
  blocked: false,
  failed: false,
}));
const filmIsPlaying = () => films.some(video => !video.paused && !video.ended);
const canPlayPreview = preview => preview.wantsMotion && preview.visible && !document.hidden
  && !filmIsPlaying() && !preview.blocked && !preview.failed;

function updatePreviewButton(preview) {
  const { button, video } = preview;
  if (!button) return;
  const action = video.paused ? 'Play' : 'Pause';
  button.textContent = preview.failed ? 'Preview unavailable' : `${action} preview`;
  button.setAttribute('aria-label', preview.failed ? `${button.dataset.previewName} preview unavailable`
    : `${action} ${button.dataset.previewName} preview`);
  button.disabled = preview.failed;
}

function syncPreviews() {
  for (const preview of previews) {
    const { video } = preview;
    if (!canPlayPreview(preview)) video.pause();
    else if (video.paused && !preview.pending) {
      if (!preview.loaded) {
        let failedSources = 0;
        for (const format of ['webm', 'mp4']) {
          const source = document.createElement('source');
          source.src = video.dataset[format];
          source.type = `video/${format}`;
          source.addEventListener('error', () => {
            failedSources++;
            if (failedSources === 2) {
              preview.failed = true;
              video.pause();
              updatePreviewButton(preview);
            }
          });
          video.append(source);
        }
        video.muted = true;
        video.load();
        preview.loaded = true;
      }
      preview.pending = true;
      video.play().then(() => {
        if (!canPlayPreview(preview)) video.pause();
      }).catch(error => {
        // A scroll or visibility change can cancel a pending play without a media failure.
        if (error.name !== 'AbortError') preview.blocked = true;
      }).finally(() => {
        preview.pending = false;
        updatePreviewButton(preview);
        syncPreviews();
      });
    }
    updatePreviewButton(preview);
  }
}

for (const preview of previews) {
  const { video, button } = preview;
  if (button) {
    button.hidden = false;
    button.addEventListener('click', () => {
      preview.wantsMotion = video.paused && !preview.pending;
      preview.blocked = false;
      syncPreviews();
    });
  }
  video.addEventListener('play', () => updatePreviewButton(preview));
  video.addEventListener('pause', () => updatePreviewButton(preview));
  video.addEventListener('error', () => {
    preview.failed = true;
    video.pause();
    updatePreviewButton(preview);
  });
  updatePreviewButton(preview);
}
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const preview = previews.find(item => item.video === entry.target);
      if (preview) preview.visible = entry.isIntersecting && entry.intersectionRatio >= 0.25;
    }
    syncPreviews();
  }, { threshold: [0, 0.25] });
  for (const { video } of previews) observer.observe(video);
} else {
  // Older browsers keep still posters until a viewer explicitly asks for motion.
  for (const preview of previews) { preview.visible = true; preview.wantsMotion = false; }
}
document.addEventListener('visibilitychange', syncPreviews);
const motionChanged = () => {
  if (reducedMotion.matches) for (const preview of previews) preview.wantsMotion = false;
  syncPreviews();
};
if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', motionChanged);
else reducedMotion.addListener(motionChanged);

for (const link of document.querySelectorAll('[data-player][data-time]')) {
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const video = document.getElementById(link.dataset.player);
    const time = Number(link.dataset.time);
    if (!films.includes(video) || !Number.isFinite(time) || time < 0) return;
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
    video.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
    video.focus({ preventScroll: true });
  });
}
for (const video of films) {
  const error = document.querySelector(`[data-error-for="${video.id}"]`);
  const button = document.querySelector(`[data-film-play="${video.id}"]`);
  const showError = () => { if (error) error.hidden = false; };
  if (button) {
    button.hidden = false;
    button.addEventListener('click', () => video.play().catch(showError));
  }
  video.addEventListener('error', showError);
  for (const source of video.querySelectorAll('source')) source.addEventListener('error', showError);
  video.addEventListener('loadedmetadata', () => { if (error) error.hidden = true; });
  video.addEventListener('play', () => {
    if (button) button.hidden = true;
    for (const other of films) if (other !== video) other.pause();
    syncPreviews();
  });
  video.addEventListener('pause', syncPreviews);
  video.addEventListener('ended', () => { if (button) button.hidden = false; syncPreviews(); });
  video.addEventListener('timeupdate', () => {
    const chapters = [...document.querySelectorAll(`[data-player="${video.id}"][data-time]`)];
    const current = chapters.findLast(link => Number(link.dataset.time) <= video.currentTime);
    for (const chapter of chapters) {
      if (chapter === current) chapter.setAttribute('aria-current', 'true');
      else chapter.removeAttribute('aria-current');
    }
  });
}
