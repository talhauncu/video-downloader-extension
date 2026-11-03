// Runs in the PAGE's main world on x.com / twitter.com (registered by the
// service worker from src/sites/twitter/site.js). The web client loads posts
// as JSON (GraphQL responses); every video and GIF in them carries
// `video_info.variants`: progressive MP4s with video AND audio, plus the HLS
// master the player streams. The network capture only sees the HLS pieces;
// these give one complete file per video.
//
// Sources: fetch/XHR responses. Findings are posted to the isolated-world
// bridge (src/sites/bridge.js) via window.postMessage.

(() => {
  // = version in site.js; bump when the service worker must notice a change.
  const VERSION = 1;
  if (window.__vdlTwitterVersion === VERSION) return;
  window.__vdlTwitterVersion = VERSION;
  window.__vdlTwitterHooked = true;

  const seen = new Set();
  const known = new Map(); // media id -> item, replayed when a new bridge asks
  const MAX_DEPTH = 60;
  const stats = { hooked: true, responses: 0, jsonScanned: 0, textWithField: 0, found: 0, parseErrors: 0, sampleKeys: [] };
  window.__vdlTwitterStats = stats;
  const sampleKeySet = new Set();
  function sampleKey(key) {
    if (sampleKeySet.size >= 40 || sampleKeySet.has(key)) return;
    if (/video|variant|media|playback/i.test(key)) {
      sampleKeySet.add(key);
      stats.sampleKeys = [...sampleKeySet];
    }
  }

  let statsTimer = null;
  function sendStats() {
    statsTimer = null;
    window.postMessage({ __vdl: 'site-stats', site: 'twitter', stats: { ...stats, url: location.href } }, '*');
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

  // …/<user>/status/<tweet id>/video/1
  const STATUS = /\/([A-Za-z0-9_]{1,30})\/status\/(\d+)/;

  /** One media object (extended_entities.media[i]) → item, with the post's text and user from the context. */
  function pick(media, ctx) {
    const variants = (media.video_info.variants || [])
      .filter((v) => v && typeof v.url === 'string')
      .map((v) => ({ url: absolute(v.url), type: v.content_type ?? null, bitrate: typeof v.bitrate === 'number' ? v.bitrate : null }))
      .filter((v) => v.url);
    if (!variants.length) return null;
    const status = STATUS.exec(media.expanded_url ?? '');
    const millis = media.video_info.duration_millis;
    return {
      mediaId: String(media.id_str ?? media.media_key ?? variants[0].url),
      tweetId: status?.[2] ?? ctx.tweetId ?? null,
      user: status?.[1] ?? null,
      text: ctx.text ?? null,
      type: media.type ?? null, // 'video' | 'animated_gif'
      duration: typeof millis === 'number' && millis > 0 ? Math.round(millis / 1000) : null,
      width: media.original_info?.width ?? null,
      height: media.original_info?.height ?? null,
      variants,
    };
  }

  function walk(node, out, ctx, depth = 0) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out, ctx, depth + 1);
      return;
    }
    // A post: its text (and id) apply to the media below it; a quoted post sets its own.
    if (typeof node.full_text === 'string') ctx = { ...ctx, text: node.full_text, tweetId: node.id_str ?? ctx.tweetId };
    if (node.video_info && Array.isArray(node.video_info.variants)) {
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
    const fresh = found.filter((item) => {
      if (seen.has(item.mediaId)) return false;
      seen.add(item.mediaId);
      known.set(item.mediaId, item);
      return true;
    });
    stats.found += fresh.length;
    scheduleStats();
    if (fresh.length) window.postMessage({ __vdl: 'site-media', site: 'twitter', items: fresh }, '*');
  }

  function scanText(text) {
    if (!text || text.indexOf('video_info') === -1) return;
    stats.textWithField++;
    try {
      const out = [];
      walk(JSON.parse(text), out, {});
      stats.jsonScanned++;
      publish(out);
    } catch {
      stats.parseErrors++;
      scheduleStats();
    }
  }

  // A (re)loaded extension installs a new bridge, which asks for everything
  // this instance has already found.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.__vdl !== 'site-resync') return;
    if (known.size) window.postMessage({ __vdl: 'site-media', site: 'twitter', items: [...known.values()] }, '*');
    sendStats();
  });
  setTimeout(sendStats, 1500);

  // 1. fetch()
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

  // 2. XMLHttpRequest
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
