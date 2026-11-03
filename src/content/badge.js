// In-page download badge (1DM-style). Runs in every frame next to
// scanner.js. For each large enough <video> it keeps a small button in its
// own shadow root, fixed-positioned on top of everything at the video's
// top-left corner. The service worker decides what the video is (badge:resolve,
// same ranking as the popup) and starts the download (badge:download).
//
// Visibility: 'hover' (default) shows the badge while the pointer is over
// the video; 'always' keeps it visible; 'off' never creates one. Ads and
// disabled sites resolve to show:false.

(() => {
  if (window.__vdlBadgeLoaded) return;
  window.__vdlBadgeLoaded = true;

  const MIN_WIDTH = 200;
  const MIN_HEIGHT = 112;
  const RESOLVE_TTL_MS = 4000;
  const HIDE_DELAY_MS = 600;
  const POLL_MS = 700;

  let mode = 'hover';
  const entries = new Map(); // video -> entry
  let pointer = { x: -1, y: -1 };

  // ---- messaging -----------------------------------------------------------

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          if (chrome.runtime.lastError || !response)
            return resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'no response' });
          resolve(response);
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message ?? error) }); // extension reloaded: this instance is orphaned
      }
    });
  }

  // ---- texts ---------------------------------------------------------------
  // The service worker hands over the messages of the language in use (the
  // settings may choose one other than Chrome's); chrome.i18n until then.

  let messages = null;
  function t(key, ...subs) {
    const text = messages?.[key]?.message;
    if (text) return text.replace(/\$(\$|[1-9])/g, (m, which) => (which === '$' ? '$' : String(subs[Number(which) - 1] ?? '')));
    return chrome.i18n?.getMessage?.(key, subs.map(String)) || key;
  }
  async function loadTexts() {
    const response = await send('i18n:get');
    if (response.ok) messages = response.result.messages;
  }

  // ---- settings ------------------------------------------------------------

  try {
    chrome.storage.sync.get('badgeMode', (v) => {
      if (['hover', 'always', 'off'].includes(/** @type {string} */ (v?.badgeMode))) setMode(v.badgeMode);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if ('uiLanguage' in changes) loadTexts();
      if ('badgeMode' in changes) setMode(changes.badgeMode.newValue ?? 'hover');
      if ('badgeMode' in changes || 'badgeDisabledHosts' in changes || 'hideAds' in changes) {
        for (const entry of entries.values()) entry.resolvedAt = 0;
        refreshAll();
      }
    });
  } catch {
    // no storage access in this context
  }

  function setMode(next) {
    mode = next;
    if (mode === 'off') for (const entry of entries.values()) hide(entry, true);
    refreshAll();
  }

  // ---- UI ------------------------------------------------------------------

  const STYLE = `
    :host { all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; display: none; }
    :host([data-visible]) { display: block; }
    * { box-sizing: border-box; font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px; border: none; border-radius: 14px;
      background: rgba(9, 105, 218, 0.95); color: #fff; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.35); }
    .btn:hover { background: #0550ae; }
    .btn[data-state="done"] { background: #1a7f37; }
    .btn[data-state="error"] { background: #cf222e; }
    .btn[data-state="info"] { background: #6e7781; }
    .btn[data-state="confirm"] { background: #cf222e; }
    .btn svg { width: 16px; height: 16px; flex: none; }
    .ring-bg { stroke: rgba(255,255,255,.35); }
    .ring { stroke: #fff; transition: stroke-dashoffset .2s; }
    .menu { position: absolute; top: 32px; left: 0; min-width: 190px; padding: 4px; border-radius: 8px; background: #0d1117; color: #e6edf3;
      box-shadow: 0 4px 16px rgba(0,0,0,.45); display: none; }
    .menu[data-open] { display: block; }
    .menu .head { padding: 4px 8px 6px; color: #8b949e; font-weight: 500; font-size: 11px; }
    .menu button { display: block; width: 100%; text-align: left; padding: 6px 8px; border: none; border-radius: 6px; background: transparent;
      color: inherit; cursor: pointer; font-weight: 500; }
    .menu button:hover { background: #1f6feb; }
    .msg { position: absolute; top: 32px; left: 0; max-width: 260px; padding: 6px 8px; border-radius: 6px; background: #0d1117; color: #e6edf3;
      font-weight: 500; box-shadow: 0 4px 16px rgba(0,0,0,.45); display: none; white-space: normal; }
    .msg[data-open] { display: block; }
    .info { position: absolute; top: 32px; left: 0; width: max-content; max-width: 300px; padding: 6px 8px; border-radius: 6px; background: rgba(13,17,23,.92);
      color: #e6edf3; box-shadow: 0 4px 16px rgba(0,0,0,.45); display: none; }
    .info[data-open] { display: block; }
    .info .file { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 284px; }
    .info .detail { margin-top: 2px; font-weight: 500; color: #c9d1d9; }
    .msg[data-open] ~ .info { display: none; }
  `;

  const ICON_DOWN =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9M4 7l4 4 4-4M3 14h10"/></svg>';
  const ICON_DONE =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>';
  const ICON_ERROR =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3v6M8 12.5v.5"/></svg>';
  const ringIcon = (pct) => {
    const r = 6;
    const c = 2 * Math.PI * r;
    return (
      `<svg viewBox="0 0 16 16"><circle class="ring-bg" cx="8" cy="8" r="${r}" fill="none" stroke-width="2.5"/>` +
      `<circle class="ring" cx="8" cy="8" r="${r}" fill="none" stroke-width="2.5" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" transform="rotate(-90 8 8)"/></svg>`
    );
  };

  function createUi(entry) {
    const host = document.createElement('div');
    host.setAttribute('data-vdl-badge', '');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>
      <button class="btn" part="button" type="button" data-state="idle" title="${t('extName')}">${ICON_DOWN}<span class="label">${t('badgeDownload')}</span></button>
      <div class="menu" role="menu"></div>
      <div class="msg" role="status"></div>
      <div class="info" role="status"><div class="file"></div><div class="detail"></div></div>`;
    const button = root.querySelector('.btn');
    const swallow = (event) => {
      // Keep players from pausing/seeking on our clicks.
      event.stopPropagation();
    };
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'dblclick', 'touchstart']) host.addEventListener(type, swallow);
    host.addEventListener('click', swallow);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onClick(entry);
    });
    host.addEventListener('pointerenter', () => {
      entry.overBadge = true;
      renderPhase(entry);
      update(entry);
    });
    host.addEventListener('pointerleave', () => {
      entry.overBadge = false;
      renderPhase(entry);
      scheduleHide(entry);
    });
    entry.host = host;
    entry.root = root;
    entry.button = button;
    entry.menu = root.querySelector('.menu');
    entry.msg = root.querySelector('.msg');
    entry.info = root.querySelector('.info');
    attachHost(entry);
  }

  function attachHost(entry) {
    const fs = document.fullscreenElement;
    // In fullscreen only the fullscreen element's subtree is painted.
    const parent = fs && fs !== entry.video && fs.contains(entry.video) ? fs : document.documentElement;
    if (entry.host.parentNode !== parent) parent.appendChild(entry.host);
  }

  function setButton(entry, state, { label, icon, title } = /** @type {{label?:string, icon?:string, title?:string}} */ ({})) {
    const b = entry.button;
    b.dataset.state = state;
    b.innerHTML = `${icon ?? ICON_DOWN}<span class="label">${label ?? t('badgeDownload')}</span>`;
    b.title = title ?? t('extName');
  }

  function showMessage(entry, text, ms = 4000) {
    entry.msg.textContent = text;
    entry.msg.setAttribute('data-open', '');
    clearTimeout(entry.msgTimer);
    entry.msgTimer = setTimeout(() => entry.msg.removeAttribute('data-open'), ms);
  }

  function closeMenu(entry) {
    entry.menu.removeAttribute('data-open');
    entry.menuOpen = false;
  }

  function openMenu(entry, resolved) {
    const m = entry.menu;
    m.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = resolved.note ? t('badgeChooseQualityNote', resolved.note) : t('badgeChooseQuality');
    m.appendChild(head);
    for (const option of resolved.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = option.label;
      b.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(entry);
        start(entry, resolved, option.value);
      });
      m.appendChild(b);
    }
    m.setAttribute('data-open', '');
    entry.menuOpen = true;
    update(entry);
  }

  // ---- geometry and visibility --------------------------------------------

  function rectOf(video) {
    const r = video.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function eligible(entry) {
    const r = rectOf(entry.video);
    if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    return entry.video.isConnected;
  }

  function pointerInside(entry) {
    const r = rectOf(entry.video);
    return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
  }

  function wantsVisible(entry) {
    if (mode === 'off' || !entry.resolved?.show) return false;
    if (!eligible(entry)) return false;
    if (mode === 'always') return true;
    return entry.hovered || entry.overBadge || entry.menuOpen || entry.busy || entry.sticky || entry.phase === 'confirm';
  }

  function position(entry) {
    const r = rectOf(entry.video);
    const top = Math.max(r.top + 8, 4);
    const left = Math.max(r.left + 8, 4);
    entry.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function update(entry) {
    if (!entry.host) return;
    if (wantsVisible(entry)) {
      clearTimeout(entry.hideTimer);
      attachHost(entry);
      position(entry);
      entry.host.setAttribute('data-visible', '');
    } else if (!entry.hideTimer) {
      hide(entry);
    }
  }

  function scheduleHide(entry) {
    clearTimeout(entry.hideTimer);
    entry.hideTimer = setTimeout(() => {
      entry.hideTimer = null;
      if (!wantsVisible(entry)) hide(entry);
    }, HIDE_DELAY_MS);
  }

  function hide(entry, force = false) {
    if (!entry.host) return;
    if (!force && wantsVisible(entry)) return;
    entry.host.removeAttribute('data-visible');
    if (!entry.busy) closeMenu(entry);
  }

  // ---- resolution ----------------------------------------------------------

  // Post/reel shortcodes are 8+ characters; /reels/audio/<id>/ (the track a
  // reel uses) and similar pages are not posts. X posts: /<user>/status/<id>.
  const POST_LINK =
    /\/(?:(?:p|reels?|tv)\/(?!audio\/|tags?\/|locations?\/)([A-Za-z0-9_-]{8,})|[A-Za-z0-9_]{1,30}\/status\/(\d{5,}))(?:\/|$|\?)/;

  /**
   * Shortcode of the post a video belongs to (Instagram and X feeds): the
   * closest ancestor that still contains only this video and a /p/CODE/,
   * /reel/CODE/ or /user/status/ID link. Reel viewers keep the code of the reel in view in the
   * URL, used when the video sits in the middle of the viewport.
   */
  function postCodeFor(video) {
    let node = video.parentElement;
    for (let depth = 0; node && depth < 30; depth++, node = node.parentElement) {
      if (node.querySelectorAll('video').length > 1) break; // reached a container of several posts
      for (const a of node.querySelectorAll('a[href]')) {
        const m = POST_LINK.exec(a.getAttribute('href') || '');
        if (m) return m[1] ?? m[2];
      }
    }
    const fromUrl = POST_LINK.exec(location.pathname);
    if (fromUrl) {
      const r = video.getBoundingClientRect();
      const cx = innerWidth / 2;
      const cy = innerHeight / 2;
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return fromUrl[1] ?? fromUrl[2];
    }
    return null;
  }

  function describeVideo(video) {
    const src = video.currentSrc || video.src || video.querySelector('source')?.src || '';
    return {
      src,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      duration: Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration) : null,
      frameUrl: location.href,
      postCode: src.startsWith('blob:') ? postCodeFor(video) : null,
    };
  }

  async function resolve(entry, force = false) {
    if (!force && entry.resolved && Date.now() - entry.resolvedAt < RESOLVE_TTL_MS) return entry.resolved;
    if (entry.resolving) return entry.resolving;
    entry.resolving = (async () => {
      const info = describeVideo(entry.video);
      if (!info.src) return { show: false, reason: 'no-source' };
      const response = await send('badge:resolve', info);
      const result = response.ok ? response.result : { show: false, reason: 'error' };
      if (result.mode && result.mode !== mode) setMode(result.mode);
      entry.resolved = result;
      entry.resolvedAt = Date.now();
      if (result.show && !entry.host) createUi(entry);
      // A download of this video is still running (page reloaded, or started
      // from the popup): show its progress and let it be cancelled here.
      if (result.progress && !entry.busy && entry.host) {
        entry.busy = true;
        entry.phase = 'working';
        entry.itemId = result.progress.itemId ?? result.item?.id ?? null;
        entry.itemKey = result.item?.key ?? null;
        entry.itemPath = result.item?.path ?? null;
        entry.downloadId = result.progress.downloadId ?? null;
        entry.lastResolved = result;
        entry.progress = result.progress;
        renderPhase(entry);
        poll(entry);
      }
      return result;
    })().finally(() => {
      entry.resolving = null;
    });
    return entry.resolving;
  }

  // ---- actions -------------------------------------------------------------
  // Phases: idle → (menu) → working ⇄ confirm (cancel?) → done | error | info

  const CONFIRM_MS = 3000;

  function renderPhase(entry) {
    if (!entry.host) return;
    const p = entry.progress;
    if (entry.phase === 'working') {
      const pct = p?.pct ?? 0;
      const label = entry.overBadge ? t('badgeCancel') : (p?.label ?? t('badgeStarting'));
      setButton(entry, 'working', { icon: ringIcon(pct), label, title: t('badgeClickToCancel') });
    } else if (entry.phase === 'confirm') {
      setButton(entry, 'confirm', { icon: ICON_ERROR, label: t('badgeConfirmCancel'), title: t('badgeClickAgainToConfirm') });
    }
    renderInfo(entry);
  }

  function renderInfo(entry) {
    const p = entry.progress;
    const show =
      (entry.phase === 'working' || entry.phase === 'confirm') && (entry.overBadge || entry.hovered) && p && (p.filename || p.detail);
    if (!show) return entry.info.removeAttribute('data-open');
    entry.info.querySelector('.file').textContent = p.filename || '';
    entry.info.querySelector('.detail').textContent = p.detail || '';
    entry.info.setAttribute('data-open', '');
  }

  async function onClick(entry) {
    switch (entry.phase) {
      case 'working': {
        entry.phase = 'confirm';
        renderPhase(entry);
        clearTimeout(entry.confirmTimer);
        entry.confirmTimer = setTimeout(() => {
          if (entry.phase === 'confirm') {
            entry.phase = 'working';
            renderPhase(entry);
          }
        }, CONFIRM_MS);
        return;
      }
      case 'confirm': {
        clearTimeout(entry.confirmTimer);
        entry.phase = 'working';
        entry.cancelling = true;
        setButton(entry, 'working', { icon: ringIcon(entry.progress?.pct ?? 0), label: t('badgeCancelling') });
        const response = await send('badge:cancel', { itemId: entry.itemId, itemKey: entry.itemKey, itemPath: entry.itemPath });
        if (!response.ok) {
          entry.cancelling = false;
          showMessage(entry, response.error || t('badgeCancelFailed'));
        }
        return; // polling reports the cancelled state
      }
      case 'done': {
        if (entry.downloadId == null) return;
        const response = await send('badge:show', { downloadId: entry.downloadId });
        if (!response.ok) showMessage(entry, response.error || t('badgeFileNotFound'));
        return;
      }
      case 'error':
        if (entry.lastResolved) return start(entry, entry.lastResolved, entry.lastChoice);
        break;
      default:
        break;
    }
    if (entry.busy) return;
    if (entry.menuOpen) return closeMenu(entry);
    const resolved = await resolve(entry, true);
    if (entry.busy) return; // resolve resumed a running download
    if (!resolved.show) return hide(entry, true);
    if (resolved.status !== 'ok') return showMessage(entry, resolved.note || t('badgeCannotDownload'));
    if (resolved.options?.length > 1) return openMenu(entry, resolved);
    return start(entry, resolved, resolved.options?.[0]?.value ?? null);
  }

  async function start(entry, resolved, choice) {
    clearTimeout(entry.resetTimer);
    entry.sticky = false;
    entry.busy = true;
    entry.phase = 'working';
    entry.cancelling = false;
    entry.progress = null;
    entry.itemId = resolved.item.id;
    entry.itemKey = resolved.item.key ?? null;
    entry.itemPath = resolved.item.path ?? null;
    entry.downloadId = null;
    entry.lastResolved = resolved;
    entry.lastChoice = choice;
    entry.msg.removeAttribute('data-open');
    renderPhase(entry);
    update(entry);
    const payload = { id: resolved.item.id };
    if (resolved.payloadKey && choice) payload[resolved.payloadKey] = choice;
    const response = await send('badge:download', payload);
    if (!response.ok) return finish(entry, 'error', response.error || t('badgeStartFailed'));
    entry.downloadId = response.result?.downloadId ?? null;
    // Started on the master of the resolved sub-playlist: follow that job.
    if (response.result?.itemId && response.result.itemId !== entry.itemId) {
      entry.itemId = response.result.itemId;
      entry.itemKey = response.result.itemKey ?? null;
      entry.itemPath = response.result.itemPath ?? null;
    }
    entry.misses = 0;
    maybeShowHint(entry);
    poll(entry, 0);
  }

  function poll(entry, delay = POLL_MS) {
    clearTimeout(entry.pollTimer);
    entry.pollTimer = setTimeout(async () => {
      const response = await send('badge:progress', {
        itemId: entry.itemId,
        itemKey: entry.itemKey,
        itemPath: entry.itemPath,
        downloadId: entry.downloadId,
      });
      const p = response.ok ? response.result : null;
      if (!p) {
        // Briefly nothing to report (switching to the Referer fallback, service worker waking up).
        entry.misses = (entry.misses ?? 0) + 1;
        if (entry.misses > 10) return finish(entry, 'error', t('badgeStatusUnavailable'));
        return poll(entry);
      }
      entry.misses = 0;
      entry.progress = p;
      if (p.downloadId != null) entry.downloadId = p.downloadId;
      if (p.status === 'done')
        return finish(entry, 'done', p.filename ? t('badgeDoneFile', p.filename) : t('jobStateDone'), t('badgeDownloaded'));
      if (p.status === 'error') return finish(entry, 'error', p.error || t('jobStateError'), t('badgeRetry'));
      if (p.status === 'cancelled') return finish(entry, 'info', t('cancelled'), t('cancelled'));
      if (entry.phase !== 'confirm') renderPhase(entry);
      else renderInfo(entry);
      poll(entry);
    }, delay);
  }

  function finish(entry, state, message, label) {
    clearTimeout(entry.pollTimer);
    clearTimeout(entry.confirmTimer);
    entry.busy = false;
    entry.cancelling = false;
    entry.phase = state;
    entry.info.removeAttribute('data-open');
    const icon = state === 'done' ? ICON_DONE : state === 'error' ? ICON_ERROR : ICON_DOWN;
    const title = state === 'done' ? t('badgeShowInFolder') : state === 'error' ? t('badgeErrorRetry', message) : message;
    setButton(entry, state, { icon, label: label ?? (state === 'error' ? t('badgeRetry') : t('badgeOk')), title });
    showMessage(entry, message, 5000);
    // Keep the result (and its click action) for a while, then return to idle.
    entry.sticky = true;
    update(entry);
    clearTimeout(entry.resetTimer);
    entry.resetTimer = setTimeout(
      () => {
        entry.sticky = false;
        entry.phase = 'idle';
        setButton(entry, 'idle');
        update(entry);
        scheduleHide(entry);
      },
      state === 'error' ? 15000 : 8000,
    );
  }

  /** Once per profile: tell the user the download keeps going without the page. */
  function maybeShowHint(entry) {
    try {
      chrome.storage.local.get('badgeHintShown', (v) => {
        if (v?.badgeHintShown) return;
        chrome.storage.local.set({ badgeHintShown: true });
        showMessage(entry, t('badgeHint'), 9000);
      });
    } catch {
      // no storage access
    }
  }

  // Esc closes the quality menu and backs out of a pending cancel.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      for (const entry of entries.values()) {
        if (entry.menuOpen) closeMenu(entry);
        if (entry.phase === 'confirm') {
          clearTimeout(entry.confirmTimer);
          entry.phase = 'working';
          renderPhase(entry);
        }
      }
    },
    true,
  );

  // ---- tracking ------------------------------------------------------------

  function track(video) {
    if (entries.has(video)) return;
    const entry = {
      video,
      hovered: false,
      overBadge: false,
      menuOpen: false,
      busy: false,
      sticky: false,
      phase: 'idle',
      resolved: null,
      resolvedAt: 0,
    };
    entries.set(video, entry);
    const invalidate = () => {
      entry.resolvedAt = 0;
      if (mode === 'always') resolve(entry).then(() => update(entry));
    };
    video.addEventListener('loadedmetadata', invalidate);
    video.addEventListener('emptied', invalidate);
    if (mode === 'always') resolve(entry).then(() => update(entry));
  }

  /** @param {Document|ShadowRoot} [root] */
  function scan(root = document) {
    for (const video of root.querySelectorAll('video')) track(video);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) scan(el.shadowRoot);
  }

  function refreshAll() {
    for (const [video, entry] of entries) {
      if (!video.isConnected) {
        entry.host?.remove();
        entries.delete(video);
        continue;
      }
      if (mode === 'always' && !entry.resolved) resolve(entry).then(() => update(entry));
      update(entry);
    }
  }

  let frame = 0;
  function onPointerMove(event) {
    pointer = { x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (mode === 'off') return;
      for (const entry of entries.values()) {
        const inside = pointerInside(entry);
        if (inside === entry.hovered) {
          if (inside) update(entry);
          continue;
        }
        entry.hovered = inside;
        if (entry.info) renderInfo(entry);
        if (inside) {
          resolve(entry).then(() => update(entry));
        } else {
          scheduleHide(entry);
        }
      }
    });
  }

  let layoutFrame = 0;
  function onLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      for (const entry of entries.values()) if (entry.host?.hasAttribute('data-visible')) position(entry);
    });
  }

  function listen() {
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    window.addEventListener('scroll', onLayout, { capture: true, passive: true });
    window.addEventListener('resize', onLayout, { passive: true });
    document.addEventListener('fullscreenchange', () => {
      for (const entry of entries.values())
        if (entry.host) {
          attachHost(entry);
          update(entry);
        }
    });
    document.addEventListener('pointerleave', () => {
      pointer = { x: -1, y: -1 };
      for (const entry of entries.values()) {
        entry.hovered = false;
        scheduleHide(entry);
      }
    });

    new MutationObserver(() => {
      clearTimeout(window.__vdlBadgeScanTimer);
      window.__vdlBadgeScanTimer = setTimeout(() => {
        scan();
        refreshAll();
      }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => {
      scan();
      refreshAll();
    }, 2000);
    scan();
  }

  // Badges appear once the texts are known.
  loadTexts().finally(listen);
})();
