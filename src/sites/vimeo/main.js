// Runs in the PAGE's main world on vimeo.com and in Vimeo player frames
// embedded anywhere (registered by the service worker from
// src/sites/vimeo/site.js, in every frame). The player's configuration —
// inline as `window.playerConfig = {…}` in the player document, or fetched as
// JSON from …/config — names the video and its files: progressive MP4s with
// video AND audio (request.files.progressive) and the HLS master
// (request.files.hls).
//
// Findings are posted to the isolated-world bridge (src/sites/bridge.js) via
// window.postMessage.

(() => {
  // = version in site.js; bump when the service worker must notice a change.
  const VERSION = 1;
  if (window.__vdlVimeoVersion === VERSION) return;
  window.__vdlVimeoVersion = VERSION;
  window.__vdlVimeoHooked = true;

  const known = new Map(); // video id -> item, replayed when a new bridge asks
  const stats = { hooked: true, responses: 0, jsonScanned: 0, scriptsScanned: 0, configs: 0, found: 0, parseErrors: 0 };
  window.__vdlVimeoStats = stats;

  let statsTimer = null;
  function sendStats() {
    statsTimer = null;
    window.postMessage({ __vdl: 'site-stats', site: 'vimeo', stats: { ...stats, url: location.href } }, '*');
  }
  function scheduleStats() {
    if (!statsTimer) statsTimer = setTimeout(sendStats, 500);
  }

  function absolute(url) {
    try {
      return typeof url === 'string' && url ? new URL(url, location.href).href : null;
    } catch {
      return null;
    }
  }

  /** A player configuration ({video, request: {files}}) → item. */
  function pick(config) {
    const video = config.video ?? {};
    const files = config.request?.files ?? {};
    const progressive = (Array.isArray(files.progressive) ? files.progressive : [])
      .filter((f) => f && typeof f.url === 'string')
      .map((f) => ({
        url: absolute(f.url),
        width: f.width ?? null,
        height: f.height ?? null,
        fps: f.fps ?? null,
        quality: f.quality ?? null,
      }))
      .filter((f) => f.url);
    const cdns = files.hls?.cdns ?? {};
    const cdn = cdns[files.hls?.default_cdn] ?? Object.values(cdns)[0] ?? null;
    // The H.264 master first: QuickTime opens it without converting.
    const hls = absolute(cdn?.avc_url ?? cdn?.url);
    if (video.id == null || (!progressive.length && !hls)) return null;
    return {
      id: String(video.id),
      title: typeof video.title === 'string' ? video.title : null,
      owner: video.owner?.name ?? null,
      duration: typeof video.duration === 'number' ? Math.round(video.duration) : null,
      width: video.width ?? null,
      height: video.height ?? null,
      progressive,
      hls,
    };
  }

  function walk(node, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out, depth + 1);
      return;
    }
    if (node.request?.files && node.video) {
      stats.configs++;
      const item = pick(node);
      if (item) out.push(item);
      return;
    }
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') walk(value, out, depth + 1);
    }
  }

  function publish(found) {
    const fresh = found.filter((item) => JSON.stringify(known.get(item.id)) !== JSON.stringify(item));
    for (const item of fresh) known.set(item.id, item);
    stats.found = known.size;
    scheduleStats();
    if (fresh.length) window.postMessage({ __vdl: 'site-media', site: 'vimeo', items: fresh }, '*');
  }

  function scanJson(text) {
    try {
      const out = [];
      walk(JSON.parse(text), out);
      stats.jsonScanned++;
      publish(out);
    } catch {
      stats.parseErrors++;
      scheduleStats();
    }
  }

  /** The object literal starting at text[start] ('{'), cut at its matching brace (strings respected). */
  function objectAt(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  // 1. Inline configuration in the player document: window.playerConfig = {…}
  const scannedScripts = new WeakSet();
  function scanScripts() {
    for (const script of document.querySelectorAll('script:not([src])')) {
      if (scannedScripts.has(script)) continue;
      const text = script.textContent ?? '';
      if (!text.includes('playerConfig') && !text.includes('"request"')) continue;
      scannedScripts.add(script);
      stats.scriptsScanned++;
      const at = text.search(/playerConfig\s*=\s*\{/);
      const json = at === -1 ? (script.getAttribute('type') === 'application/json' ? text : null) : objectAt(text, text.indexOf('{', at));
      if (json) scanJson(json);
    }
  }
  new MutationObserver(scanScripts).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__vdl !== 'site-resync') return;
    if (known.size) window.postMessage({ __vdl: 'site-media', site: 'vimeo', items: [...known.values()] }, '*');
    sendStats();
  });
  scanScripts();
  document.addEventListener('DOMContentLoaded', scanScripts);
  setTimeout(sendStats, 1500);

  // 2. fetch() and XMLHttpRequest: the …/config JSON (vimeo.com pages load it).
  const scanText = (text) => {
    if (text && text.indexOf('"request"') !== -1 && text.indexOf('"files"') !== -1) scanJson(text);
  };
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      stats.responses++;
      if (/json/.test(response.headers.get('content-type') ?? '')) {
        response
          .clone()
          .text()
          .then(scanText)
          .catch(() => {});
      }
    } catch {
      // ignore
    }
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', () => {
      try {
        stats.responses++;
        if (this.responseType === '' || this.responseType === 'text') scanText(this.responseText);
        else if (this.responseType === 'json' && this.response) scanText(JSON.stringify(this.response));
      } catch {
        // ignore
      }
    });
    return originalOpen.apply(this, args);
  };
})();
