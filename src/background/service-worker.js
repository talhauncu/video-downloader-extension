// Entry point of the extension's background service worker (MV3).

import { handleMessage } from './messages.js';
import { startCapture } from './capture.js';
import { runOffscreenJob } from './offscreen.js';
import { cdnTrackHint } from '../lib/media-url.js';
import { registerSiteScripts, watchSiteTabs, ensureInjected, addSiteHost } from './sites.js';
import { registerCommands, downloadBest } from './quick.js';
import { startIndicator } from './indicator.js';
import { initI18n, currentLanguage } from '../lib/i18n.js';
import { getSettings } from '../lib/settings.js';

// Texts follow the "uiLanguage" setting; messages wait until they are loaded.
let i18nReady = getSettings()
  .then((s) => initI18n(s.uiLanguage))
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.uiLanguage)
    i18nReady = getSettings()
      .then((s) => initI18n(s.uiLanguage))
      .catch(() => {});
});

startCapture();
registerSiteScripts().catch((e) => console.warn('[video-downloader] site scripts', e));
registerCommands();
startIndicator();
watchSiteTabs();
// Lets tests (and debugging) confirm the listeners are attached.
globalThis.__vdlReady = true;
// Debug hooks for tests and the devtools console of the service worker.
globalThis.__vdl = {
  runOffscreenJob,
  cdnTrackHint,
  registerSiteScripts,
  downloadBest,
  ensureInjected,
  addSiteHost,
  language: () => i18nReady.then(() => currentLanguage()),
};

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[video-downloader] installed', details.reason);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false; // handled by the offscreen document
  // Returning true keeps the channel open for async responses.
  i18nReady
    .then(() => handleMessage(message, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});
