// Runs in the PAGE's main world on facebook.com (registered by the service
// worker from src/sites/facebook/site.js). The web client carries every
// video's data in inline JSON blocks and GraphQL responses: progressive MP4s
// with video AND audio (browser_native_hd_url / browser_native_sd_url, older
// playable_url_quality_hd / playable_url) and the DASH manifest. The player
// itself streams separate DASH tracks, which is what the network capture sees.
//
// Sources: inline JSON <script> blocks, fetch/XHR responses (often several
// JSON documents, one per line). Findings are posted to the isolated-world
// bridge (src/sites/bridge.js) via window.postMessage.

(() => {
  // = version in site.js; bump when the service worker must notice a change.
  const VERSION = 1;
  if (window.__vdlFacebookVersion === VERSION) return;
  window.__vdlFacebookVersion = VERSION;
  window.__vdlFacebookHooked = true;

  const known = new Map(); // video id -> item, replayed when a new bridge asks
  // Owners are often only {__typename, id} on the video; their name sits in a
  // User/Page object elsewhere in the data (Reels).
  const names = new Map(); // actor id -> name
  const videoKeys = new Map(); // video id -> its file-related field names (diagnostics)
  const MAX_DEPTH = 60;
  // Fields of a video object; `dash_manifests: [{manifest_xml}]` is the newer manifest form.
  const FIELDS = ['browser_native_hd_url', 'browser_native_sd_url', 'playable_url_quality_hd', 'playable_url', 'dash_manifest'];
  const TEXT_HINTS = [...FIELDS, 'manifest_xml', 'dash_manifest_urls'];
  const stats = {
    hooked: true,
    responses: 0,
    jsonScanned: 0,
    scriptsScanned: 0,
    textWithField: 0,
    found: 0,
    parseErrors: 0,
    // Video objects seen, and those whose files were not found (field names only, for the debug info).
    videosSeen: 0,
    videosWithoutFiles: 0,
    withoutFilesKeys: [],
    sampleKeys: [],
  };
  window.__vdlFacebookStats = stats;
  const sampleKeySet = new Set();
  function sampleKey(key) {
    if (sampleKeySet.size >= 40 || sampleKeySet.has(key)) return;
    if (/video|dash|playable|manifest|browser_native/i.test(key)) {
      sampleKeySet.add(key);
      stats.sampleKeys = [...sampleKeySet];
    }
  }

  let statsTimer = null;
  function sendStats() {
    statsTimer = null;
    window.postMessage({ __vdl: 'site-stats', site: 'facebook', stats: { ...stats, url: location.href } }, '*');
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

  const isManifest = (text) => typeof text === 'string' && text.includes('<MPD');

  /** A video object → item, with the post's text from the context. */
  function pick(node, ctx) {
    const hd = absolute(node.browser_native_hd_url ?? node.playable_url_quality_hd);
    const sd = absolute(node.browser_native_sd_url ?? node.playable_url);
    const manifest = [node.dash_manifest, node.dash_manifests?.[0]?.manifest_xml].find(isManifest) ?? null;
    // Some videos only name their manifest's address.
    const manifestUrl = absolute(node.dash_manifest_urls?.[0]?.manifest_url);
    if (!hd && !sd && !manifest && !manifestUrl) return null;
    // The files often sit below the video object (videoDeliveryLegacyFields,
    // videoDeliveryResponseFragment…): its id, length and owner come from there.
    const own = node.videoId ?? node.video_id ?? node.id;
    const video = ctx.video && (own == null || String(own) === ctx.video.id) ? ctx.video : null;
    // A video has an id; a URL alone (a thumbnail's data) is not one.
    const id = own ?? video?.id;
    if (id == null) return null;
    return {
      id: String(id),
      hd,
      sd,
      dashManifest: manifest,
      dashManifestUrl: manifestUrl,
      duration: durationOf(node) ?? video?.duration ?? null,
      width: node.width ?? node.original_width ?? video?.width ?? null,
      height: node.height ?? node.original_height ?? video?.height ?? null,
      ownerId: node.owner?.id != null ? String(node.owner.id) : (video?.ownerId ?? null),
      owner: node.owner?.name ?? video?.owner ?? ctx.owner ?? null,
      text: node.title?.text ?? node.message?.text ?? video?.text ?? ctx.text ?? null,
    };
  }

  function durationOf(node) {
    const seconds =
      typeof node.playable_duration_in_ms === 'number'
        ? node.playable_duration_in_ms / 1000
        : typeof node.length_in_second === 'number'
          ? node.length_in_second
          : null;
    return seconds ? Math.round(seconds) : null;
  }

  function walk(node, out, ctx, depth = 0) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out, ctx, depth + 1);
      return;
    }
    if (node.id != null && typeof node.name === 'string' && (node.__isActor || node.__typename === 'User' || node.__typename === 'Page')) {
      names.set(String(node.id), node.name);
    }
    // A post: its text and author apply to the video below it.
    if (typeof node.message?.text === 'string') ctx = { ...ctx, text: node.message.text };
    if (typeof node.actors?.[0]?.name === 'string') ctx = { ...ctx, owner: node.actors[0].name };
    // A video object (Reels, Watch: __typename Video, with its length): what lies below it belongs to it.
    if (node.id != null && (node.__typename === 'Video' || durationOf(node) != null)) {
      if (!videoKeys.has(String(node.id)) && videoKeys.size < 200) {
        videoKeys.set(
          String(node.id),
          Object.keys(node).filter((k) => /dash|manifest|url|playable|native|delivery/i.test(k)),
        );
      }
      ctx = {
        ...ctx,
        video: {
          id: String(node.id),
          duration: durationOf(node),
          width: node.width ?? null,
          height: node.height ?? null,
          ownerId: node.owner?.id != null ? String(node.owner.id) : null,
          owner: node.owner?.name ?? null,
          text: node.title?.text ?? null,
        },
      };
    }
    if (FIELDS.some((f) => typeof node[f] === 'string') || Array.isArray(node.dash_manifests) || Array.isArray(node.dash_manifest_urls)) {
      const item = pick(node, ctx);
      if (item) out.push(item);
    }
    for (const key in node) {
      sampleKey(key);
      const value = node[key];
      if (value && typeof value === 'object') walk(value, out, ctx, depth + 1);
    }
  }

  function publish(found) {
    const fresh = [];
    // Videos whose owner's name has arrived since they were reported.
    for (const item of known.values()) {
      if (!item.owner && names.has(item.ownerId) && !found.some((f) => f.id === item.id)) found.push({ ...item });
    }
    for (const item of found) {
      const before = known.get(item.id);
      // The same video comes back with more data (a manifest, then the MP4 URLs): keep the fullest.
      let merged = before ? { ...before, ...Object.fromEntries(Object.entries(item).filter(([, v]) => v != null)) } : item;
      if (!merged.owner && names.has(merged.ownerId)) merged = { ...merged, owner: names.get(merged.ownerId) };
      if (before && JSON.stringify(before) === JSON.stringify(merged)) continue;
      known.set(item.id, merged);
      fresh.push(merged);
    }
    stats.found = known.size;
    const missing = [...videoKeys.keys()].filter((id) => !known.has(id));
    stats.videosSeen = videoKeys.size;
    stats.videosWithoutFiles = missing.length;
    stats.withoutFilesKeys = missing.slice(0, 3).map((id) => videoKeys.get(id));
    scheduleStats();
    if (fresh.length) window.postMessage({ __vdl: 'site-media', site: 'facebook', items: fresh }, '*');
  }

  function scanText(text) {
    const waitingForName = [...known.values()].some((it) => !it.owner && it.ownerId);
    if (!text || !(TEXT_HINTS.some((f) => text.indexOf(f) !== -1) || (waitingForName && text.indexOf('"__isActor"') !== -1))) return;
    stats.textWithField++;
    // GraphQL responses are often several JSON documents, one per line.
    const chunks = text[0] === '{' || text[0] === '[' ? [text] : [];
    if (!chunks.length || text.indexOf('\n{') !== -1) {
      chunks.length = 0;
      for (const line of text.split('\n')) if (line.trim()) chunks.push(line.trim());
    }
    for (const chunk of chunks) {
      try {
        const out = [];
        walk(JSON.parse(chunk.replace(/^for \(;;\);/, '')), out, {});
        stats.jsonScanned++;
        publish(out);
      } catch {
        stats.parseErrors++;
        scheduleStats();
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
    if (known.size) window.postMessage({ __vdl: 'site-media', site: 'facebook', items: [...known.values()] }, '*');
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
