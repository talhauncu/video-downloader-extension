// Runs in the PAGE's main world on instagram.com (registered by the service
// worker from src/sites/instagram/site.js). Instagram's web client receives, for every reel/post, a
// `video_versions` list: progressive MP4 URLs with video AND audio muxed.
// The player itself streams separate DASH tracks, which is what the network
// capture sees; these URLs give one complete file per video instead.
//
// Sources: inline JSON <script> blocks in the HTML, and fetch/XHR responses.
// Findings are posted to the isolated-world bridge (src/sites/bridge.js) via
// window.postMessage.

(() => {
  // Bump when this file changes in a way the service worker must notice: an
  // older instance (left in the page by a previous extension load) is then
  // supplemented by this one instead of being trusted.
  const VERSION = 4; // = version in site.js
  if (window.__vdlInstagramVersion === VERSION) return;
  window.__vdlInstagramVersion = VERSION;
  window.__vdlInstagramHooked = true;

  const seen = new Set();
  const known = new Map(); // key -> item, replayed when a new bridge asks
  const MAX_DEPTH = 40;
  const stats = {
    hooked: true,
    responses: 0,
    jsonScanned: 0,
    scriptsScanned: 0,
    textWithField: 0,
    found: 0,
    manifests: 0,
    parseErrors: 0,
    sampleKeys: [],
  };
  window.__vdlInstagramStats = stats;
  const sampleKeySet = new Set();
  function sampleKey(key) {
    if (sampleKeySet.size >= 40 || sampleKeySet.has(key)) return;
    if (/video|dash|playback|media_url|clip/i.test(key)) {
      sampleKeySet.add(key);
      stats.sampleKeys = [...sampleKeySet];
    }
  }
  let statsTimer = null;

  function sendStats() {
    statsTimer = null;
    window.postMessage({ __vdl: 'site-stats', site: 'instagram', stats: { ...stats, url: location.href } }, '*');
  }
  function scheduleStats() {
    if (!statsTimer) statsTimer = setTimeout(sendStats, 500);
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return null;
    }
  }

  function pick(obj) {
    const versions = (obj.video_versions || [])
      .filter((v) => v && typeof v.url === 'string')
      .map((v) => ({ url: absolute(v.url), width: v.width ?? null, height: v.height ?? null, type: v.type ?? null }))
      .filter((v) => v.url);
    if (typeof obj.video_url === 'string' && !versions.length) {
      versions.push({ url: absolute(obj.video_url), width: obj.original_width ?? null, height: obj.original_height ?? null, type: null });
    }
    const dashManifest =
      typeof obj.video_dash_manifest === 'string' && obj.video_dash_manifest.includes('<MPD') ? obj.video_dash_manifest : null;
    if (!versions.length && !dashManifest) return null;
    if (dashManifest) stats.manifests++;
    const pk = String(obj.pk ?? obj.id ?? versions[0]?.url ?? Math.random());
    return {
      dashManifest,
      pk,
      code: obj.code ?? null,
      duration: typeof obj.video_duration === 'number' ? Math.round(obj.video_duration) : null,
      width: obj.original_width ?? null,
      height: obj.original_height ?? null,
      username: obj.user?.username ?? obj.owner?.username ?? null,
      caption: obj.caption?.text ?? (typeof obj.caption === 'string' ? obj.caption : null),
      versions,
    };
  }

  function walk(node, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out, depth + 1);
      return;
    }
    if (Array.isArray(node.video_versions) || typeof node.video_dash_manifest === 'string' || typeof node.video_url === 'string') {
      const item = pick(node);
      if (item) out.push(item);
    }
    for (const key in node) {
      sampleKey(key);
      const value = node[key];
      if (value && typeof value === 'object') walk(value, out, depth + 1);
    }
  }

  function publish(found) {
    const fresh = found.filter((item) => {
      const key = `${item.pk}|${item.versions[0]?.url ?? 'dash'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      known.set(key, item);
      return true;
    });
    stats.found += fresh.length;
    scheduleStats();
    if (!fresh.length) return;
    window.postMessage({ __vdl: 'site-media', site: 'instagram', items: fresh }, '*');
  }

  function scanText(text) {
    if (!text) return;
    if (text.indexOf('video_versions') === -1 && text.indexOf('video_dash_manifest') === -1 && text.indexOf('video_url') === -1) {
      // Still learn which video-ish keys this JSON uses, cheaply.
      if (text.length < 2_000_000 && /video|dash|playback/i.test(text)) {
        try {
          walk(JSON.parse(text), [], 0);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    stats.textWithField++;
    scheduleStats();
    // Some responses are several JSON documents separated by newlines.
    const chunks = text.length > 2 && text[0] !== '{' && text[0] !== '[' ? [] : [text];
    if (!chunks.length) for (const line of text.split('\n')) if (line.trim()) chunks.push(line.trim());
    for (const chunk of chunks) {
      try {
        const out = [];
        walk(JSON.parse(chunk), out);
        stats.jsonScanned++;
        publish(out);
      } catch {
        stats.parseErrors++;
      }
    }
  }

  // 1. Inline JSON blocks (initial page data).
  const scannedScripts = new WeakSet(); // per instance: a newer instance rescans everything
  function scanScripts() {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (scannedScripts.has(script)) continue;
      scannedScripts.add(script);
      stats.scriptsScanned++;
      scanText(script.textContent);
    }
  }
  new MutationObserver(scanScripts).observe(document.documentElement, { childList: true, subtree: true });
  // A (re)loaded extension installs a new bridge, which asks for everything
  // this instance has already found.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__vdl !== 'site-resync') return;
    if (known.size) window.postMessage({ __vdl: 'site-media', site: 'instagram', items: [...known.values()] }, '*');
    sendStats();
  });

  scanScripts();
  document.addEventListener('DOMContentLoaded', scanScripts);
  setTimeout(sendStats, 1500);

  // 2. fetch()
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      stats.responses++;
      const type = response.headers.get('content-type') ?? '';
      if (/json|javascript|text\/plain|text\/html/.test(type) || !type) {
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

  // 3. XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', () => {
      try {
        stats.responses++;
        if (this.responseType === '' || this.responseType === 'text') scanText(this.responseText);
      } catch {
        // ignore
      }
    });
    return originalOpen.apply(this, args);
  };
})();
