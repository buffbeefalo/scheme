'use strict';

/* Reading and drafting are browser surfaces; tmux remains the terminal owner. */
window.CommandDeckWorkspace = {
  create({ getSession, api, refit }) {
    const $ = id => document.getElementById(id);
    const read = $('cd-read'), write = $('cd-write'), panel = $('cd-copypanel');
    const area = $('cd-copyarea'), hint = $('cd-copyhint'), copy = $('cd-copyall');
    const composer = $('cd-draft-panel'), draft = $('cd-draft'), insert = $('cd-draft-insert');
    const send = $('cd-draft-send'), newDraft = $('cd-draft-new'), readOutput = $('cd-draft-read');
    const draftStatus = $('cd-draft-status'), focus = $('cd-focus'), usage = $('cd-usage-toggle');
    const copyTrigger = $('cd-copytext'), tools = $('cd-tools'), studio = $('cd-studio');
    // Keep this identical to the CSS gate; read matches at action boundaries as well as
    // observing changes, so a queued media event cannot authorize a hidden control.
    const phoneMedia = matchMedia('(max-width:700px) and (pointer:coarse)');
    const isPhone = () => phoneMedia.matches;
    const desktopReaderStyle = {
      fontSize: area.style.fontSize, whiteSpace: area.style.whiteSpace,
      overflowWrap: area.style.overflowWrap, wrap: area.getAttribute('wrap'),
    };
    const drafts = new Map(), readers = new Map(), attempts = new Map();
    let composing = false;
    const earlier = $('cd-reader-earlier'), refreshButton = $('cd-reader-refresh');
    let readerId = null, readerLimit = 500, readInFlight = null;
    let draftId = null, readSeq = 0, copyTimer = null, readerReady = false;
    let phone = isPhone(), readerOpener = null;
    let readerSize = 16, wrap = true;
    try {
      readerSize = Math.min(24, Math.max(14, Number(localStorage.getItem('cd-reader-size')) || 16));
      wrap = localStorage.getItem('cd-reader-wrap') !== '0';
    } catch (_) {}

    function saveDraft() {
      if (!draftId) return;
      drafts.set(draftId, draft.value);
      try {
        if (draft.value) sessionStorage.setItem('cd-draft:' + draftId, draft.value);
        else sessionStorage.removeItem('cd-draft:' + draftId);
      } catch (_) {}
    }
    function loadDraft(id) {
      if (drafts.has(id)) return drafts.get(id);
      try { return sessionStorage.getItem('cd-draft:' + id) || ''; } catch (_) { return ''; }
    }
    function draftAttempt() {
      if (!draftId) return null;
      if (!attempts.has(draftId)) {
        let saved = null;
        try { saved = JSON.parse(sessionStorage.getItem('cd-draft-attempt:' + draftId)); } catch (_) {}
        attempts.set(draftId, saved);
      }
      const saved = attempts.get(draftId);
      return saved && saved.text === draft.value ? saved : null;
    }
    function setAttempt(value) {
      if (!draftId) return;
      attempts.set(draftId, value);
      try {
        if (value) sessionStorage.setItem('cd-draft-attempt:' + draftId, JSON.stringify(value));
        else sessionStorage.removeItem('cd-draft-attempt:' + draftId);
      } catch (_) {}
    }
    function draftHint() {
      const attempted = draftAttempt();
      draftStatus.textContent = attempted
        ? (attempted.submit ? 'Sent to terminal. Edit or start a new draft to send again.' : 'Inserted only. Use Enter in Terminal to submit.')
        : 'Enter adds a line. Send & Enter submits.';
    }
    function canInsert() {
      const s = getSession();
      return !!(isPhone() && !composer.hidden && s && s.id === draftId && s.term && s.ws && s.ws.readyState === 1 && draft.value.trim() && !draftAttempt() && !composing);
    }
    function updateInsert() {
      insert.disabled = send.disabled = !canInsert();
      newDraft.disabled = !draft.value;
      readOutput.hidden = !draftAttempt();
      insert.hidden = send.hidden = !!draftAttempt();
    }
    function restoreFocus(opener) {
      const target = [opener, isPhone() ? read : copyTrigger, tools, $('cd-sessions').querySelector('.active'), $('cd-new')]
        .find(el => el && !el.disabled && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
      target?.focus({ preventScroll: true });
    }
    function setDraftOpen(open) {
      if (!open) saveDraft();
      open = open && isPhone();
      composer.hidden = !open;
      write.setAttribute('aria-expanded', String(open));
      studio.classList.toggle('draft-open', open);
      updateInsert();
    }
    function closeReader({ returnFocus = true } = {}) {
      const wasOpen = !panel.hidden;
      rememberReader();
      readSeq++;
      panel.hidden = true;
      panel.setAttribute('aria-busy', 'false');
      read.setAttribute('aria-expanded', 'false');
      copyTrigger.setAttribute('aria-expanded', 'false');
      studio.classList.remove('reader-open');
      clearTimeout(copyTimer);
      copy.textContent = 'Copy all';
      if (returnFocus && wasOpen) restoreFocus(readerOpener);
    }
    function applyReaderStyle() {
      if (!isPhone()) {
        area.style.fontSize = desktopReaderStyle.fontSize;
        area.style.whiteSpace = desktopReaderStyle.whiteSpace;
        area.style.overflowWrap = desktopReaderStyle.overflowWrap;
        if (desktopReaderStyle.wrap === null) area.removeAttribute('wrap');
        else area.setAttribute('wrap', desktopReaderStyle.wrap);
        return;
      }
      area.style.fontSize = readerSize + 'px';
      area.setAttribute('wrap', wrap ? 'soft' : 'off');
      area.style.whiteSpace = wrap ? 'pre-wrap' : 'pre';
      area.style.overflowWrap = wrap ? 'anywhere' : 'normal';
      $('cd-reader-wrap').setAttribute('aria-pressed', String(wrap));
      $('cd-reader-minus').disabled = readerSize <= 14;
      $('cd-reader-plus').disabled = readerSize >= 24;
      try {
        localStorage.setItem('cd-reader-size', String(readerSize));
        localStorage.setItem('cd-reader-wrap', wrap ? '1' : '0');
      } catch (_) {}
    }
    function rememberReader() {
      const saved = readers.get(readerId);
      if (!phone || panel.hidden || !saved || saved.text !== area.value) return;
      saved.top = area.scrollTop; saved.start = area.selectionStart; saved.end = area.selectionEnd;
    }
    function readerHint(saved) {
      const at = new Date(saved.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `${saved.lines} lines · snapshot ${at} · Refresh for new output`;
    }
    function readerButtons(busy = false) {
      refreshButton.disabled = busy;
      earlier.disabled = busy || readerLimit >= 8000;
      earlier.textContent = readerLimit >= 8000 ? 'Full history window' : 'More history';
    }
    async function openReader({ refresh = false, expand = false } = {}) {
      const s = getSession();
      if (!s || (refresh && !isPhone())) return;
      const readingOnPhone = isPhone();
      if (!panel.hidden && readerId === s.id && readInFlight === readSeq) return;
      rememberReader();
      const reopening = panel.hidden || readerId !== s.id;
      readerOpener = readingOnPhone ? read : copyTrigger;
      setDraftOpen(false);
      tools.closest('.cd-bar').classList.remove('tools-open');
      tools.setAttribute('aria-expanded', 'false');
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      panel.hidden = false;
      readerOpener.setAttribute('aria-expanded', 'true');
      studio.classList.add('reader-open');
      $('cd-reader-session').textContent = s.name || 'Terminal output';
      const seq = ++readSeq, id = s.id;
      readerId = id;
      const saved = readingOnPhone && readers.get(id);
      if (reopening) {
        readerLimit = saved ? saved.limit : 500;
        area.value = saved ? saved.text : '';
        readerReady = !!area.value;
        if (saved) {
          area.setSelectionRange(saved.start, saved.end);
          area.scrollTop = saved.top;
          hint.textContent = readerHint(saved);
          readers.delete(id); readers.set(id, saved);
        }
      }
      copy.disabled = !readerReady;
      readerButtons();
      if (saved && reopening && !refresh && !expand) {
        panel.setAttribute('aria-busy', 'false');
        return;
      }
      const wasAtEnd = area.scrollHeight - area.scrollTop - area.clientHeight < 40;
      const previousScroll = area.scrollTop, previousHeight = area.scrollHeight;
      const previousStart = area.selectionStart, previousEnd = area.selectionEnd;
      const limit = expand ? Math.min(8000, readerLimit * 4) : readerLimit;
      hint.textContent = readerReady ? 'Refreshing snapshot…' : 'Loading recent output…';
      panel.setAttribute('aria-busy', 'true');
      readerButtons(true);
      readInFlight = seq;
      const result = await api('GET', '/api/term/dump?id=' + encodeURIComponent(id) + (readingOnPhone ? '&lines=' + limit : ''));
      if (readInFlight === seq) readInFlight = null;
      if (seq !== readSeq || panel.hidden || isPhone() !== readingOnPhone || getSession()?.id !== id) return;
      panel.setAttribute('aria-busy', 'false');
      readerButtons();
      if (!result.ok) {
        hint.textContent = readingOnPhone
          ? (readerReady ? 'Refresh unavailable · showing previous snapshot' : 'Output unavailable · tap Refresh to retry')
          : 'Output unavailable · close and reopen to retry';
        return;
      }
      const text = result.text || '', unchanged = area.value === text;
      if (!unchanged) area.value = text;
      readerReady = !!text;
      readerLimit = limit;
      copy.disabled = !readerReady;
      if (unchanged) area.setSelectionRange(previousStart, previousEnd);
      area.scrollTop = reopening && !saved ? area.scrollHeight
        : expand ? previousScroll + area.scrollHeight - previousHeight
        : wasAtEnd ? area.scrollHeight : previousScroll;
      if (readingOnPhone) {
        const snapshot = { text, lines: result.lines || 0, limit, at: Date.now(),
          top: area.scrollTop, start: area.selectionStart, end: area.selectionEnd };
        readers.delete(id); readers.set(id, snapshot);
        while (readers.size > 3) readers.delete(readers.keys().next().value);
        hint.textContent = readerHint(snapshot) + (result.truncated ? ' · recent tail' : '');
      } else hint.textContent = `${result.lines || 0} lines · select text to copy`;
      readerButtons();
    }
    async function copyAll() {
      if (!readerReady) return;
      const seq = readSeq, text = area.value;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
      if (!ok && seq === readSeq && !panel.hidden) {
        const top = area.scrollTop;
        try { area.focus(); area.select(); ok = document.execCommand('copy'); } catch (_) {}
        area.scrollTop = top;
      }
      if (seq !== readSeq || panel.hidden) return;
      copy.textContent = ok ? 'Copied' : 'Select text to copy';
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copy.textContent = 'Copy all'; }, 1800);
    }
    function sync() {
      const s = getSession(), id = s ? s.id : null;
      read.disabled = write.disabled = !s || !isPhone();
      if (id !== draftId) {
        saveDraft();
        draftId = id;
        draft.value = id ? loadDraft(id) : '';
        draftHint();
        if (!panel.hidden) {
          if (s) openReader(); else closeReader();
        }
      }
      $('cd-draft-target').textContent = s ? s.name || 'Current session' : 'No active session';
      draft.disabled = !s || !isPhone();
      if (!s) {
        setDraftOpen(false); closeReader();
        area.value = ''; readerReady = false; copy.disabled = true;
      }
      updateInsert();
    }
    read.onclick = () => { if (isPhone()) panel.hidden ? openReader() : closeReader(); };
    write.onclick = () => {
      if (!isPhone()) return;
      const open = composer.hidden;
      closeReader({ returnFocus: false }); setDraftOpen(open); sync();
      if (open) { draftHint(); draft.focus({ preventScroll: true }); }
      else restoreFocus(write);
    };
    $('cd-draft-close').onclick = () => { setDraftOpen(false); restoreFocus(write); };
    draft.addEventListener('input', () => {
      setAttempt(null); saveDraft(); updateInsert(); draftHint();
    });
    draft.addEventListener('compositionstart', () => { composing = true; updateInsert(); });
    draft.addEventListener('compositionend', () => { composing = false; updateInsert(); });
    composer.addEventListener('submit', e => e.preventDefault());
    function sendDraft(submit) {
      if (!isPhone() || composer.hidden || composing || draftAttempt()) return;
      if (!canInsert()) { draftStatus.textContent = 'Waiting for the terminal connection. Your draft is kept.'; return; }
      const s = getSession(), socket = s.ws;
      if (!s.term.modes.bracketedPasteMode) {
        draftStatus.textContent = 'Terminal is not ready for safe paste. Your draft is kept.';
        return;
      }
      const text = draft.value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
      if (!text.trim()) { draftStatus.textContent = 'Add text before sending.'; return; }
      if (getSession() !== s || s.id !== draftId || s.ws !== socket || socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify({ t: 'd', d: '\x1b[200~' + text + '\x1b[201~' + (submit ? '\r' : '') }));
      } catch (_) { draftStatus.textContent = 'Connection changed. Your draft is kept; try again.'; return; }
      setAttempt({ text: draft.value, submit });
      saveDraft(); updateInsert(); draftHint();
      draft.focus({ preventScroll: true });
    }
    insert.onclick = () => sendDraft(false);
    send.onclick = () => sendDraft(true);
    newDraft.onclick = () => {
      setAttempt(null); draft.value = ''; saveDraft(); updateInsert(); draftHint();
      draft.focus({ preventScroll: true });
    };
    readOutput.onclick = () => openReader({ refresh: true });
    refreshButton.onclick = () => openReader({ refresh: true });
    earlier.onclick = () => { if (isPhone()) openReader({ refresh: true, expand: true }); };
    $('cd-reader-start').onclick = () => { area.scrollTop = 0; };
    $('cd-reader-end').onclick = () => { area.scrollTop = area.scrollHeight; };
    $('cd-reader-minus').onclick = () => { if (isPhone()) { readerSize = Math.max(14, readerSize - 1); applyReaderStyle(); } };
    $('cd-reader-plus').onclick = () => { if (isPhone()) { readerSize = Math.min(24, readerSize + 1); applyReaderStyle(); } };
    $('cd-reader-wrap').onclick = () => { if (isPhone()) { wrap = !wrap; applyReaderStyle(); } };
    focus.onclick = () => {
      if (!isPhone()) return;
      const on = document.body.classList.toggle('cd-focus');
      focus.setAttribute('aria-pressed', String(on));
      focus.textContent = on ? 'Exit focus' : 'Focus';
      requestAnimationFrame(refit);
    };
    usage.onclick = () => {
      if (!isPhone()) return;
      const on = studio.classList.toggle('usage-expanded');
      usage.setAttribute('aria-expanded', String(on));
    };
    document.addEventListener('click', e => {
      if (!isPhone()) return;
      if (e.target.closest('#cd-img, #cd-rail-toggle, #cd-previnput')) {
        setDraftOpen(false);
        closeReader({ returnFocus: false });
      }
      if (!e.target.closest('#cd-tools, #cd-well') || e.target.closest('#cd-rail-toggle, #cd-copytext, #cd-previnput')) {
        tools.closest('.cd-bar').classList.remove('tools-open');
        tools.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !composer.hidden && composer.contains(e.target)) {
        e.preventDefault(); e.stopPropagation(); setDraftOpen(false); restoreFocus(write);
      }
    }, true);
    // iOS changes the visual viewport; Android can resize the layout viewport instead.
    let frame = null, restHeight = innerHeight;
    const viewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!isPhone()) {
          document.body.classList.remove('cd-keyboard');
          document.body.style.removeProperty('--cd-viewport-height');
          document.body.style.removeProperty('--cd-viewport-top');
          return;
        }
        const vv = window.visualViewport;
        if (vv && Math.abs(vv.scale - 1) > .05) return; // browser pinch zoom stays native
        const editing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '') && !document.activeElement.readOnly;
        if (!editing) restHeight = innerHeight;
        const height = vv ? Math.min(vv.height, innerHeight) : innerHeight;
        const top = vv ? Math.max(0, vv.offsetTop) : 0;
        document.body.classList.toggle('cd-keyboard', editing && (Math.max(restHeight, innerHeight) - height > 120 || height < 500));
        if (document.body.style.getPropertyValue('--cd-viewport-height') !== height + 'px')
          document.body.style.setProperty('--cd-viewport-height', height + 'px');
        if (document.body.style.getPropertyValue('--cd-viewport-top') !== top + 'px')
          document.body.style.setProperty('--cd-viewport-top', top + 'px');
      });
    };
    function syncPresentation() {
      if (phone === isPhone()) return;
      const activeElement = document.activeElement;
      const opener = !panel.hidden ? readerOpener : !composer.hidden ? write : activeElement;
      const returnFocus = !panel.hidden || !composer.hidden || [read, write, focus, usage].includes(activeElement)
        || $('cd-keybar').contains(activeElement) || $('cd-well').contains(activeElement);
      saveDraft(); rememberReader();
      phone = isPhone();
      setDraftOpen(false);
      closeReader({ returnFocus: false });
      document.body.classList.remove('cd-focus', 'cd-keyboard');
      document.body.style.removeProperty('--cd-viewport-height');
      document.body.style.removeProperty('--cd-viewport-top');
      studio.classList.remove('usage-expanded');
      focus.setAttribute('aria-pressed', 'false'); focus.textContent = 'Focus';
      usage.setAttribute('aria-expanded', 'false');
      tools.closest('.cd-bar').classList.remove('tools-open');
      tools.setAttribute('aria-expanded', 'false');
      panel.querySelector('.cd-copytitle').textContent = phone ? 'Read' : 'Copy text';
      applyReaderStyle(); sync();
      restHeight = innerHeight;
      if (returnFocus) restoreFocus(opener);
      viewport(); requestAnimationFrame(refit);
    }
    phoneMedia.addEventListener('change', syncPresentation);
    window.visualViewport?.addEventListener('resize', viewport);
    window.visualViewport?.addEventListener('scroll', viewport);
    addEventListener('resize', viewport);
    document.addEventListener('focusin', viewport);
    document.addEventListener('focusout', viewport);
    addEventListener('pagehide', saveDraft);
    panel.querySelector('.cd-copytitle').textContent = phone ? 'Read' : 'Copy text';
    applyReaderStyle(); viewport(); sync();
    return { sync, openReader, closeReader, copyAll, isPhone,
      isEditing: () => !panel.hidden || !composer.hidden,
      dropSession(id) {
        drafts.delete(id); readers.delete(id); attempts.delete(id);
        try { sessionStorage.removeItem('cd-draft-attempt:' + id); } catch (_) {}
        try { sessionStorage.removeItem('cd-draft:' + id); } catch (_) {}
        if (draftId === id) { draftId = null; draft.value = ''; }
      },
    };
  },
};
