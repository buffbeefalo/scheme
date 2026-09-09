'use strict';
/* Command Deck — full-screen terminal cockpit (Claude Code / Codex / local LLM / plain shell). GROUND-UP REBUILD (2026-06-02).
 *
 * Layout is pure CSS: on the terminal tab <body> is a viewport-height flex column
 * (body.term-tab) — nav on top, the xterm fills the rest. No height calc(), no JS
 * height: flexbox derives the size from the real viewport, so it can't be wrong.
 *
 * Sizing the TUI is driven by a ResizeObserver on the screen container — the one trigger
 * guaranteed to fire when the element actually has a size — plus a fit when the socket
 * opens. Terminals are opened LAZILY, only when their pane is visible; opening an xterm
 * into a display:none element is what previously left it stuck at 80×24 in a big pane.
 * The bar shows live cols×rows so sizing is never a mystery again.
 *
 * Transport unchanged: JSON {t:'d',d} input / {t:'r',c,r} resize over the loopback WS;
 * server→client frames are raw bytes. tmux owns persistence; closing a socket detaches. */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const elc = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  // The page supplies the host's home directory after connect-info arrives. Read it lazily;
  // the generic display fallback is only used before that host information is available.
  const homeDir = () => (document.documentElement.dataset && document.documentElement.dataset.home) || '/home/you';
  const tilde = (p) => String(p || '').replace(homeDir(), '~');
  const enc = encodeURIComponent;

  async function api(method, path, body) {
    try {
      const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      return { ...j, _status: r.status };
    } catch (e) { return { ok: false, _status: 0, error: e.message }; }
  }

  // On-brand modal replacing native alert/confirm/prompt (which look out of place and block).
  // Resolves: prompt -> string|null ; confirm -> bool ; alert (okOnly) -> true. Falls back to
  // the native dialog if the markup is somehow absent, so callers can always await a result.
  function cdModal(opts) {
    opts = opts || {};
    const isPrompt = typeof opts.input === 'string';
    return new Promise((resolve) => {
      const m = document.getElementById('cd-modal');
      if (!m) {
        if (isPrompt) return resolve(window.prompt(opts.message || '', opts.input));
        if (opts.okOnly) { try { window.alert(opts.message || ''); } catch (_) {} return resolve(true); }
        return resolve(window.confirm(opts.message || ''));
      }
      const q = (s) => m.querySelector(s);
      q('.cd-modal-title').textContent = opts.title || 'Confirm';
      q('.cd-modal-msg').textContent = opts.message || '';
      const inp = q('.cd-modal-input');
      if (isPrompt) { inp.style.display = 'block'; inp.value = opts.input || ''; } else { inp.style.display = 'none'; }
      const ok = q('.cd-modal-ok'), cancel = q('.cd-modal-cancel'), x = q('.cd-modal-x');
      const previousFocus = document.activeElement;
      ok.textContent = opts.okText || 'OK';
      ok.style.color = opts.danger ? 'var(--red2)' : 'var(--green2)';
      ok.style.borderColor = opts.danger ? 'rgba(197,58,32,.5)' : 'rgba(47,107,70,.45)';
      cancel.style.display = opts.okOnly ? 'none' : '';
      m.classList.add('open');
      m.setAttribute('aria-hidden', 'false');
      setTimeout(() => { try { if (isPrompt) { inp.focus(); inp.select(); } else ok.focus(); } catch (_) {} }, 30);
      const done = (val) => {
        m.classList.remove('open');
        m.setAttribute('aria-hidden', 'true');
        ok.onclick = cancel.onclick = x.onclick = null;
        document.removeEventListener('keydown', onkey, true);
        try { if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus(); } catch (_) {}
        resolve(val);
      };
      const onkey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(isPrompt ? null : (opts.okOnly ? true : false)); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (document.activeElement === cancel || document.activeElement === x) done(isPrompt ? null : (opts.okOnly ? true : false));
          else done(isPrompt ? inp.value : true);
        }
        else if (e.key === 'Tab') {
          const focusable = [inp, cancel, ok, x].filter((el) => el && el.style.display !== 'none' && !el.disabled);
          if (!focusable.length) return;
          const i = focusable.indexOf(document.activeElement), next = e.shiftKey
            ? focusable[(i <= 0 ? focusable.length : i) - 1]
            : focusable[(i + 1) % focusable.length];
          e.preventDefault(); next.focus();
        }
      };
      ok.onclick = () => done(isPrompt ? inp.value : true);
      cancel.onclick = x.onclick = () => done(isPrompt ? null : (opts.okOnly ? true : false));
      document.addEventListener('keydown', onkey, true);
    });
  }

  /* deep-forest well, warm cream foreground — matches the causehouse-light shell
     while staying dark (ANSI colors need a dark ground) */
  const THEME = {
    background: '#17211a', foreground: '#f2ead9', cursor: '#bfea4b', cursorAccent: '#17211a',
    selectionBackground: 'rgba(191,234,75,.30)', black: '#243228', red: '#e06248', green: '#8ecf9d',
    yellow: '#d9b04a', blue: '#8aaef0', magenta: '#b895dd', cyan: '#84c7ba', white: '#f2ead9',
    brightBlack: '#5f6f60', brightRed: '#ee7f68', brightGreen: '#a9dfb6', brightYellow: '#e8c56e',
    brightBlue: '#a5c1f5', brightMagenta: '#cdb0e9', brightCyan: '#a1d8cd', brightWhite: '#fffdf6',
  };
  const RT_META = {
    claude: { cursor: '#e88bb0', title: () => 'Claude Code (cloud · Anthropic)',
              tag: () => '<span class="cd-rtag" title="Claude Code (cloud · Anthropic)">✱</span>' },
    local: { cursor: '#bfea4b', title: (m) => `local LLM (${m} via Ollama — free)`,
             tag: (mEsc, short) => `<span class="cd-rtag" title="local LLM (${mEsc} via Ollama — free)">${short}</span>` },
    codex: { cursor: '#4cc4d0', title: (m) => `Codex (${m} · OpenAI ChatGPT auth)`,
             tag: (mEsc, short) => `<span class="cd-rtag" title="Codex (${mEsc} · OpenAI ChatGPT auth)">${short}</span>` },
    shell: { cursor: '#f2ead9', title: () => 'plain terminal (bare shell — no agent)',
             tag: () => '<span class="cd-rtag" title="plain terminal (bare shell — no agent)">&gt;_</span>' },
  };
  const RECONNECT_MS = 1500, TEL_MS = 3000, USAGE_MS = 30000;
  const SSE_LIGHTS_FRESH_MS = 7000;   // ≥3 missed 2s frames; worst-case fallback onset ≈ this + TEL_MS
  const sseLightsFresh = () => (Date.now() - lastLightsAt) < SSE_LIGHTS_FRESH_MS;
  const rtOf = (s) => s.local ? 'local' : s.codex ? 'codex' : s.shell ? 'shell' : 'claude';

  const S = new Map();
  let active = null, booted = false, els = {}, screenRO = null, dragged = null, dragPaintQueued = false, creatingSession = false, launchCommitted = false;
  let scrollDrag = false, lastHist = 0, scrollPoll = null, lastGoto = 0, pendingWheel = 0, wheelRaf = null, scrollPostInFlight = false, lastPos = 0, telPoll = null, scrollInFlight = false, telInFlight = false, telQueued = false, telTick = 0;
  let usagePoll = null, usageInFlight = false, lastAccountUsage = null, usageUpdateFailed = false;
  let lastLightsAt = -1e9, lastLightsMap = null;
  // Touch devices (phone/tablet) default smaller + railless so the TUI gets the columns;
  // explicit user choices (A−/A+, rail toggle) persist per-device and win over these.
  const COARSE = matchMedia('(pointer:coarse)').matches;
  let fontSize = Number(localStorage.getItem('cd-font')) || (COARSE ? 11 : 13);

  function cache() {
    els = {
      view: $('#view-terminal'), lock: $('#cd-lock'), studio: $('#cd-studio'),
      sessions: $('#cd-sessions'), host: $('#cd-host'), empty: $('#cd-empty'), dims: $('#cd-dims'), tok: $('#cd-tok'), rtChip: $('#cd-rt'),
      lane: $('#cd-lane'), lanePrev: $('#cd-prev'), laneNext: $('#cd-next'), countBtn: $('#cd-switch'),
      stripWrap: $('#cd-strip'), laneTrack: $('#cd-lane-track'), laneThumb: $('#cd-lane-thumb'),
      countN: $('#cd-count-n'), countOff: $('#cd-count-off'), toolsBtn: $('#cd-tools'), well: $('#cd-well'),
      sw: $('#cd-switcher'), swQ: $('#cd-sw-q'), swN: $('#cd-sw-n'), swList: $('#cd-sw-list'), swClose: $('#cd-sw-close'),
      newBtn: $('#cd-new'), newPop: $('#cd-new-pop'), proj: $('#cd-proj'), label: $('#cd-label'), create: $('#cd-create'), createLabel: $('#cd-create-label'),
      rtRadios: Array.from(document.querySelectorAll('input[name="cd-rt"]')),
      zoomIn: $('#cd-zoomin'), zoomOut: $('#cd-zoomout'), prevInput: $('#cd-previnput'),
      copyBtn: $('#cd-copytext'), copyPanel: $('#cd-copypanel'), copyArea: $('#cd-copyarea'), copyAll: $('#cd-copyall'), copyClose: $('#cd-copyclose'), copyHint: $('#cd-copyhint'),
      scroll: $('#cd-scroll'), thumb: $('#cd-scroll-thumb'), jump: $('#cd-jump'), ctx: $('#cd-ctx'),
      rail: $('#cd-rail'), railBody: $('#cd-railbody'), railToggle: $('#cd-rail-toggle'), vitals: $('#cd-vitals'),
      railTel: $('#cd-rail-tel'), railNotes: $('#cd-rail-notepad'), notes: $('#cd-notes'), notesState: $('#cd-notes-state'),
      usagebar: $('#cd-usagebar'), keybar: $('#cd-keybar'),
      imgBtn: $('#cd-img'), fileInput: $('#cd-file'),
    };
  }

  function applyRt(s) {
    const chip = els.rtChip;
    if (els.usagebar) { els.usagebar.style.display = 'none'; els.usagebar.textContent = ''; els.usagebar._h = ''; }
    els.studio.classList.remove('usagebar-on');
    if (s) {
      const rt = rtOf(s);
      const brainFull = s.localModel || 'backend default', codexFull = s.codexModel || 'backend default';
      const meta = rt === 'local' ? { glyph: '⌂', label: 'Local', title: `local LLM (${brainFull} via Ollama — free)` }
        : rt === 'codex' ? { glyph: '⌥', label: 'Codex', title: `Codex (${codexFull} · OpenAI ChatGPT auth)` }
          : rt === 'shell' ? { glyph: '>_', label: 'Shell', title: 'plain terminal (bare shell — no agent)' }
            : { glyph: '✱', label: 'Claude', title: 'Claude Code (cloud · Anthropic)' };
      els.studio.dataset.rt = rt;
      if (chip) {
        chip.querySelector('.g').textContent = meta.glyph;
        chip.querySelector('.lbl').textContent = meta.label;
        chip.title = meta.title;
        chip.style.display = 'inline-flex';
      }
      if (rt === 'claude' || rt === 'codex') renderAccountUsage(lastAccountUsage, usageUpdateFailed);
    } else {
      delete els.studio.dataset.rt;
      if (chip) chip.style.display = 'none';
    }
  }

  async function activate() {
    if (!booted) { booted = true; cache(); wire(); await boot(); return; }
    requestAnimationFrame(refit);   // returning to the tab — re-assert our size to this window
    refreshAccountUsage();
  }

  async function boot() {
    const r = await api('GET', '/api/term/sessions');
    if (r._status === 403 || r._status === 0) { els.lock.style.display = 'flex'; els.studio.style.display = 'none'; return; }
    els.lock.style.display = 'none'; els.studio.style.display = 'flex';
    try {
      const railPref = localStorage.getItem('cd-rail-off');
      if (railPref === '1' || (COARSE && railPref == null)) els.studio.classList.add('rail-off');
    } catch (_) {}
    // ONE ResizeObserver on the screen drives the fit for whichever session is active. It
    // fires when the container first gets a real size AND on every later change — bulletproof.
    if (window.ResizeObserver && !screenRO) {
      let t; screenRO = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(refit, 50); }); screenRO.observe(els.host);
    }
    renderSessions(r.sessions || []);
    await loadProjects();
    const list = r.sessions || [];
    // Re-open the tab you were actually on before the refresh, not always tab #1.
    let pick = null; try { const a = localStorage.getItem('cd-active'); if (a && list.some((s) => s.id === a)) pick = a; } catch (_) {}
    if (list.length) setActive(pick || list[0].id); else els.empty.style.display = 'flex';
    startScrollPoll();
    startTelPoll();
    startUsagePoll();
  }

  function refit() { const s = active && S.get(active); if (s && s.opened) fit(s); }

  // ── sessions ────────────────────────────────────────────────────────────────────
  // Register meta only; the heavy xterm+socket is built lazily on first activate (below).
  function renderSessions(list) {
    const known = new Set(list.map((s) => s.id));
    for (const id of [...S.keys()]) if (!known.has(id)) destroy(id);
    for (const meta of list) { const s = S.get(meta.id); if (s) { s.name = meta.name; s.cwd = meta.cwd; s.local = !!meta.local; s.localModel = meta.localModel || null; s.codex = !!meta.codex; s.codexModel = meta.codexModel || null; s.shell = !!meta.shell; s.createdAt = meta.createdAt || s.createdAt || null; } else register(meta); }
    if (lastLightsMap) applyLightsMap(lastLightsMap);   // replay the latest SSE lights over just-registered tabs (spec R2-F12)
    paint();
  }
  function register(meta) {
    // status starts 'live': the session list only ever contains LIVE tmux sessions, so an
    // unattached (never-clicked) tab is green, not grey — 'connecting/reconnecting' are
    // attach-socket states and only apply once the tab has been opened.
    // Restore the persisted "seen" turn so a done-glow earned before a refresh isn't wiped: with a
    // saved value we treat the baseline as already established (seenInit), so the first poll flags
    // attn iff the latest completed turn is newer than what the user last acknowledged.
    const seen = loadSeen()[meta.id] || null;
    const s = { id: meta.id, name: meta.name || meta.id, cwd: meta.cwd || '', createdAt: meta.createdAt || null, local: !!meta.local, localModel: meta.localModel || null, codex: !!meta.codex, codexModel: meta.codexModel || null, shell: !!meta.shell, term: null, fit: null, ws: null, pending: null, el: null, opened: false, status: 'live', userClosed: false, lastTurnId: null, seenTurnId: seen, seenInit: !!seen, working: false, lifecycleKnown: false, attn: false, needsInput: false, needsInputKind: null, waiting: false, lightsErr: false, telemetryUnknown: false,
      stateSince: null, lastActivity: null, contextTokens: null, contextWindow: null, modelShort: null };
    S.set(meta.id, s); return s;
  }
  // ── identity ────────────────────────────────────────────────────────────────
  // Sessions can share both a label and a working directory, so neither field alone identifies them
  // (council a6363f19). Stored names are NEVER rewritten; a colliding name is only DISPLAYED with
  // the shortest unique suffix of its stable tmux id (min 4 chars), so the same label appears on
  // the pill, in the switcher, in the title and in the accessible name.
  const MIN_SUFFIX = 4;
  let labelById = new Map();
  const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  function recomputeLabels() {
    const groups = new Map();
    for (const s of S.values()) {
      const k = normName(s.name);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    labelById = new Map();
    for (const members of groups.values()) {
      if (members.length < 2) { labelById.set(members[0].id, members[0].name); continue; }
      // shortest suffix length (>= MIN_SUFFIX) that separates every member of THIS group
      const ids = members.map((m) => m.id);
      let n = MIN_SUFFIX;
      const maxN = Math.max(...ids.map((i) => i.length));
      while (n < maxN && new Set(ids.map((i) => i.slice(-n))).size !== ids.length) n++;
      for (const m of members) labelById.set(m.id, `${m.name} · ${m.id.slice(-n)}`);
    }
  }
  const labelOf = (s) => labelById.get(s.id) || s.name;
  // Age of the tmux session itself. Deliberately NOT presented as "working for" — the two are
  // different facts and conflating them is exactly the lie the council forbade.
  function ageText(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h < 48 ? h + 'h' : Math.floor(h / 24) + 'd';
  }
  // How long the session has been in the state it is showing — a DIFFERENT fact from its age, and
  // the one the council forbade faking. The server sends the timestamp of the transcript event that
  // established the state, or null when the read window could not prove it; null renders "—" and is
  // never quietly backfilled from createdAt, the page load, or anything else at hand.
  function durText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h < 48 ? h + 'h' : Math.floor(h / 24) + 'd';
  }
  function sinceText(iso) {
    const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isFinite(at) ? durText(Date.now() - at) : '—';
  }
  // Occupancy is only a percentage when the window is actually known: an unknown denominator
  // shows the raw count instead of an invented fraction (lib/ctxwindow.js holds the same line).
  function ctxText(s) {
    if (!Number.isFinite(s.contextTokens)) return '—';
    const n = s.contextTokens >= 1000 ? Math.round(s.contextTokens / 1000) + 'k' : String(s.contextTokens);
    if (!Number.isFinite(s.contextWindow) || s.contextWindow <= 0) return n;
    return n + ' · ' + Math.round((s.contextTokens / s.contextWindow) * 100) + '%';
  }
  const stateOf = (s) => (s.needsInput ? 'needs-input' : s.waiting ? 'waiting' : s.working ? 'busy' : 'idle');
  const STATE_RANK = { 'needs-input': 4, waiting: 3, busy: 2, idle: 1 };

  function paint() {
    if (dragged) { dragPaintQueued = true; return; }   // a telemetry repaint mid-drag would destroy the dragged DOM
    recomputeLabels();
    els.sessions.innerHTML = '';
    for (const s of S.values()) {
      // Light priority: needs-input (cyan, blocked on YOU) > waiting (violet, idle but a spawned
      // subagent/workflow is still running) > busy (amber, actively generating) > idle (green).
      const stateCls = (s.needsInput ? ' needs-input' : (s.waiting ? ' waiting' : (s.working ? ' busy' : '')))
        + (s.telemetryUnknown ? ' telemetry-unknown' : '')
        + (s.telemetryUnknown && !s.lifecycleKnown ? ' lifecycle-unknown' : '');
      const row = elc('div', 'cd-sess st-' + s.status + stateCls + (s.attn ? ' attn' : '') + (s.id === active ? ' active' : ''));
      row.draggable = true; row.dataset.id = s.id;
      row.setAttribute('role', 'tab'); row.setAttribute('aria-controls', 'cd-host');
      row.setAttribute('aria-selected', s.id === active ? 'true' : 'false'); row.setAttribute('aria-keyshortcuts', 'Delete');
      row.tabIndex = s.id === active ? 0 : -1;
      row.dataset.rt = rtOf(s);
      const rt = rtOf(s);
      if (s.needsInput) row.dataset.needs = s.needsInputKind || 'question';
      const needLabel = s.needsInput ? '⚠ NEEDS YOUR INPUT (' + (s.needsInputKind === 'plan' ? 'approve plan' : 'pick an option') + ') · '
        : (s.waiting ? '◴ waiting on a subagent/workflow · ' : (s.telemetryUnknown ? '◇ telemetry partial · ' : ''));
      // Explicit automation overrides retain their short suffix; an unpinned tab is honestly
      // labelled backend default until live telemetry identifies the actual model.
      const brainFull = s.localModel || 'backend default';
      const brainTag = s.localModel === 'qwen3-coder:30b' ? '⌂ 30b' : s.localModel === 'glm-4.7-flash' ? '⌂ glm' : s.localModel === 'qwen3-coder-next' ? '⌂ next' : '⌂';
      // Codex uses the same rule: bare ⌥ means backend default, while explicit API overrides
      // retain their suffix and survive reboot-resume.
      const codexFull = s.codexModel || 'backend default';
      const codexTag = s.codexModel === 'gpt-5.6-sol' ? '⌥ sol' : s.codexModel === 'gpt-5.6-luna' ? '⌥ luna' : s.codexModel === 'gpt-5.5' ? '⌥ 5.5' : '⌥';
      const model = rt === 'local' ? brainFull : codexFull;
      const modelEsc = rt === 'local' ? esc(brainFull) : esc(codexFull);
      const tag = rt === 'local' ? brainTag : codexTag;
      const rtTitle = RT_META[rt].title(model);
      const shown = labelOf(s);
      row.title = needLabel + rtTitle + ' · double-click to rename · drag to reorder · ' + (tilde(s.cwd) || 'claude');
      row.setAttribute('aria-label', needLabel + shown + ' · ' + rtTitle + ' · Delete closes session');
      const runtimeTag = RT_META[rt].tag(modelEsc, tag);
      row.innerHTML = `<span class="cd-dot"></span><span class="nm">${esc(shown)}</span>${runtimeTag}<span class="cd-x" aria-hidden="true" title="close / delete this session">✕</span>`;
      row.querySelector('.nm').ondblclick = (e) => { e.stopPropagation(); renameSession(s); };
      row.querySelector('.cd-x').onclick = (e) => { e.stopPropagation(); killSession(s.id); };
      row.onclick = () => { if (!dragged) setActive(s.id); };   // a drag must not also switch tabs
      row.onkeydown = (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(s.id); return; }
        if (e.key === 'Delete') { e.preventDefault(); killSession(s.id); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); const ids = [...S.keys()], at = ids.indexOf(s.id);
        const ni = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
        const nextId = ids[ni]; setActive(nextId);
        requestAnimationFrame(() => { const next = els.sessions.querySelector(`[data-id="${nextId}"]`); if (next) next.focus(); });
      };
      row.addEventListener('dragstart', (e) => { dragged = s.id; row.classList.add('dragging'); els.sessions.classList.add('drag-live'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); } catch (_) {} });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); endDrag(); });
      // Show WHERE the tab will land: a glowing insertion bar on the left or right edge of the
      // hovered tab, picked by which half of it the pointer is in. Drop honors the same edge.
      row.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (_) {} markDrop(row, dropBefore(row, e)); });
      row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); moveTab(dragged || (e.dataTransfer && e.dataTransfer.getData('text/plain')), s.id, dropBefore(row, e)); });
      els.sessions.appendChild(row);
    }
    measureLane();
  }

  // ── lane overflow ───────────────────────────────────────────────────────────
  // The native scrollbar measured 0px tall at every width, so nothing told you 11 of 17 pills
  // were off-screen. Counts, fades and arrows are the guaranteed affordance instead.
  function measureLane() {
    if (!els.lane || !els.sessions) return;
    const strip = els.sessions, r = strip.getBoundingClientRect();
    const pills = Array.from(strip.querySelectorAll('.cd-sess'));
    const offscreen = pills.filter((p) => {
      const b = p.getBoundingClientRect();
      return b.left < r.left - 0.5 || b.right > r.right + 0.5;
    });
    if (els.countN) els.countN.textContent = String(pills.length);
    // The word is dropped on phone widths (CSS), where those ~70px are worth more as session pills.
    if (els.countOff) els.countOff.innerHTML = offscreen.length
      ? ` · ${offscreen.length}<span class="ow"> off-screen</span>` : '';
    if (els.countBtn) {
      els.countBtn.setAttribute('aria-label', offscreen.length
        ? `All ${pills.length} sessions — ${offscreen.length} off-screen`
        : `All ${pills.length} sessions`);
      // Worst state among the pills you CANNOT see, so a hidden session asking for you still shows.
      let agg = '';
      for (const p of offscreen) {
        const s = S.get(p.dataset.id);
        if (!s) continue;
        const st = stateOf(s);
        if (!agg || STATE_RANK[st] > STATE_RANK[agg]) agg = st;
      }
      if (agg && agg !== 'idle') els.countBtn.dataset.agg = agg; else delete els.countBtn.dataset.agg;
    }
    const laneR = els.lane.getBoundingClientRect();
    els.lane.style.setProperty('--fade-l', Math.max(0, Math.round(r.left - laneR.left)) + 'px');
    els.lane.style.setProperty('--fade-r', Math.max(0, Math.round(laneR.right - r.right)) + 'px');
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    els.lane.classList.toggle('more-left', left);
    els.lane.classList.toggle('more-right', right);
    if (els.lanePrev) els.lanePrev.disabled = !left;
    if (els.laneNext) els.laneNext.disabled = !right;
    // Slider under the names: shown only on overflow; thumb width = visible share, offset = scroll share.
    const over = strip.scrollWidth > strip.clientWidth + 1;
    if (els.stripWrap) els.stripWrap.classList.toggle('has-overflow', over);
    if (over && els.laneTrack && els.laneThumb) {
      const tw = els.laneTrack.clientWidth;
      const w = Math.max(24, Math.round(tw * strip.clientWidth / strip.scrollWidth));
      const x = Math.round((tw - w) * strip.scrollLeft / (strip.scrollWidth - strip.clientWidth));
      els.laneThumb.style.width = w + 'px';
      els.laneThumb.style.transform = 'translateX(' + Math.max(0, Math.min(tw - w, x)) + 'px)';
    }
  }
  function scrollPillIntoView(id) {
    const el = els.sessions && els.sessions.querySelector(`[data-id="${id}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measureLane();
  }
  // ── session switcher ────────────────────────────────────────────────────────
  // Lives OUTSIDE #cd-sessions on purpose: paint() rebuilds that list wholesale every 2s, which
  // would destroy an open dialog mid-keystroke. #cd-sessions stays the one canonical tablist.
  let swOpen = false, swSel = 0, swRows = [], swReturnFocus = null;
  const STATE_TEXT = { 'needs-input': 'needs you', waiting: 'waiting', busy: 'working', idle: 'idle' };
  function swMatches(s, q) {
    if (!q) return true;
    return (labelOf(s) + ' ' + s.name + ' ' + s.id + ' ' + (s.cwd || '')).toLowerCase().includes(q);
  }
  function renderSwitcher() {
    if (!els.swList) return;
    const q = (els.swQ && els.swQ.value || '').trim().toLowerCase();
    const all = Array.from(S.values());
    // Canonical order, except anything blocked on YOU is lifted to the top.
    const list = all.filter((s) => swMatches(s, q));
    list.sort((a, b) => (b.needsInput ? 1 : 0) - (a.needsInput ? 1 : 0));
    swRows = list;
    if (els.swN) els.swN.textContent = q ? `${list.length} of ${all.length}` : `${all.length} sessions`;
    if (!list.length) { els.swList.innerHTML = '<div class="cd-sw-empty">No session matches that search.</div>'; return; }
    els.swList.innerHTML = list.map((s, i) => {
      const st = stateOf(s), rt = rtOf(s);
      const age = ageText(Date.now() - (s.createdAt || 0));
      const glyph = rt === 'claude' ? '✱' : rt === 'codex' ? '⌥' : rt === 'local' ? '⌂' : '>_';
      // Every fact is labelled, because three durations sit side by side here and an unlabelled
      // number is the fastest way to read one as another.
      const meta = [
        glyph + (s.modelShort ? ' ' + esc(s.modelShort) : ''),
        'open ' + esc(age),
        'last ' + esc(sinceText(s.lastActivity)),
        esc(ctxText(s)),
      ].concat(s.telemetryUnknown ? ['partial telemetry'] : []).join(' · ');
      return `<button type="button" class="cd-sw-row${i === swSel ? ' sel' : ''}" role="option" data-id="${esc(s.id)}"
        aria-selected="${s.id === active ? 'true' : 'false'}">
        <span class="cd-dot" data-s="${st}"></span>
        <span class="sw-body">
          <span class="sw-top">
            <span class="sw-nm">${esc(labelOf(s))}</span>
            ${s.attn ? '<span class="sw-attn">new</span>' : ''}
            <span class="sw-state" data-s="${st}">${STATE_TEXT[st]}</span>
            <span class="sw-dur">· ${esc(sinceText(s.stateSince))}</span>
          </span>
          <span class="sw-meta">${meta}</span>
        </span>
      </button>`;
    }).join('');
    Array.from(els.swList.querySelectorAll('.cd-sw-row')).forEach((el, i) => {
      el.onclick = () => { setActive(el.dataset.id); closeSwitcher(); };
      el.onmouseenter = () => { swSel = i; markSwSel(); };
    });
  }
  function markSwSel() {
    Array.from(els.swList.querySelectorAll('.cd-sw-row')).forEach((el, i) => el.classList.toggle('sel', i === swSel));
    const cur = els.swList.querySelector('.cd-sw-row.sel');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function openSwitcher() {
    if (!els.sw || swOpen) return;
    swOpen = true; swSel = 0; swReturnFocus = document.activeElement;
    els.sw.hidden = false;
    if (els.countBtn) els.countBtn.setAttribute('aria-expanded', 'true');
    if (els.swQ) els.swQ.value = '';
    renderSwitcher();
    if (els.swQ) els.swQ.focus();
  }
  function closeSwitcher() {
    if (!els.sw || !swOpen) return;
    swOpen = false;
    els.sw.hidden = true;
    if (els.countBtn) els.countBtn.setAttribute('aria-expanded', 'false');
    const back = swReturnFocus; swReturnFocus = null;
    if (back && back.focus) { try { back.focus(); } catch (_) {} }
  }
  function swKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSwitcher(); return; }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const s = swRows[swSel]; if (s) { setActive(s.id); closeSwitcher(); }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (!swRows.length) return;
      swSel = e.key === 'Home' ? 0 : e.key === 'End' ? swRows.length - 1
        : (swSel + (e.key === 'ArrowDown' ? 1 : -1) + swRows.length) % swRows.length;
      markSwSel();
      return;
    }
    if (e.key === 'Tab') {   // focus trap: the dialog is search + list + close, nothing beyond
      e.preventDefault(); e.stopPropagation();
      if (document.activeElement === els.swQ && els.swClose) els.swClose.focus(); else if (els.swQ) els.swQ.focus();
    }
  }

  // ── drag-to-reorder visuals ────────────────────────────────────────────────────
  const dropBefore = (row, e) => { const r = row.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; };
  function clearDropMarks() { for (const el of els.sessions.querySelectorAll('.drop-before,.drop-after')) el.classList.remove('drop-before', 'drop-after'); }
  function markDrop(row, before) {
    clearDropMarks();
    if (row && row.dataset.id !== dragged) row.classList.add(before ? 'drop-before' : 'drop-after');
  }
  function endDrag() {
    clearDropMarks(); els.sessions.classList.remove('drag-live');
    setTimeout(() => { dragged = null; if (dragPaintQueued) { dragPaintQueued = false; paint(); } }, 0);
  }
  // Reorder tabs (drag-drop): insert dragId before/after targetId (or at the end when dropped
  // on empty bar space), then persist so it sticks across reload AND reboot (server writes the
  // new order into the session registry).
  function moveTab(dragId, targetId, before) {
    if (!dragId || dragId === targetId || !S.has(dragId)) return;
    const ids = [...S.keys()];
    ids.splice(ids.indexOf(dragId), 1);
    let to = targetId == null ? ids.length : ids.indexOf(targetId);
    if (to < 0) to = ids.length;
    else if (!before && targetId != null) to += 1;
    ids.splice(to, 0, dragId);
    const entries = ids.map((id) => [id, S.get(id)]);
    S.clear(); for (const [id, s] of entries) S.set(id, s);
    endDrag();   // clear drag state BEFORE paint so the rebuild isn't deferred
    paint();
    api('POST', '/api/term/reorder', { ids });
  }
  function setStatus(s, st) { s.status = st; paint(); }

  // Send a keystroke / data chunk to a session's PTY. If the socket isn't OPEN yet — a freshly
  // activated tab still mid-handshake (e.g. the tab auto-selected right after a /handoff), or a
  // reconnect in flight — QUEUE the bytes and flush them on open instead of dropping them silently.
  // Without this, the first keys typed into a just-opened tab were lost, which is why a new handoff
  // tab needed Esc pressed twice: the first Esc raced the WebSocket and vanished. Capped so a socket
  // that never opens can't grow the queue without bound (oldest dropped, newest keystrokes kept).
  function sendData(s, d) {
    if (!s || d == null || d === '') return;
    if (s.ws && s.ws.readyState === 1) { s.ws.send(JSON.stringify({ t: 'd', d })); return; }
    (s.pending || (s.pending = [])).push(d);
    while (s.pending.length > 512) s.pending.shift();
  }
  function flushPending(s) {
    if (!s || !s.ws || s.ws.readyState !== 1 || !s.pending || !s.pending.length) return;
    const q = s.pending; s.pending = null;
    for (const d of q) s.ws.send(JSON.stringify({ t: 'd', d }));
  }

  // ── xterm + websocket (built lazily, ONLY while the pane is visible) ───────────────
  // Make http(s) URLs in terminal output clickable (open in a new tab). The web terminal had NO
  // native link handling, so URLs Claude prints were dead text — clicking did nothing (whereas a
  // native terminal on the box opens them). findUrlLinks maps a logical (possibly wrapped) line's
  // URL matches back to xterm 1-based cell ranges; wireLinks registers them on a terminal.
  function openUrl(u) { try { window.open(u, '_blank', 'noopener,noreferrer'); } catch (_) {} }
  function findUrlLinks(text, cols, startRow) {
    const out = []; const re = /https?:\/\/\S+/g; let m;
    while ((m = re.exec(text))) {
      const url = m[0].replace(/[)\].,;:!?'"]+$/, '');                 // drop trailing punctuation
      if (url.length < 8) continue;
      const so = m.index, eo = m.index + url.length - 1;
      out.push({ text: url, range: {
        start: { x: (so % cols) + 1, y: startRow + Math.floor(so / cols) + 1 },
        end:   { x: (eo % cols) + 1, y: startRow + Math.floor(eo / cols) + 1 } } });
    }
    return out;
  }
  function wireLinks(term) {
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const buf = term.buffer.active, cols = term.cols;
        let start = y - 1;                                              // 0-based; walk up to the logical line start
        while (start > 0) { const ln = buf.getLine(start); if (ln && ln.isWrapped) start--; else break; }
        let text = '', row = start;                                     // rebuild the full (unwrapped) logical line
        for (;;) { const ln = buf.getLine(row); if (!ln) break; text += ln.translateToString(false); const nx = buf.getLine(row + 1); if (nx && nx.isWrapped) row++; else break; }
        const links = findUrlLinks(text, cols, start).map((l) => ({ text: l.text, range: l.range, activate(_e, t) { openUrl(t); }, hover() {}, leave() {} }));
        callback(links.length ? links : undefined);
      },
    });
  }

  function ensureOpen(s) {
    if (s.opened) return;
    const el = elc('div', 'cd-term'); els.host.appendChild(el); s.el = el;   // el is in the visible screen
    const term = new window.Terminal({ fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace", fontSize, lineHeight: 1.15, theme: { ...THEME, cursor: RT_META[rtOf(s)].cursor }, cursorBlink: true, scrollback: 8000, allowProposedApi: true, linkHandler: { activate(_e, uri) { openUrl(uri); }, allowNonHttpProtocols: false } });
    const fitAddon = new window.FitAddon.FitAddon(); term.loadAddon(fitAddon);
    term.open(el);
    wireLinks(term);   // plain http(s) URLs → clickable (open in a new tab)
    term.onData((d) => sendData(s, d));   // buffer-aware: keys typed before the socket opens are queued, not dropped
    // Mouse is the browser's (tmux mouse is off) so drag-selection is native + persists. We
    // own the wheel: scroll tmux's history via the server instead of letting xterm send arrows.
    term.attachCustomWheelEventHandler((e) => { onWheel(e); return false; });
    // Right-click pastes (like Windows Terminal) instead of popping the browser's native
    // menu — kills the confusing overlap of menus inside the terminal. Select + Ctrl+C still copies.
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY); });
    s.term = term; s.fit = fitAddon; s.opened = true;
    connect(s);
  }
  function setActive(id) {
    active = id;
    try { localStorage.setItem('cd-active', id); } catch (_) {}              // restore THIS tab (not tab #1) after a refresh
    const s = S.get(id);
    applyRt(s);
    setTok(null); renderRail(null);
    window.CommandDeckAttach && window.CommandDeckAttach.sync();
    if (s) { ensureOpen(s); s.attn = false; s.seenTurnId = s.lastTurnId; saveSeen(s.id, s.lastTurnId); }   // viewing a tab clears + acknowledges its "done" flag
    for (const o of S.values()) if (o.el) o.el.style.display = (o.id === id) ? 'block' : 'none';
    els.empty.style.display = s ? 'none' : 'flex';
    if (s) requestAnimationFrame(() => { fit(s); s.term.focus(); });
    paint();
    requestAnimationFrame(() => scrollPillIntoView(id));   // switching must never leave the active pill off-screen
    pollTelemetry();
    refreshAccountUsage();
  }
  function connect(s) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/term/attach?id=${enc(s.id)}`);
    ws.binaryType = 'arraybuffer'; s.ws = ws; setStatus(s, 'connecting');
    ws.onopen = () => {
      setStatus(s, 'live'); fit(s);
      flushPending(s);                                                          // deliver keys typed while connecting
      if (s.id === active && s.term) { try { s.term.focus(); } catch (_) {} }   // assert focus once the pane can receive input
    };
    // The tab busy/done dots come from the TRANSCRIPT (see pollTelemetry), NOT these bytes: tmux's
    // screen-replay on every (re)attach is bytes-but-not-work, and no byte-timing heuristic can
    // tell replay/echo/pauses apart from a real turn. So onmessage only renders to the terminal.
    ws.onmessage = (ev) => { if (s.status !== 'live') setStatus(s, 'live'); if (s.term) s.term.write(new Uint8Array(ev.data)); };
    ws.onclose = () => { if (s.userClosed) return; setStatus(s, 'reconnecting'); setTimeout(() => { if (S.has(s.id) && !s.userClosed) connect(s); }, RECONNECT_MS); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  // Fit xterm to its container, mirror the size to tmux, and show it in the bar.
  function fit(s) {
    if (!s || !s.opened) return;
    try { s.fit.fit(); } catch (_) {}
    if (s.id === active && s.term) els.dims.textContent = s.term.cols + '×' + s.term.rows;
    if (s.ws && s.ws.readyState === 1 && s.term) s.ws.send(JSON.stringify({ t: 'r', c: s.term.cols, r: s.term.rows }));
  }
  function destroy(id) {
    const s = S.get(id); if (!s) return;
    s.userClosed = true; try { s.ws && s.ws.close(); } catch (_) {}
    try { s.term && s.term.dispose(); } catch (_) {} if (s.el) s.el.remove(); S.delete(id);
    window.CommandDeckAttach && window.CommandDeckAttach.dropSession(id);
    if (active === id) { active = null; const next = S.keys().next().value; if (next) setActive(next); else { applyRt(); setTok(null); renderRail(null); els.empty.style.display = 'flex'; els.dims.textContent = ''; } }
    paint();
  }

  // ── actions ──────────────────────────────────────────────────────────────────────
  // Runtime picker: every radio only selects. One consistently worded Start button launches the
  // selected runtime with the backend default, so pointer, touch, and keyboard behavior agree.
  function pickedRuntime() {
    const r = (els.rtRadios || []).find((x) => x.checked);
    return r ? r.value : 'claude';
  }
  function syncRuntimeUi() {
    const rt = pickedRuntime();
    const labels = { claude: 'Start Claude Code', codex: 'Start Codex', local: 'Start Local LLM', shell: 'Start Shell' };
    if (els.create) els.create.style.display = 'flex';
    if (els.createLabel) els.createLabel.textContent = labels[rt] || labels.claude;
  }
  function commitLaunch() {
    if (launchCommitted || creatingSession) return;
    launchCommitted = true;
    newSession();
  }
  async function newSession() {
    if (creatingSession) return;
    creatingSession = true;
    if (els.create) els.create.disabled = true;
    if (els.newBtn) els.newBtn.disabled = true;
    const cwd = els.proj && els.proj.value ? els.proj.value : '';
    const label = els.label && els.label.value.trim() ? els.label.value.trim() : '';
    closePop();
    const probe = active && S.get(active) && S.get(active).term ? S.get(active).term : null;
    try {
      const rt = pickedRuntime();
      const isLocal = rt === 'local', isCodex = rt === 'codex', isShell = rt === 'shell';
      const r = await api('POST', '/api/term/sessions', { label, cwd, cols: probe ? probe.cols : 120, rows: probe ? probe.rows : 34, local: isLocal, codex: isCodex, shell: isShell });
      if (!r.ok || !r.session || !r.session.id) { await cdModal({ title: 'Could not start session', message: r.error || 'unknown error', okText: 'OK', okOnly: true }); return; }
      if (els.label) els.label.value = '';
      // One-shot reset: a sticky runtime pick must not silently decide the NEXT tab's runtime.
      if (els.rtRadios) for (const x of els.rtRadios) x.checked = x.value === 'claude';
      syncRuntimeUi();
      register(r.session); setActive(r.session.id);
    } finally {
      creatingSession = false;
      if (els.create) els.create.disabled = false;
      if (els.newBtn) els.newBtn.disabled = false;
    }
  }
  async function killSession(id) {
    const s = S.get(id); if (!s) return;
    if (!(await cdModal({ title: 'End session', message: 'End session "' + s.name + '"? Anything running in it will be terminated.', okText: 'End session', danger: true }))) return;
    const r = await api('POST', '/api/term/kill', { id });
    if (!r.ok) { await cdModal({ title: 'Could not end session', message: r.error || 'The server did not confirm the kill request.', okText: 'OK', okOnly: true }); return; }
    destroy(id);
  }
  async function renameSession(s) {
    const name = await cdModal({ title: 'Rename session', message: 'New name for this session:', input: s.name, okText: 'Rename' }); if (name == null) return;
    const r = await api('POST', '/api/term/rename', { id: s.id, label: name });
    if (r.ok) { s.name = name.trim().slice(0, 40) || s.name; paint(); }
    else await cdModal({ title: 'Could not rename session', message: r.error || 'The server rejected the rename.', okText: 'OK', okOnly: true });
  }
  async function loadProjects() {
    const r = await api('GET', '/api/term/projects'); if (!els.proj) return;
    const projects = Array.isArray(r.projects) && r.projects.length ? r.projects : [homeDir()];
    els.proj.innerHTML = projects.map((p) => `<option value="${esc(p)}">${esc(tilde(p))}</option>`).join('');
    els.proj.title = r.ok ? '' : (r.error || 'project list unavailable; using home directory');
  }

  // ── font zoom + activity dots ─────────────────────────────────────────────────────
  function applyFont() {
    for (const s of S.values()) if (s.term) { try { s.term.options.fontSize = fontSize; } catch (_) {} }
    refit();
    try { localStorage.setItem('cd-font', String(fontSize)); } catch (_) {}
  }

  // ── scrollbar + jump-to-latest (scrollback lives in tmux; we drive copy-mode via the server) ──
  function startScrollPoll() { if (scrollPoll) clearInterval(scrollPoll); scrollPoll = setInterval(updateScroll, 500); }
  // live context-token usage for the active session (read from its Claude transcript)
  function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0); }
  // Window size for captions: 1000000 → "1M", 200000 → "200k", 131072 → "131k".
  function fmtWin(w) { return w >= 1000000 ? (w / 1000000).toFixed(w % 1000000 ? 1 : 0) + 'M' : Math.round(w / 1000) + 'k'; }
  function fmtRss(b) { const g = (b || 0) / 1073741824; return g >= 1 ? g.toFixed(1) + 'G' : Math.max(1, Math.round((b || 0) / 1048576)) + 'M'; }
  function baseName(f) { const p = String(f || '').split('/'); return p[p.length - 1] || f; }
  function setTok(tel) {
    // model chip in the bar's instrument well (markup ships display:none until a model is known)
    const mc = document.getElementById('cd-model');
    if (mc) {
      const m = (tel && tel.modelShort) || '';
      if (mc.textContent !== m) mc.textContent = m;
      mc.style.display = m ? 'inline-block' : 'none';
    }
    const ctx = (tel && tel.tokens && tel.tokens.context) || 0;
    if (!ctx) { els.tok.textContent = ''; els.tok.title = ''; els.tok.style.color = ''; return; }
    // Truthful per-model window (tel.contextWindow, lib/ctxwindow.js). Unknown model → no %
    // rather than a made-up denominator (the old hardcode read everything against 500k).
    const win = (tel && tel.contextWindow) || null;
    if (win) {
      const pct = Math.min(100, Math.round(ctx / win * 100));
      els.tok.textContent = fmtTok(ctx) + ' tok · ' + pct + '%';
      els.tok.title = ctx.toLocaleString() + ' context tokens · ' + pct + '% of the ' + fmtWin(win) + ' window';
      els.tok.style.color = pct >= 85 ? 'var(--red2)' : pct >= 60 ? 'var(--amber2)' : 'var(--mut)';
    } else {
      els.tok.textContent = fmtTok(ctx) + ' tok';
      els.tok.title = ctx.toLocaleString() + ' context tokens · window unknown for this model, so no % is shown';
      els.tok.style.color = 'var(--mut)';
    }
  }
  // Telemetry rail — surfaces the Claude Code state lib/telemetry.js already computes but the
  // UI used to discard: model, permission mode, context budget, todos, skills, tools, codex
  // sub-agents, recently-edited files. Memoized so an unchanged poll doesn't churn the DOM.
  function setRailHTML(html) { if (!els.railBody) return; if (els.railBody._h === html) return; els.railBody._h = html; els.railBody.innerHTML = html; }
  function railSeg(label, inner) { return inner ? '<div class="seg"><div class="seglbl">' + esc(label) + '</div>' + inner + '</div>' : ''; }
  function fmtAgo(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  // The 1s "ago" ticker rewrites ONLY the [data-ago-ts] spans — the rail body memo stays
  // valid, so an unchanged poll still never churns the DOM.
  function tickAgos() {
    if (!els || !els.railBody || !els.view || !els.view.classList.contains('active')) return;
    for (const el of els.railBody.querySelectorAll('[data-ago-ts]')) {
      const ts = Number(el.dataset.agoTs || 0);
      if (ts) el.textContent = fmtAgo(Date.now() - ts);
    }
  }
  function agoSpan(iso) {
    const ts = Date.parse(iso || '');
    return isFinite(ts) ? '<i data-ago-ts="' + ts + '">' + fmtAgo(Date.now() - ts) + '</i>' : '—';
  }
  // Blocked-on-you card: surface the actual pending ask (question + option labels / plan
  // headline) so the operator sees WHAT is being asked without scanning the terminal.
  function askCard(tel) {
    const pa = tel.pendingAsk || {};
    if (tel.needsInputKind === 'plan') {
      const head = String(pa.plan || '').split('\n').find(Boolean) || 'implementation plan ready';
      return '<div class="cd-ask"><div class="cd-ask-kind">◆ plan approval</div><div class="cd-ask-q">' + esc(head.slice(0, 180)) + '</div><div class="cd-ask-hint">approve in the terminal ↓</div></div>';
    }
    const qs = Array.isArray(pa.questions) ? pa.questions : [];
    if (!qs.length) return '<div class="cd-ask"><div class="cd-ask-kind">◆ waiting on you</div><div class="cd-ask-hint">answer in the terminal ↓</div></div>';
    const q = qs[0] || {};
    const opts = (q.options || []).slice(0, 4).map((o) => '<span class="cd-chip">' + esc((o && o.label) || '') + '</span>').join('');
    const more = qs.length > 1 ? '<div class="cd-ask-hint">+' + (qs.length - 1) + ' more question' + (qs.length > 2 ? 's' : '') + '</div>' : '';
    return '<div class="cd-ask"><div class="cd-ask-kind">◆ ' + esc(q.header || 'question') + '</div><div class="cd-ask-q">' + esc(String(q.question || '').slice(0, 220)) + '</div>' + (opts ? '<div class="cd-chips">' + opts + '</div>' : '') + more + '</div>';
  }
  function rateWindowLabel(minutes) {
    if (!Number.isFinite(minutes)) return '';
    if (minutes === 300) return '5h';
    if (minutes === 10080) return 'weekly';
    if (minutes < 60 || minutes % 60) return String(minutes) + 'm';
    const hours = minutes / 60;
    return hours < 24 ? hours + 'h' : Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
  }
  function rateReset(resetsAt) {
    if (!Number.isFinite(resetsAt)) return '';
    const left = Math.max(0, resetsAt * 1000 - Date.now());
    if (!left) return 'resets now';
    const minutes = Math.floor(left / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return days ? days + 'd ' + (hours % 24) + 'h' : hours ? hours + 'h ' + (minutes % 60) + 'm' : minutes + 'm';
  }
  function usageResetText(ms) {
    if (!Number.isFinite(ms)) return '';
    const left = ms - Date.now();
    if (left <= 0) return 'last observed · reset passed';
    const minutes = Math.floor(left / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return 'resets ' + (days ? days + 'd ' + (hours % 24) + 'h' : hours ? hours + 'h ' + (minutes % 60) + 'm' : minutes + 'm');
  }
  function usageWindow(w) {
    if (!w) return '';
    const label = esc(w.label || w.key || 'window');
    if (!Number.isFinite(w.usedPercent)) return '<span>' + label + ' not reported</span>';
    const fill = Math.max(0, Math.min(100, w.usedPercent));
    const pct = fill > 0 && fill < 1 ? '<1' : String(Math.round(fill));
    const remaining = Math.max(0, Math.floor(100 - fill));
    const color = w.usedPercent >= 85 ? 'var(--red)' : w.usedPercent >= 60 ? 'var(--amber)' : 'var(--green)';
    const state = w.state === 'reset-passed' ? ' <i class="bad">last observed · reset passed</i>'
      : (w.state === 'stale' ? ' <i class="age">stale</i>' : '');
    const reset = w.state !== 'reset-passed' && Number.isFinite(w.resetsAt)
      ? ' <i class="age' + (w.resetsAt <= Date.now() ? ' bad' : '') + '" data-usage-reset="' + w.resetsAt + '">' + esc(usageResetText(w.resetsAt)) + '</i>' : '';
    return '<span title="Provider-reported quota, not a token count">' + label + ' <span class="cd-um"><i style="width:' + fill + '%;background:' + color + '"></i></span> ' + esc(pct) + '% used · ' + remaining + '% left' + state + reset + '</span>';
  }
  function usageProvider(kind, p) {
    const name = kind === 'claude' ? 'Claude Code' : 'Codex';
    if (!p || p.state === 'unavailable') return '<div class="cd-usagegrp ' + kind + '"><span class="prov">' + name + '</span><span class="bad">unavailable</span></div>';
    const parts = ['<span class="prov">' + name + '</span>'];
    if (p.plan) parts.push('<span>' + esc(p.plan) + '</span>');
    // Name the quota POOL the numbers were measured against. Codex serves this account from
    // more than one bucket (2026-08-06: 'codex' -> 'codex_bengalfox'/'GPT-5.3-Codex-Spark',
    // separate resets_at), and an unlabelled meter that swaps buckets reads as simply wrong:
    // an unused pool's 0% looked like "usage tracking is broken". A percentage is only
    // meaningful beside its bucket.
    if (p.poolLabel) parts.push('<span title="quota pool reported by the provider">pool: ' + esc(p.poolLabel) + '</span>');
    // A switch is a discontinuity, not a decrease — say so instead of implying the numbers
    // are comparable to what was on screen a moment ago.
    if (p.poolChanged) {
      parts.push('<span class="bad" title="the provider switched quota pool'
        + (p.previousLimitId ? ' (was ' + esc(p.previousLimitId) + ')' : '')
        + '; this % is not comparable to the previous one">pool changed</span>');
    }
    const windows = Array.isArray(p.windows) ? p.windows : [];
    for (const w of windows.filter((w) => Number.isFinite(w.usedPercent))) parts.push(usageWindow(w));
    const missing = windows.filter((w) => !Number.isFinite(w.usedPercent));
    if (missing.length) parts.push('<span class="age" title="The provider did not supply these limits; no value is inferred">'
      + (kind === 'codex' ? 'other limits not reported' : missing.map((w) => esc(w.label || w.key)).join(', ') + ' not reported') + '</span>');
    if (Number.isFinite(p.observedAt)) parts.push('<span class="age" data-usage-age="' + p.observedAt + '">' + fmtAgo(Date.now() - p.observedAt) + ' ago</span>');
    if (p.partial && !missing.length) parts.push('<span class="age">partial report</span>');
    if (p.fallback) parts.push('<span class="bad">fallback</span>');
    return '<div class="cd-usagegrp ' + kind + '">' + parts.join('<span>·</span>') + '</div>';
  }
  function usageEligible(s) { const rt = s && rtOf(s); return rt === 'claude' || rt === 'codex'; }
  function renderAccountUsage(data, updateFailed = false) {
    const s = active && S.get(active), shown = usageEligible(s);
    els.studio.classList.toggle('usagebar-on', shown);
    if (!els.usagebar) return;
    if (!shown) { els.usagebar.style.display = 'none'; els.usagebar.textContent = ''; els.usagebar._h = ''; return; }
    const html = usageProvider('claude', data && data.claude) + usageProvider('codex', data && data.codex)
      + (updateFailed ? '<span class="bad">update failed</span>' : '');
    if (els.usagebar._h !== html) { els.usagebar._h = html; els.usagebar.innerHTML = html; }
    els.usagebar.style.display = 'flex';
    tickUsageTimes();
  }
  function tickUsageTimes() {
    if (!els.usagebar || els.usagebar.style.display === 'none') return;
    for (const el of els.usagebar.querySelectorAll('[data-usage-age]')) {
      const at = Number(el.dataset.usageAge); if (at) el.textContent = fmtAgo(Date.now() - at) + ' ago';
    }
    for (const el of els.usagebar.querySelectorAll('[data-usage-reset]')) {
      const at = Number(el.dataset.usageReset); if (!at) continue;
      el.textContent = usageResetText(at); el.classList.toggle('bad', at <= Date.now());
    }
  }
  async function refreshAccountUsage() {
    const before = active && S.get(active);
    if (!els.view.classList.contains('active') || !usageEligible(before)) return renderAccountUsage(lastAccountUsage, usageUpdateFailed);
    if (usageInFlight) return;
    usageInFlight = true;
    try {
      const r = await api('GET', '/api/term/account-usage');
      if (Number.isFinite(r.generatedAt) && r.claude && r.codex) { lastAccountUsage = r; usageUpdateFailed = false; }
      else usageUpdateFailed = true;
    } finally {
      usageInFlight = false;
      // Re-check AFTER the response: a Claude-started request may land on Local/Shell.
      renderAccountUsage(lastAccountUsage, usageUpdateFailed);
    }
  }
  function fieldState(tel, key) {
    return tel && tel.telemetryMeta && tel.telemetryMeta.fields && tel.telemetryMeta.fields[key]
      || { source: 'unavailable', completeness: 'unavailable' };
  }
  function fieldSuffix(tel, key) {
    const m = fieldState(tel, key), labels = [];
    if (m.completeness === 'partial') labels.push('partial');
    if (m.source === 'derived') labels.push('derived');
    return labels.length ? ' · ' + labels.join(' · ') : '';
  }
  const unavailableParity = (label) => railSeg(label, '<div class="none">not emitted by this Codex session</div>');
  const partialParity = (label) => railSeg(label + ' · partial', '<div class="none">none observed in available coverage</div>');
  function permissionValue(value, meanings, badge = false) {
    if (typeof value !== 'string' || !value.trim()) return '<span class="none">not reported</span>';
    const bounded = value.length > 80 ? value.slice(0, 79) + '…' : value;
    if (!Object.prototype.hasOwnProperty.call(meanings, value)) return 'unrecognized: ' + esc(bounded);
    const raw = badge ? '<span class="cd-mode ' + value + '">' + esc(value) + '</span>' : esc(value);
    return esc(meanings[value]) + '<small>' + raw + '</small>';
  }
  function permissionRows(tel) {
    const row = (label, value) => '<div class="cd-kv cd-permission"><span>' + label + '</span><b>' + value + '</b></div>';
    let rows;
    if (tel.runtime === 'codex') {
      const approval = permissionValue(tel.approvalPolicy, {
        never: 'Disabled', 'on-request': 'May ask', 'on-failure': 'Ask after failure', untrusted: 'Ask unless trusted',
      });
      const sandbox = tel.sandbox && typeof tel.sandbox === 'object' && !Array.isArray(tel.sandbox) ? tel.sandbox.type : null;
      const access = permissionValue(sandbox, {
        'read-only': 'Read-only', 'workspace-write': 'Workspace writes',
        'danger-full-access': 'Unrestricted filesystem', 'external-sandbox': 'External sandbox',
      });
      rows = row('approval prompts', approval + '<span class="cd-sandbox"><span>sandbox</span>' + access + '</span>');
    } else {
      rows = row('permission mode', permissionValue(tel.automode, {
        default: 'Default checks', plan: 'Plan mode', acceptEdits: 'Auto-accept edits',
        bypassPermissions: 'Permission checks bypassed', auto: 'Automatic checks',
      }, true));
    }
    return rows + '<div class="none cd-permission-note">Last observed in available session telemetry. Approval prompts and access restrictions are separate.</div>';
  }
  function renderRail(tel) {
    if (!els.railBody) return;
    if (!tel) { setRailHTML('<div class="cd-railempty">no telemetry yet</div>'); return; }
    const t = tel.tokens || {};
    const model = tel.modelShort || tel.model || '—';
    const isCodex = tel.runtime === 'codex';
    const modeRow = permissionRows(tel);
    const rate = tel.codexRate, rateWindows = rate && Array.isArray(rate.windows) ? rate.windows.filter((w) => w && Number.isFinite(w.usedPercent)) : [];
    const rateRow = (isCodex && rateWindows.length)
      ? '<div class="cd-kv"><span>rate limit</span><b>' + rateWindows.map((w) => {
        const label = rateWindowLabel(w.windowMinutes);
        return (label ? esc(label) + ' ' : '') + Math.round(w.usedPercent) + '%';
      }).join(' · ') + (rate.plan ? ' · ' + esc(String(rate.plan)) : '') + (rate.reached != null ? ' · limit hit' : '') + '</b></div>'
      : '';
    const spendRow = (isCodex && t.totalSpent > 0)
      ? '<div class="cd-kv"><span>session spend</span><b>' + fmtTok(t.totalSpent) + ' tok</b></div>'
      : '';
    const parts = [];
    if (tel.needsInput) parts.push(askCard(tel));
    // Live state row: WHAT it's doing and for how long — a stale "doing" age is the
    // hung-agent tell that a bare "working…" could never show.
    const auxUnknown = isCodex && (tel.needsInput == null || tel.waitingOnBackground == null);
    const state = tel.needsInput === true ? ['blocked on you', 'var(--cyan2)']
      : tel.working === true ? ['working…', 'var(--amber2)']
      : tel.waitingOnBackground === true ? ['waiting on bg', 'var(--violet2)']
      : tel.working === false && auxUnknown ? ['main idle · aux unknown', 'var(--mut)']
      : tel.working === false ? ['idle', 'var(--green2)']
      : ['state unavailable', 'var(--mut)'];
    const doing = tel.working && tel.lastTool
      ? '<div class="cd-kv"><span>doing</span><b>' + esc(tel.lastTool) + ' · ' + agoSpan(tel.lastToolAt || tel.lastActivity) + '</b></div>'
      : (!tel.working && tel.lastActivity ? '<div class="cd-kv"><span>last activity</span><b>' + agoSpan(tel.lastActivity) + ' ago</b></div>' : '');
    const bgMeta = fieldState(tel, 'pendingBg');
    const bg = tel.pendingBg > 0 ? '<div class="cd-kv"><span>background</span><b style="color:var(--violet2)">'
      + (bgMeta.completeness === 'partial' ? 'at least ' : '') + tel.pendingBg + ' task' + (tel.pendingBg > 1 ? 's' : '') + ' running</b></div>' : '';
    const coverageRow = isCodex && auxUnknown
      ? '<div class="cd-kv"><span>coverage</span><b style="color:var(--mut)">input/background unavailable</b></div>' : '';
    // Git status of the session's cwd (server-side SWR cache; null = non-git/error → no row).
    const g = tel.git || null;
    const gitBr = g ? (g.detached ? 'detached' : g.branch) : null;
    const gitRow = gitBr
      ? '<div class="cd-kv"><span>git</span><b' + (g.dirty ? ' style="color:var(--amber2)"' : '')
        + ' title="' + esc(gitBr + (g.ahead != null ? ' · ahead ' + g.ahead + ' · behind ' + g.behind : ' · no upstream')) + '">'
        + esc(gitBr.length > 24 ? gitBr.slice(0, 23) + '…' : gitBr)
        + (g.dirty ? ' · ' + g.dirty + ' dirty' : ' · clean')
        + (g.ahead ? ' ↑' + g.ahead : '') + (g.behind ? ' ↓' + g.behind : '') + '</b></div>'
      : '';
    // This session's own process subtree (pane pid + children) — CPU% of the box + resident RSS.
    // GPU is deliberately absent: not per-PID attributable here. null → row hides, nothing invented.
    const pr = tel.proc || null;
    const loadRow = pr
      ? '<div class="cd-kv"><span>load</span><b>' + (pr.cpu || 0) + '% cpu · ' + fmtRss(pr.mem) + ' · ' + pr.procs + ' proc' + (pr.procs === 1 ? '' : 's') + '</b></div>'
      : '';
    // Plain-terminal tab: no transcript → no agent rows. Inventing an "idle/working" state would
    // be a lie; runtime + git + load (the cpu% IS the activity signal) are the honest set.
    if (tel.runtime === 'shell' || tel.runtime === 'conflict') {
      setRailHTML('<div class="seg"><div class="cd-kv"><span>runtime</span><b>' + (tel.runtime === 'conflict' ? 'conflicting markers' : 'plain terminal') + '</b></div>' + gitRow + loadRow + '</div>');
      tickAgos();
      return;
    }
    parts.push('<div class="seg">'
      + '<div class="cd-kv"><span>model</span><b>' + esc(model) + (isCodex ? ' <span style="color:var(--mut);font-weight:400">· codex</span>' : '') + '</b></div>'
      + modeRow
      + '<div class="cd-kv"><span>state</span><b style="color:' + state[1] + '">' + state[0] + '</b></div>'
      + doing + bg + coverageRow + gitRow + loadRow + rateRow + spendRow
      + '</div>');
    // Truthful context meter: divide by the model's real window (tel.contextWindow); when the
    // model isn't in the verified map, show the raw numbers with NO meter and NO percentage.
    const ctx = t.context || 0, WIN = tel.contextWindow || null;
    const caps = '<div class="cd-meter-cap"><span>' + fmtTok(ctx) + ' ctx</span><span>' + fmtTok(t.input || 0) + ' in · ' + fmtTok((t.cacheRead || 0) + (t.cacheCreate || 0)) + ' cache</span></div>'
      + '<div class="cd-meter-cap"><span>out ' + fmtTok(t.output || 0) + '</span><span>' + (tel.turns || 0) + ' turn' + (tel.turns === 1 ? '' : 's') + ' in tail</span></div>';
    if (WIN) {
      const pct = Math.min(100, Math.round(ctx / WIN * 100));
      const inW = Math.max(0, Math.min(100, (t.input || 0) / WIN * 100));
      const caW = Math.max(0, Math.min(100 - inW, ((t.cacheRead || 0) + (t.cacheCreate || 0)) / WIN * 100));
      parts.push(railSeg('context · ' + pct + '% of ' + fmtWin(WIN),
        '<div class="cd-meter"><span class="mi" style="width:' + inW + '%"></span><span class="mc" style="width:' + caW + '%"></span></div>' + caps));
    } else {
      parts.push(railSeg('context · window unknown', caps));
    }
    // Harness task list (TaskCreate/TaskUpdate) preferred; legacy TodoWrite as fallback.
    const tasks = Array.isArray(tel.tasks) ? tel.tasks : [];
    const todos = Array.isArray(tel.todos) ? tel.todos : [];
    const todoRow = (st, label) => { const cls = String(st || '').replace(/[^a-z_]/g, ''); const bx = cls === 'completed' ? '☑' : cls === 'in_progress' ? '▸' : '☐';
      return '<div class="cd-todo ' + cls + '"><span class="bx">' + bx + '</span><span>' + esc(label) + '</span></div>'; };
    if (tasks.length) {
      const order = { in_progress: 0, pending: 1, completed: 2 };
      const sorted = tasks.slice().sort((a, b) => (order[a.status] != null ? order[a.status] : 1) - (order[b.status] != null ? order[b.status] : 1));
      const done = tasks.filter((x) => x.status === 'completed').length;
      const rows = sorted.slice(0, 12).map((td) => todoRow(td.status, td.subject || '')).join('')
        + (sorted.length > 12 ? '<div class="none">+' + (sorted.length - 12) + ' more</div>' : '');
      parts.push(railSeg((isCodex ? 'plan' : 'tasks') + ' · ' + done + '/' + tasks.length + ' done' + fieldSuffix(tel, 'tasks'), rows));
    } else if (isCodex && fieldState(tel, 'tasks').completeness === 'unavailable') {
      parts.push(unavailableParity('plan'));
    } else if (isCodex && fieldState(tel, 'tasks').completeness === 'partial') {
      parts.push(partialParity('plan'));
    } else if (tel.tasksPartial) {
      parts.push(railSeg('tasks', '<div class="none">task list predates the read window</div>'));
    } else if (todos.length) {
      parts.push(railSeg('todos (' + todos.length + ')', todos.map((td) => todoRow(td.status, td.content || td.activeForm || '')).join('')));
    }
    const skills = Array.isArray(tel.skills) ? tel.skills : [];
    if (skills.length) parts.push(railSeg('skills' + fieldSuffix(tel, 'skills'), skills.map((s) => '<div class="cd-skill"><span class="b"></span>' + esc(s) + '</div>').join('')));
    else if (isCodex && fieldState(tel, 'skills').completeness === 'unavailable') parts.push(unavailableParity('skills'));
    else if (isCodex && fieldState(tel, 'skills').completeness === 'partial') parts.push(partialParity('skills'));
    const tools = tel.tools || {}; const tk = Object.keys(tools).sort((a, b) => tools[b] - tools[a]).slice(0, 5);
    if (tk.length) parts.push(railSeg('tools · in tail', '<div class="cd-chips">' + tk.map((k) => '<span class="cd-chip">' + esc(k) + ' ' + tools[k] + '</span>').join('') + '</div>'));
    const cx = Array.isArray(tel.codex) ? tel.codex : [];
    if (cx.length) parts.push(railSeg(isCodex ? 'subagents' + fieldSuffix(tel, 'codex') : 'codex', cx.slice(-4).map((c) => '<div class="cd-codex"><div class="top">' + esc(c.agent || 'codex') + '<span class="mode">' + esc(c.mode || '') + '</span></div><div class="desc">' + esc(c.description || '') + '</div></div>').join('')));
    else if (isCodex && fieldState(tel, 'codex').completeness === 'unavailable') parts.push(unavailableParity('subagents'));
    else if (isCodex && fieldState(tel, 'codex').completeness === 'partial') parts.push(partialParity('subagents'));
    const plugins = Array.isArray(tel.plugins) ? tel.plugins : [];
    if (plugins.length) parts.push(railSeg('plugins' + fieldSuffix(tel, 'plugins'), '<div class="cd-chips">' + plugins.map((p) => {
      const name = typeof p === 'string' ? p : p && p.name, count = p && typeof p === 'object' ? p.count : null;
      return '<span class="cd-chip">' + esc(name || 'plugin') + (count > 1 ? ' ' + count : '') + '</span>';
    }).join('') + '</div>'));
    else if (isCodex && fieldState(tel, 'plugins').completeness === 'unavailable') parts.push(unavailableParity('plugins'));
    else if (isCodex && fieldState(tel, 'plugins').completeness === 'partial') parts.push(partialParity('plugins'));
    const mcp = Array.isArray(tel.mcp) ? tel.mcp : [];
    if (mcp.length) parts.push(railSeg('mcp' + fieldSuffix(tel, 'mcp'), '<div class="cd-chips">' + mcp.map((call) => '<span class="cd-chip">'
      + esc((call.server || 'mcp') + ' · ' + (call.tool || 'tool')) + (call.count > 1 ? ' ' + call.count : '') + '</span>').join('') + '</div>'));
    else if (isCodex && fieldState(tel, 'mcp').completeness === 'unavailable') parts.push(unavailableParity('mcp'));
    else if (isCodex && fieldState(tel, 'mcp').completeness === 'partial') parts.push(partialParity('mcp'));
    // Files digest: edited (✎) first, then read-only touches (👁) — so a research-heavy
    // session shows what it's working over. Basename shown; full path rides the title.
    const rf = Array.isArray(tel.recentFiles) ? tel.recentFiles : [];
    const rd = Array.isArray(tel.readFiles) ? tel.readFiles : [];
    const fileRow = (f, cls, glyph) => '<div class="cd-change" title="' + esc(tilde(f)) + '"><span class="st ' + cls + '">' + glyph + '</span><span class="fp">' + esc(baseName(f)) + '</span></div>';
    const fileRows = rf.slice(0, 3).map((f) => fileRow(f, 'M', '✎')).join('') + rd.slice(0, 3).map((f) => fileRow(f, 'R', '👁')).join('');
    if (fileRows) parts.push(railSeg('files · in tail' + fieldSuffix(tel, rf.length ? 'recentFiles' : 'readFiles'), fileRows));
    else if (isCodex) {
      if (fieldState(tel, 'recentFiles').completeness === 'unavailable') parts.push(unavailableParity('edited files'));
      else if (fieldState(tel, 'recentFiles').completeness === 'partial') parts.push(partialParity('edited files'));
      if (fieldState(tel, 'readFiles').completeness === 'unavailable') parts.push(unavailableParity('read files'));
      else if (fieldState(tel, 'readFiles').completeness === 'partial') parts.push(partialParity('read files'));
    }
    setRailHTML(parts.join('') || '<div class="cd-railempty">no activity yet</div>');
    tickAgos();   // fill the ago spans immediately — don't wait for the first 1s tick
  }
  // Box-vitals footer — fed every SSE frame by index.html's render(p) via
  // CommandDeckTerminal.vitals(p). The terminal tab hides the header stat chips, so this is
  // the operator's only view of the box while driving sessions. Own memo: the 2s vitals
  // churn must never invalidate the rail body's memo (separate containers).
  let vitalsMemo = '';
  const pctColor = (v) => (v >= 85 ? 'var(--red2)' : v >= 60 ? 'var(--amber2)' : 'var(--mut)');
  function renderVitals(p) {
    const el = els && els.vitals;
    if (!el || !p || typeof p !== 'object') return;
    if (!els.view || !els.view.classList.contains('active')) return;   // terminal tab only
    const cpu = p.cpu && p.cpu.overall != null ? Math.round(p.cpu.overall) : null;
    const mem = p.mem && p.mem.total ? Math.round(p.mem.used / p.mem.total * 100) : null;
    const gpu = p.gpu && p.gpu.util != null ? Math.round(p.gpu.util) : null;
    const stat = (lbl, v) => (v == null ? '' : '<span class="cd-vit"><span class="l">' + lbl + '</span><b style="color:' + pctColor(v) + '">' + v + '%</b></span>');
    const ms = (p.ollama && p.ollama.models) || [];
    const models = ms.slice(0, 2).map((m) => '<span class="cd-vit"><span class="l">' + esc(String(m.name || '').split(':')[0].slice(0, 10)) + '</span><b>' + (m.bytes != null ? Math.round(m.bytes / 1073741824) + 'G' : '·') + '</b></span>').join('')
      + (ms.length > 2 ? '<span class="cd-vit"><b>+' + (ms.length - 2) + '</b></span>' : '');
    const html = (stat('cpu', cpu) + stat('mem', mem) + stat('gpu', gpu) + models) || '<span class="none">no feed yet</span>';
    if (html === vitalsMemo) return;
    vitalsMemo = html; el.innerHTML = html;
  }
  setInterval(tickAgos, 1000);   // cheap — touches ≤2 spans, and only while the tab is visible
  setInterval(tickUsageTimes, 1000); // captions only; quota I/O stays on the 30s account poll
  // ── rail notepad (Telemetry ⇄ Notes) ───────────────────────────────────────────
  // One shared scratchpad stored ON THE BOX (/api/term/notes → ~/.claude/command-deck/
  // notes.md), so the same notes are available across viewing devices and survive reboots. Autosaves
  // ~900ms after typing stops; refetches on switch/focus so another device's edits land —
  // and never clobbers local keystrokes that haven't been saved yet (notesDirty guard).
  let notesDirty = false, notesTimer = null;
  function notesStamp(msg) { if (els.notesState) els.notesState.textContent = msg || ''; }
  function setRailMode(mode) {
    const notes = mode === 'notes';
    els.railTel.classList.toggle('active', !notes);
    els.railNotes.classList.toggle('active', notes);
    els.railBody.style.display = notes ? 'none' : '';
    els.notes.style.display = notes ? 'block' : 'none';
    try { localStorage.setItem('cd-rail-mode', mode); } catch (_) {}
    if (notes) { fetchNotes(); setTimeout(() => { try { els.notes.focus(); } catch (_) {} }, 30); }
    else notesStamp('');
  }
  async function fetchNotes() {
    const r = await api('GET', '/api/term/notes');
    if (!r.ok || notesDirty) return;                       // never clobber unsaved local edits
    if (els.notes.value !== (r.text || '')) els.notes.value = r.text || '';
    notesStamp(r.savedAt ? 'synced ' + new Date(r.savedAt).toLocaleTimeString() : 'empty pad');
  }
  async function saveNotes() {
    const text = els.notes.value;
    const r = await api('POST', '/api/term/notes', { text });
    if (r.ok) { notesDirty = false; notesStamp('saved ' + new Date().toLocaleTimeString()); }
    else { notesStamp('save failed — retrying…'); clearTimeout(notesTimer); notesTimer = setTimeout(saveNotes, 5000); }
  }
  function wireNotes() {
    if (!els.notes || !els.railTel || !els.railNotes) return;
    els.railTel.onclick = () => setRailMode('tel');
    els.railNotes.onclick = () => setRailMode('notes');
    els.notes.addEventListener('input', () => {
      notesDirty = true; notesStamp('typing…');
      clearTimeout(notesTimer); notesTimer = setTimeout(saveNotes, 900);
    });
    // returning to the page picks up edits made on another device (when not mid-edit here)
    document.addEventListener('visibilitychange', () => { if (!document.hidden && els.notes.style.display !== 'none') fetchNotes(); });
    // best-effort flush if the tab closes inside the debounce window (Origin rides on beacons,
    // so the originguard's same-origin POST requirement is satisfied)
    addEventListener('pagehide', () => {
      if (!notesDirty) return;
      try { navigator.sendBeacon('/api/term/notes', new Blob([JSON.stringify({ text: els.notes.value })], { type: 'application/json' })); } catch (_) {}
    });
    let mode = 'tel'; try { mode = localStorage.getItem('cd-rail-mode') || 'tel'; } catch (_) {}
    if (mode === 'notes') setRailMode('notes');
  }

  function startTelPoll() { if (telPoll) clearInterval(telPoll); telPoll = setInterval(pollTelemetry, TEL_MS); pollTelemetry(); }
  function startUsagePoll() { if (usagePoll) clearInterval(usagePoll); usagePoll = setInterval(refreshAccountUsage, USAGE_MS); refreshAccountUsage(); }
  // Persist which turn the user has "seen" per session so the done-glow (attn) SURVIVES a refresh.
  // Without this, every reload re-baselines `seenTurnId` to the current turn, silently clearing the
  // "completed — check me" signal on background tabs (the lights looked wrong right after refreshing).
  function loadSeen() { try { return JSON.parse(localStorage.getItem('cd-seen') || '{}') || {}; } catch (_) { return {}; } }
  function saveSeen(id, turnId) {
    if (!id || !turnId) return;
    try { const m = loadSeen(); if (m[id] === turnId) return; m[id] = turnId; localStorage.setItem('cd-seen', JSON.stringify(m)); } catch (_) {}
  }
  // The per-session light machine — ONE reconciler for SSE frames and poll responses,
  // so the done-glow/seen logic can't drift by transport. Returns whether a repaint
  // is needed. (Spec §5.)
  const lightKnown = (value) => value === true || value === false;
  function applyLights(x, tel) {
    let changed = false;
    const tid = typeof tel.lastTurnId === 'string' && tel.lastTurnId ? tel.lastTurnId : null;
    if (!x.seenInit) { x.seenTurnId = tid; x.seenInit = true; }
    else if (tid && tid !== x.seenTurnId && x.id !== active && !x.attn) { x.attn = true; changed = true; }
    if (tid) {
      x.lastTurnId = tid;
      if (x.id === active) { x.seenTurnId = tid; saveSeen(x.id, tid); }
    }
    if (lightKnown(tel.working)) {
      if (!x.lifecycleKnown) changed = true;
      x.lifecycleKnown = true;
      if (tel.working !== x.working) { x.working = tel.working; changed = true; }
    }
    if (lightKnown(tel.needsInput)) {
      const ni = tel.needsInput, nk = tel.needsInputKind || null;
      if (ni !== x.needsInput || nk !== x.needsInputKind) { x.needsInput = ni; x.needsInputKind = nk; changed = true; }
    }
    if (lightKnown(tel.waitingOnBackground) && tel.waitingOnBackground !== x.waiting) { x.waiting = tel.waitingOnBackground; changed = true; }
    const unknown = !lightKnown(tel.working) || !lightKnown(tel.needsInput) || !lightKnown(tel.waitingOnBackground);
    if (x.telemetryUnknown !== unknown) { x.telemetryUnknown = unknown; changed = true; }
    setMeta(x, tel);
    return changed;
  }
  // Switcher-only metadata: recorded, but deliberately NOT counted as a repaint trigger. The pills
  // never show it, and an open dialog rebuilt every 2s would fight the keystroke the user is
  // typing into it — the switcher reads this state fresh each time it opens.
  function setMeta(x, tel) {
    x.stateSince = typeof tel.stateSince === 'string' ? tel.stateSince : null;
    x.lastActivity = typeof tel.lastActivity === 'string' ? tel.lastActivity : null;
    x.contextTokens = Number.isFinite(tel.contextTokens) ? tel.contextTokens : null;
    x.contextWindow = Number.isFinite(tel.contextWindow) ? tel.contextWindow : null;
    x.modelShort = typeof tel.modelShort === 'string' && tel.modelShort ? tel.modelShort : null;
  }

  // SSE lights: tuple → reconcile; {err:true} → keep last state, keep polling this id;
  // absent → authoritative dark (shell/conflict/killed). Attn is NOT touched by
  // absence — a done-glow the user hasn't acknowledged survives until the tab does.
  function applyLightsMap(map) {
    if (!map || typeof map !== 'object' || !booted) return;
    let changed = false;
    for (const x of S.values()) {
      const tel = map[x.id];
      if (tel && tel.err) { x.lightsErr = true; continue; }
      if (tel) { x.lightsErr = false; if (applyLights(x, tel)) changed = true; continue; }
      x.lightsErr = false;
      setMeta(x, {});   // authoritatively dark: stale metadata must not outlive the telemetry
      if (x.working || x.lifecycleKnown || x.needsInput || x.waiting || x.telemetryUnknown) { x.working = false; x.lifecycleKnown = false; x.needsInput = false; x.needsInputKind = null; x.waiting = false; x.telemetryUnknown = false; changed = true; }
    }
    if (changed && els.view && els.view.classList.contains('active')) paint();
  }

  // Frame entry point (index.html es.onmessage). Only CARRIED fields reach here (the
  // hasOwn gate lives at the call site), so arriving at all refreshes freshness; the
  // retained map replays over tabs that register later (renderSessions).
  function lights(map) {
    if (!map || typeof map !== 'object') return;
    lastLightsAt = Date.now(); lastLightsMap = map;
    applyLightsMap(map);
  }

  async function pollTelemetry() {
    if (!els.view.classList.contains('active')) return;          // only while the terminal tab is visible
    if (telInFlight) { telQueued = true; return; }                // one immediate retry after the prior fan-out finishes
    telInFlight = true;
    try {
      // Every 4th tick (~12s) re-sync the session list so tabs created or killed from
      // ANOTHER device (phone, tmux CLI) appear/vanish without a reload. Never mid-drag —
      // the repaint would rip the dragged tab out of the DOM.
      if (telTick++ % 4 === 0 && !dragged) {
        const list = await api('GET', '/api/term/sessions');
        if (list.ok && Array.isArray(list.sessions)) renderSessions(list.sessions);
      }
      // SSE fresh → poll only the active tab (deep rail read) + any err-flagged ids
      // (their frames carry no tuple; the route is their only truth — spec §5 R2-F9).
      // SSE stale → today's all-tabs fallback fan-out.
      const all = sseLightsFresh()
        ? [...S.values()].filter((x) => x.id === active || x.lightsErr)
        : [...S.values()];
      if (!all.length) return;
      // active tab gets the deep window (full task history); background tabs stay cheap
      const got = await Promise.all(all.map(async (x) => [x, await api('GET', '/api/term/telemetry?id=' + enc(x.id) + (x.id === active ? '&full=1' : ''))]));
      let changed = false;
      for (const [x, r] of got) {
        if (!S.has(x.id)) continue;                                        // killed while the fan-out was in flight
        const tel = r && r.ok && r.telemetry; if (!tel) continue;
        // One lights source per mode: while SSE is fresh, a poll response may only
        // reconcile lights for a session still err-flagged when it LANDS (the frame
        // wins if it cleared the flag mid-flight); when stale, this is the fallback
        // and responses reconcile — unless a frame arrived mid-fan-out (re-check).
        const mayLights = sseLightsFresh() ? x.lightsErr : true;
        if (mayLights) { x.lightsErr = false; if (applyLights(x, tel)) changed = true; }
        if (x.id === active) { setTok(tel); try { renderRail(tel); } catch (_) {} }
      }
      if (changed) paint();
    } finally {
      telInFlight = false;
      if (telQueued) { telQueued = false; pollTelemetry(); }
    }
  }
  function hideScroll() { els.scroll.classList.remove('show'); els.jump.classList.remove('show'); }
  async function updateScroll() {
    if (scrollDrag) return;                                   // don't fight an active drag
    const s = active && S.get(active);
    if (!s || !s.opened || !els.view.classList.contains('active')) return hideScroll();
    if (scrollInFlight) return;                               // a prior scrollstate poll is still outstanding — don't stack
    scrollInFlight = true;
    try {
      const r = await api('GET', '/api/term/scrollstate?id=' + enc(active));
      if (r.ok) renderScroll(r); else hideScroll();
    } finally { scrollInFlight = false; }
  }
  function renderScroll(st) {
    const hist = st.hist || 0, height = st.height || 1, pos = st.pos || 0;
    lastHist = hist; lastPos = pos;
    if (hist <= 0) return hideScroll();
    els.scroll.classList.add('show');
    const track = els.scroll.clientHeight || 1;
    const thumbH = Math.max(38, Math.round(track * (height / (hist + height))));
    const maxTop = Math.max(0, track - thumbH);
    const frac = Math.min(1, pos / hist);                     // 0 = bottom/latest, 1 = oldest
    els.thumb.style.height = thumbH + 'px';
    els.thumb.style.top = Math.round(maxTop * (1 - frac)) + 'px';
    els.jump.classList.toggle('show', !!st.inMode && pos > 0);
  }
  function gotoFromThumb(clientY) {
    const rect = els.scroll.getBoundingClientRect(), thumbH = els.thumb.offsetHeight;
    let top = Math.max(0, Math.min(rect.height - thumbH, clientY - rect.top - thumbH / 2));
    els.thumb.style.top = top + 'px';
    const maxTop = Math.max(1, rect.height - thumbH);
    const target = Math.round((1 - top / maxTop) * lastHist);  // top of track = oldest
    const now = Date.now();
    if (now - lastGoto > 70) { lastGoto = now; api('POST', '/api/term/scroll', { id: active, op: 'goto', n: target }); }
  }

  // ── right-click menu (one clean menu: Copy / Paste / Select all) ──────────────────
  function hideCtxMenu() { if (els.ctx) els.ctx.hidden = true; }
  function showCtxMenu(x, y) {
    const s = active && S.get(active); if (!s || !s.term) return;
    els.ctx.querySelector('[data-act="copy"]').classList.toggle('disabled', !s.term.getSelection());
    els.ctx.hidden = false;
    const mw = els.ctx.offsetWidth, mh = els.ctx.offsetHeight;
    els.ctx.style.left = Math.min(x, window.innerWidth - mw - 6) + 'px';
    els.ctx.style.top = Math.min(y, window.innerHeight - mh - 6) + 'px';
  }
  function ctxAction(act) {
    const s = active && S.get(active); if (!s || !s.term) return;
    if (act === 'copy') { const sel = s.term.getSelection(); if (sel && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {}); }
    else if (act === 'paste') { if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then((t) => { if (t) s.term.paste(t); }).catch(() => {}); }
    else if (act === 'selall') s.term.selectAll();
  }

  // wheel → scroll tmux history. up = into history; reaching the bottom returns to live.
  // A wheel delta maps to history ROWS by the real row height (no fixed multiplier), after
  // normalizing the three deltaModes so a notch scrolls the same amount on every device — motion
  // tracks the wheel proportionally instead of lurching ~9 lines per tick.
  function wheelRows(e) {
    let px = e.deltaY;
    if (e.deltaMode === 1) px *= 16;                                  // DOM_DELTA_LINE → ~1 row of px
    else if (e.deltaMode === 2) px *= (els.host.clientHeight || 320); // DOM_DELTA_PAGE → ~a screen
    const rowPx = Math.max(8, fontSize * 1.15);                       // one text row in px
    // ~3 lines per standard notch: finer steps read smoother than big lurches, and a fast spin still
    // catches up because deltas accumulate while a scroll request is in flight.
    return (px < 0 ? 1 : -1) * Math.max(1, Math.round(Math.abs(px) / (rowPx * 2)));
  }
  function onWheel(e) {
    if (!active) return;
    try { e.preventDefault(); } catch (_) {}
    pendingWheel += wheelRows(e);                        // wheel up (deltaY<0) → into history (+)
    scheduleScroll();
  }
  // Coalesce on the animation frame (~16ms, frame-aligned) instead of a 45ms timer, and keep a
  // SINGLE scroll request in flight: accumulate while one is outstanding and flush the net delta
  // when it returns. Repaints then arrive as one smooth, frame-paced stream rather than a backlog
  // of stacked, laggy chunks. Touch-drag + selection-autoscroll feed the same path.
  function scheduleScroll() {
    if (wheelRaf || scrollPostInFlight) return;
    wheelRaf = requestAnimationFrame(flushWheel);
  }
  function flushWheel() {
    wheelRaf = null;
    if (!active || scrollPostInFlight) return;
    const net = pendingWheel; pendingWheel = 0;
    if (!net) return;
    const op = net > 0 ? 'up' : (lastPos + net <= 0 ? 'bottom' : 'down');
    const n = Math.abs(net);
    lastPos = op === 'bottom' ? 0 : Math.max(0, lastPos + net);   // optimistic so op stays accurate mid-stream
    scrollPostInFlight = true;
    api('POST', '/api/term/scroll', { id: active, op, n })
      .then(() => { scrollPostInFlight = false; if (pendingWheel) scheduleScroll(); else updateScroll(); })
      .catch(() => { scrollPostInFlight = false; });
  }

  // Touch: a vertical drag on the terminal scrolls tmux history through the same
  // coalesced plumbing as the wheel (drag down = back in time, like native scroll).
  // preventDefault fires only once it's a real drag, so a plain tap still reaches
  // xterm and pops the soft keyboard. xterm's own touch viewport is a no-op here
  // (scrollback lives in tmux, not the xterm buffer), so we own the gesture.
  function wireTouchScroll() {
    const ROW = 18;                                   // px of finger travel per history row
    let sy = 0, acc = 0, drag = false, tid = null;
    els.host.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { tid = null; return; }
      tid = e.touches[0].identifier; sy = e.touches[0].clientY; acc = 0; drag = false;
    }, { passive: true });
    els.host.addEventListener('touchmove', (e) => {
      let t = null;
      for (const x of e.changedTouches) if (x.identifier === tid) t = x;
      if (!t || !active) return;
      const dy = t.clientY - sy;
      if (!drag && Math.abs(dy) < 12) return;         // not a drag yet — could still be a tap
      drag = true;
      e.preventDefault();                             // it's a scroll — keep selection/zoom out of it
      sy = t.clientY; acc += dy;
      const rows = Math.trunc(acc / ROW);
      if (rows) {
        acc -= rows * ROW;
        pendingWheel += rows;                         // drag down (+) = back into history
        scheduleScroll();
      }
    }, { passive: false });
  }

  // While drag-selecting text, autoscroll the tmux history when the pointer reaches the top/bottom
  // edge — like a native terminal — so a selection can run past the visible viewport (e.g. to copy a
  // long block). Scrollback lives in tmux, so we nudge copy-mode through the same plumbing as the
  // wheel; re-dispatching the pointer position each tick makes xterm extend its selection onto the
  // rows that scroll into view. Tracked on `document` so a drag PAST the bottom keeps scrolling.
  function wireSelectionAutoscroll() {
    const EDGE = 30;                                    // px from an edge that arms autoscroll
    let selecting = false, lastX = 0, lastY = 0, dir = 0, timer = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } dir = 0; selecting = false; };
    const tick = () => {
      if (!selecting || !active || !dir) return;
      pendingWheel += dir < 0 ? 2 : -2;                 // top edge → older (up/+); bottom edge → newer (down/−)
      scheduleScroll();
      const el = document.elementFromPoint(lastX, lastY);   // keep xterm's drag-extend alive after the repaint
      if (el) el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: lastX, clientY: lastY, buttons: 1 }));
    };
    // start only on a real text drag inside the terminal — not on the scrollbar (it owns its own drag)
    els.host.addEventListener('mousedown', (e) => { if (e.button === 0 && !(e.target.closest && e.target.closest('#cd-scroll'))) { selecting = true; lastX = e.clientX; lastY = e.clientY; } });
    document.addEventListener('mousemove', (e) => {
      if (!selecting) return;
      lastX = e.clientX; lastY = e.clientY;
      const r = els.host.getBoundingClientRect();
      const nd = (e.clientY > r.bottom - EDGE) ? 1 : (e.clientY < r.top + EDGE) ? -1 : 0;
      if (nd !== dir) { dir = nd; if (timer) { clearInterval(timer); timer = null; } if (dir) timer = setInterval(tick, 55); }
    });
    document.addEventListener('mouseup', stop);
  }

  // Middle-button autoscroll — HOLD the middle button and move up/down to scroll tmux history
  // continuously (speed ∝ distance from where you pressed); RELEASE to stop. Feeds the same coalesced
  // pendingWheel plumbing as the wheel/touch (so hitting the bottom snaps back to live). Esc / focus
  // loss are fail-safe stops. Mouse-only — touch devices have no button 1, so swipe-scroll is untouched.
  function wireMiddleClickAutoscroll() {
    const DEAD = 14, STEP = 8, MAX = 16, TICK = 50;     // px dead zone · px per extra row · rows/tick cap · ms
    let on = false, anchorY = 0, curY = 0, timer = null, marker = null;
    function getMarker() {
      if (!marker) { marker = elc('div', 'cd-autoscroll-anchor'); for (const g of ['▴', '▾']) { const i = document.createElement('i'); i.textContent = g; marker.appendChild(i); } document.body.appendChild(marker); }
      return marker;
    }
    function start(x, y) {
      on = true; anchorY = curY = y;
      const m = getMarker(); m.style.left = x + 'px'; m.style.top = y + 'px'; m.classList.add('show');
      document.body.classList.add('cd-autoscrolling');
      if (!timer) timer = setInterval(tick, TICK);
    }
    function stop() {
      if (!on) return;
      on = false;
      if (timer) { clearInterval(timer); timer = null; }
      if (marker) marker.classList.remove('show');
      document.body.classList.remove('cd-autoscrolling');
    }
    function tick() {
      if (!on || !active) return;
      const dy = curY - anchorY;
      if (Math.abs(dy) <= DEAD) return;                 // dead zone around the anchor → hold still
      const rows = Math.min(MAX, 1 + Math.floor((Math.abs(dy) - DEAD) / STEP));
      pendingWheel += dy < 0 ? rows : -rows;            // pointer above anchor → up/into history (+); below → down (−)
      scheduleScroll();
    }
    // Press the middle button to start; release to stop. Capture phase + preventDefault/stopPropagation
    // claims the middle button from the browser's own autoscroll/paste AND xterm underneath.
    els.host.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault(); e.stopPropagation();
      start(e.clientX, e.clientY);
    }, true);
    els.host.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); }, true);
    document.addEventListener('mousemove', (e) => { if (on) curY = e.clientY; });
    addEventListener('mouseup', (e) => { if (on && e.button === 1) stop(); }, true);   // release the button → stop
    addEventListener('blur', stop);                                                    // released off-window → fail safe
    document.addEventListener('keydown', (e) => { if (on && e.key === 'Escape') stop(); });
  }

  // ── Copy-text panel: the full scrollback as plain selectable text. Solves copying output
  // taller than the window — xterm only holds the visible screen, but tmux keeps the history, so
  // we dump it server-side (capture-pane) into a textarea where normal browser selection spans it all.
  async function openCopyPanel() {
    if (!active) return;
    els.copyArea.value = 'Loading scrollback…';
    els.copyPanel.hidden = false;
    if (els.copyHint) els.copyHint.textContent = 'drag to select any part — or —';
    let r; try { r = await api('GET', '/api/term/dump?id=' + enc(active)); } catch (_) { r = null; }
    if (!els.copyPanel || els.copyPanel.hidden) return;                  // closed while it was loading
    if (r && r.ok) {
      els.copyArea.value = r.text ? r.text : '(no output yet)';
      if (els.copyHint) els.copyHint.textContent = (r.lines || 0) + ' lines — drag to select, or —';
      try { els.copyArea.focus(); els.copyArea.setSelectionRange(0, 0); els.copyArea.scrollTop = els.copyArea.scrollHeight; } catch (_) {}
    } else {
      els.copyArea.value = 'Could not read the terminal: ' + ((r && r.error) || 'request failed');
    }
  }
  function closeCopyPanel() {
    if (els.copyPanel) els.copyPanel.hidden = true;
    const s = active && S.get(active); if (s && s.term) { try { s.term.focus(); } catch (_) {} }
  }
  async function copyAllText() {
    const text = els.copyArea.value || '';
    let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch (_) {}
    if (!ok) { try { els.copyArea.focus(); els.copyArea.select(); ok = document.execCommand('copy'); els.copyArea.setSelectionRange(0, 0); } catch (_) {} }
    if (ok && els.copyAll) {
      els.copyAll.classList.add('done'); els.copyAll.textContent = '✓ Copied';
      setTimeout(() => { if (els.copyAll) { els.copyAll.classList.remove('done'); els.copyAll.textContent = 'Copy all'; } }, 1400);
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────────────
  function closePop() { els.newPop.classList.remove('open'); }
  // Lane, Tools and switcher wiring — kept together so the whole overflow surface is one block.
  function wireLane() {
    const step = () => Math.max(120, Math.round(els.sessions.clientWidth * 0.8));
    if (els.lanePrev) els.lanePrev.onclick = () => { els.sessions.scrollLeft -= step(); setTimeout(measureLane, 160); };
    if (els.laneNext) els.laneNext.onclick = () => { els.sessions.scrollLeft += step(); setTimeout(measureLane, 160); };
    if (els.sessions) els.sessions.addEventListener('scroll', measureLane, { passive: true });
    addEventListener('resize', measureLane);
    // Slider under the names: drag the thumb, or click the track to jump there.
    if (els.laneTrack && els.laneThumb && els.sessions) {
      const strip = els.sessions;
      let drag = null;
      els.laneTrack.addEventListener('pointerdown', (e) => {
        const tw = els.laneTrack.clientWidth, thumbW = els.laneThumb.offsetWidth;
        const ratio = (strip.scrollWidth - strip.clientWidth) / Math.max(1, tw - thumbW);   // strip px per track px
        strip.style.scrollBehavior = 'auto';                                                 // smooth scrolling fights a drag
        if (e.target !== els.laneThumb) strip.scrollLeft = (e.clientX - els.laneTrack.getBoundingClientRect().left - thumbW / 2) * ratio;
        drag = { x: e.clientX, start: strip.scrollLeft, ratio };
        els.laneThumb.classList.add('grabbing');
        try { els.laneTrack.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      els.laneTrack.addEventListener('pointermove', (e) => { if (drag) strip.scrollLeft = drag.start + (e.clientX - drag.x) * drag.ratio; });
      const endDrag = () => { if (!drag) return; drag = null; els.laneThumb.classList.remove('grabbing'); strip.style.scrollBehavior = ''; measureLane(); };
      els.laneTrack.addEventListener('pointerup', endDrag);
      els.laneTrack.addEventListener('pointercancel', endDrag);
    }
    if (els.countBtn) els.countBtn.onclick = (e) => { e.stopPropagation(); swOpen ? closeSwitcher() : openSwitcher(); };
    if (els.swClose) els.swClose.onclick = () => closeSwitcher();
    if (els.swQ) { els.swQ.addEventListener('input', () => { swSel = 0; renderSwitcher(); }); }
    if (els.sw) els.sw.addEventListener('keydown', swKeydown);
    // Tools disclosure (only visible under 1200px, where the well is off the first row).
    if (els.toolsBtn) els.toolsBtn.onclick = (e) => {
      e.stopPropagation();
      const bar = els.toolsBtn.closest('.cd-bar');
      if (!bar) return;
      const open = bar.classList.toggle('tools-open');
      els.toolsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      measureLane();
    };
    document.addEventListener('click', (e) => {
      if (swOpen && els.sw && !els.sw.contains(e.target) && e.target !== els.countBtn) closeSwitcher();
      const bar = els.toolsBtn && els.toolsBtn.closest('.cd-bar');
      if (bar && bar.classList.contains('tools-open') && !bar.contains(e.target)) {
        bar.classList.remove('tools-open'); els.toolsBtn.setAttribute('aria-expanded', 'false');
      }
    });
    // Alt+K opens the switcher everywhere. Ctrl/Cmd+K also opens it, EXCEPT inside a plain shell
    // session where that chord is the shell's own clear-line and must reach the PTY untouched.
    addEventListener('keydown', (e) => {
      if (swOpen && e.key === 'Escape') { e.preventDefault(); closeSwitcher(); return; }
      const k = (e.key || '').toLowerCase();
      if (k !== 'k') return;
      const altK = e.altKey && !e.ctrlKey && !e.metaKey;
      const cmdK = (e.ctrlKey || e.metaKey) && !e.altKey;
      if (!altK && !cmdK) return;
      if (!els.view || els.view.hidden) return;                       // terminal tab only
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && t !== els.swQ) return;
      if (cmdK) { const s = active && S.get(active); if (s && rtOf(s) === 'shell') return; }   // PTY keeps the chord
      e.preventDefault();
      swOpen ? closeSwitcher() : openSwitcher();
    });
  }
  function wire() {
    wireLane();
    // Opening the popover focuses the label. Every runtime is selected by radio and launched
    // through the same Start button/Enter path. The latch is set before any I/O.
    els.newBtn.onclick = (e) => {
      e.stopPropagation();
      const open = els.newPop.classList.toggle('open');
      if (open) { launchCommitted = false; setTimeout(() => { try { els.label.focus(); els.label.select(); } catch (_) {} }, 30); }
    };
    els.create.onclick = () => commitLaunch();
    const popKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitLaunch(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePop(); }
    };
    els.label.addEventListener('keydown', popKey);
    els.proj.addEventListener('keydown', popKey);
    for (const x of els.rtRadios || []) {
      x.addEventListener('change', () => syncRuntimeUi());
      x.addEventListener('keydown', popKey);
    }
    syncRuntimeUi();
    // Dragging over empty bar space (right of the last tab) appends to the end — the
    // insertion bar shows on the last tab's right edge so the landing slot is never a mystery.
    els.sessions.addEventListener('dragover', (e) => {
      if (!dragged || e.target !== els.sessions) return;
      e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      markDrop(els.sessions.lastElementChild, false);
    });
    els.sessions.addEventListener('drop', (e) => {
      if (e.target !== els.sessions) return;
      e.preventDefault(); moveTab(dragged || (e.dataTransfer && e.dataTransfer.getData('text/plain')), null, false);
    });
    if (els.copyBtn) els.copyBtn.onclick = () => openCopyPanel();
    if (els.copyAll) els.copyAll.onclick = () => copyAllText();
    if (els.copyClose) els.copyClose.onclick = () => closeCopyPanel();
    els.zoomIn.onclick = () => { fontSize = Math.min(22, fontSize + 1); applyFont(); };
    els.zoomOut.onclick = () => { fontSize = Math.max(8, fontSize - 1); applyFont(); };
    if (els.railToggle) els.railToggle.onclick = () => {
      if (matchMedia('(max-width:900px)').matches) {
        els.railToggle.setAttribute('aria-expanded', String(els.studio.classList.toggle('rail-open')));
      } else {
        const off = els.studio.classList.toggle('rail-off');
        els.railToggle.setAttribute('aria-expanded', String(!off));
        try { localStorage.setItem('cd-rail-off', off ? '1' : '0'); } catch (_) {}
      }
      requestAnimationFrame(refit);
    };
    const railClose = document.getElementById('cd-rail-close');
    if (railClose) railClose.onclick = () => { els.studio.classList.remove('rail-open'); els.railToggle.setAttribute('aria-expanded', 'false'); };
    // jump to latest output (exits tmux copy-mode → live)
    els.jump.onclick = () => { if (active) api('POST', '/api/term/scroll', { id: active, op: 'bottom' }).then(updateScroll); };
    // jump BACK to the previous ❯ input; each click steps one input older ('Latest' returns to live)
    if (els.prevInput) els.prevInput.onclick = () => { if (active) api('POST', '/api/term/scroll', { id: active, op: 'previnput' }).then(updateScroll); };
    // drag the scrollbar thumb → scroll tmux history (throttled goto)
    els.thumb.addEventListener('pointerdown', (e) => {
      if (!active) return; e.preventDefault(); scrollDrag = true; els.thumb.classList.add('grabbing');
      try { els.thumb.setPointerCapture(e.pointerId); } catch (_) {}
      const mv = (ev) => gotoFromThumb(ev.clientY);
      const up = (ev) => { scrollDrag = false; els.thumb.classList.remove('grabbing'); gotoFromThumb(ev.clientY); els.thumb.removeEventListener('pointermove', mv); els.thumb.removeEventListener('pointerup', up); setTimeout(updateScroll, 150); };
      els.thumb.addEventListener('pointermove', mv); els.thumb.addEventListener('pointerup', up);
    });
    // right-click menu: act on mousedown (fires before the document click that dismisses it)
    els.ctx.querySelectorAll('.cd-ctx-item').forEach((it) => it.addEventListener('mousedown', (e) => { e.preventDefault(); ctxAction(it.dataset.act); hideCtxMenu(); }));
    // Dismiss on the FIRST click anywhere outside the menu. Capture-phase mousedown fires
    // before xterm's own mouse handling (which was swallowing the bubbled 'click').
    document.addEventListener('mousedown', (e) => { if (els.ctx && !els.ctx.hidden && !e.target.closest('#cd-ctx')) hideCtxMenu(); }, true);
    addEventListener('wheel', () => { if (els.ctx && !els.ctx.hidden) hideCtxMenu(); }, { passive: true });
    // Esc dismisses the menu even while xterm owns focus: capture phase runs before
    // xterm's textarea handler can swallow the key. Consumed ONLY when the menu is
    // open, so a bare Esc still reaches Claude (interrupt) untouched.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.ctx && !els.ctx.hidden) { e.preventDefault(); e.stopPropagation(); hideCtxMenu(); }
      else if (e.key === 'Escape' && els.copyPanel && !els.copyPanel.hidden) { e.preventDefault(); e.stopPropagation(); closeCopyPanel(); }
    }, true);
    document.addEventListener('click', (e) => { if (!e.target.closest('#cd-new-pop') && !e.target.closest('#cd-new')) closePop(); });
    // Touch key bar (phone): sends the TUI control keys a soft keyboard lacks through the
    // normal input path. pointerdown + preventDefault so xterm's hidden textarea KEEPS focus
    // and the soft keyboard stays open; ⇞/⇟ reuse the same tmux-history plumbing as the wheel.
    if (els.keybar) {
      const KEYS = { esc: '\x1b', tab: '\t', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', cc: '\x03' };
      els.keybar.querySelectorAll('button').forEach((b) => b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const s = active && S.get(active); if (!s) return;
        if (b.dataset.act === 'hup') { api('POST', '/api/term/scroll', { id: active, op: 'up', n: 15 }).then(updateScroll); return; }
        if (b.dataset.act === 'hdn') { api('POST', '/api/term/scroll', { id: active, op: (lastPos - 15 <= 0) ? 'bottom' : 'down', n: 15 }).then(updateScroll); return; }
        const k = KEYS[b.dataset.k];
        if (k) sendData(s, k);   // same buffer-aware path as typed keys (the esc button raced the socket too)
      }));
    }
    wireImageAttach();   // 📎 button + Ctrl+V paste of screenshots → upload → @-path into Claude
    wireNotes();         // rail Telemetry ⇄ Notes toggle + the autosaving shared scratchpad
    wireTouchScroll();   // phone: swipe the terminal to scroll tmux history
    wireSelectionAutoscroll();   // desktop: drag a selection to the top/bottom edge → autoscroll
    wireMiddleClickAutoscroll(); // desktop: middle-click then move up/down to autoscroll, like a browser
    // The ResizeObserver (in boot) is the primary fit driver; these are belt-and-suspenders.
    addEventListener('resize', refit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) requestAnimationFrame(refit); });
    addEventListener('focus', () => requestAnimationFrame(refit));
  }

  function injectText(text) {
    sendData(S.get(active), text);
  }
  function injectTextFor(id, text) {
    sendData(S.get(id), text);
  }
  function activeSessionId() { return active; }

  // ── image attach: 📎 file-picker + clipboard paste → /api/term/upload → @path ───────────────────
  // Capture an image (file / clipboard), upload it to <cwd>/.cc-uploads, then type the REAL
  // returned @path into the PTY so Claude Code reads the picture (never a fake [Image #N]).
  function wireImageAttach() {
    if (els.imgBtn && els.fileInput) {
      els.imgBtn.onclick = () => { if (!active) return flashImg('open a session first'); els.fileInput.click(); };
      els.fileInput.onchange = () => { attachFiles(els.fileInput.files); els.fileInput.value = ''; };
    }
    // Ctrl+V / right-click paste of a screenshot — capture phase so we see the image BEFORE xterm's
    // textarea. A plain-text paste has no image item, so we don't touch it (falls through to xterm).
    document.addEventListener('paste', (e) => {
      if (!els.view || !els.view.classList.contains('active')) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const imgs = [];
      for (const it of items) if (it.kind === 'file' && /^image\//.test(it.type)) { const f = it.getAsFile(); if (f) imgs.push(f); }
      if (imgs.length) { e.preventDefault(); e.stopPropagation(); attachFiles(imgs); }
    }, true);
  }
  function attachFiles(fileList) {
    if (!active) return flashImg('open a session first');
    const imgs = [].slice.call(fileList).filter((f) => /^image\//.test(f.type));
    if (!imgs.length) return;
    for (const f of imgs) { const fr = new FileReader(); fr.onload = () => uploadImage(f.name || 'image.png', fr.result); fr.readAsDataURL(f); }
  }
  async function uploadImage(name, dataUrl) {
    const id = active; if (!id) return;
    // Spaces/colons in screenshot names ("Screenshot 2026-06-29 22-27.png") break Claude's @-mention
    // parsing (it stops at the first space), so collapse to a single safe token before upload.
    const safe = String(name || 'image.png').replace(/[^\w.\-]+/g, '_');
    flashImg('uploading…');
    const r = await api('POST', '/api/term/upload', { id, name: safe, data: dataUrl });
    if (r && r.ok && r.rel) { injectTextFor(id, '@' + r.rel + ' '); flashImg('📎 ' + r.rel); }
    else flashImg('upload failed' + (r && r.error ? ': ' + r.error : ''));
  }
  function flashImg(msg) {
    const b = els.imgBtn; if (!b) return;
    b.textContent = msg; b.classList.add('cd-img-flash');
    clearTimeout(b._flashT); b._flashT = setTimeout(() => { b.textContent = '📎 Image'; b.classList.remove('cd-img-flash'); }, 2200);
  }

  window.CommandDeckTerminal = { activate, injectText, activeSessionId, lights, vitals: renderVitals, _findUrlLinks: findUrlLinks };
})();
