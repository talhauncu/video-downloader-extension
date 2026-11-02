// Isolated-world counterpart of a site extractor (src/sites/<site>/main.js):
// relays the page's findings to the service worker. One bridge serves every
// site; only messages from this very window are accepted.

(() => {
  if (window.__vdlSiteBridge) return;
  window.__vdlSiteBridge = true;

  // Liveness check from the service worker: only a bridge belonging to the
  // current extension instance can answer.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'bridge:ping') {
      sendResponse({ alive: true });
      return false;
    }
    return false;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || typeof event.data.site !== 'string') return;
    const { __vdl, site } = event.data;
    let message = null;
    if (__vdl === 'site-media') message = { type: 'site:media', payload: { site, pageUrl: location.href, items: event.data.items } };
    else if (__vdl === 'site-stats') message = { type: 'site:stats', payload: { site, stats: event.data.stats } };
    if (!message) return;
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      // extension reloaded
    }
  });

  // Ask an extractor already running (from before an extension reload) to replay.
  window.postMessage({ __vdl: 'site-resync' }, '*');
})();
