// Content script: runs in every frame of every page and reports media
// elements to the service worker.
//
// Finds <video>/<audio> (their <source> and subtitle <track> children) in the document and in
// open shadow roots, watches for dynamically added players, and sends the
// list whenever it changes. Network capture sees the bytes; this script sees
// resolution, duration and players whose source has not been fetched yet.

(() => {
  if (window.__videoDownloaderScannerLoaded) return;
  window.__videoDownloaderScannerLoaded = true;
  // Content scripts live in an isolated world; a DOM attribute is the one
  // thing the page (and e2e tests) can observe.
  document.documentElement.dataset.vdlScanner = 'ready';

  const SCAN_DEBOUNCE_MS = 300;
  let lastReport = '';
  let timer = null;

  function kindOf(url, element) {
    if (url.startsWith('blob:')) return 'blob';
    if (!/^https?:/i.test(url)) return null; // data:, javascript:, chrome-extension:
    const ext = (() => {
      try {
        const last = new URL(url).pathname.split('/').pop() ?? '';
        const dot = last.lastIndexOf('.');
        return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
      } catch {
        return '';
      }
    })();
    if (ext === 'm3u8') return 'hls';
    if (ext === 'mpd') return 'dash';
    return element.tagName === 'AUDIO' ? 'audio' : 'video';
  }

  function collectMedia(root, out, seen) {
    for (const el of root.querySelectorAll('video, audio')) {
      if (seen.has(el)) continue;
      seen.add(el);
      const urls = new Set();
      if (el.currentSrc) urls.add(el.currentSrc);
      if (el.getAttribute('src')) urls.add(el.src);
      for (const s of el.querySelectorAll('source')) if (s.src) urls.add(s.src);

      const width = el.videoWidth || null;
      const height = el.videoHeight || null;
      const duration = Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null;

      for (const url of urls) {
        const kind = kindOf(url, el);
        if (!kind) continue;
        out.push({ url, kind, width, height, duration, element: el.tagName.toLowerCase() });
      }

      // Subtitle/caption tracks of this player (sidecar .vtt/.srt files).
      for (const t of el.querySelectorAll('track')) {
        if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
        if (!/^https?:/i.test(t.src)) continue;
        out.push({ url: t.src, kind: 'subtitle', lang: t.srclang || null, label: t.label || null, default: t.default, element: 'track' });
      }
    }
    // Open shadow roots.
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) collectMedia(host.shadowRoot, out, seen);
    }
  }

  function pageInfo() {
    const og = /** @type {HTMLMetaElement|null} */ (document.querySelector('meta[property="og:title"]'))?.content;
    return { url: location.href, title: og || document.title || '', isTop: window === window.top };
  }

  function scanNow() {
    timer = null;
    const items = [];
    try {
      collectMedia(document, items, new Set());
    } catch {
      return;
    }
    const payload = { items, page: pageInfo() };
    const serialized = JSON.stringify(payload);
    if (serialized === lastReport) return;
    lastReport = serialized;
    try {
      chrome.runtime.sendMessage({ type: 'dom:media', payload }, () => void chrome.runtime.lastError);
    } catch {
      // Extension was reloaded; this script instance is orphaned.
    }
  }

  function scheduleScan() {
    if (timer) return;
    timer = setTimeout(scanNow, SCAN_DEBOUNCE_MS);
  }

  // Media elements fire these when their metadata (size/duration) is known.
  for (const type of ['loadedmetadata', 'durationchange', 'resize', 'loadstart', 'play']) {
    document.addEventListener(type, scheduleScan, true);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  // Periodic rescan catches players inside shadow roots we cannot observe.
  setInterval(scheduleScan, 3000);

  // Back from the back/forward cache: the tab's list was cleared when the page
  // was left, and nothing reloads. Report everything again.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    lastReport = null;
    scanNow();
  });

  scanNow();
})();
