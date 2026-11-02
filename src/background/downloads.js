// Starts a browser download for a captured progressive file.
//
// Some CDNs refuse requests without the page's Referer/Origin. chrome.downloads
// cannot set those headers, and declarativeNetRequest rules do not apply to
// its requests either (verified), but they DO apply to fetches made by the
// extension's own documents. So:
//   1. try a direct chrome.downloads.download (fast, streams to disk);
//   2. if the server rejects it, fetch the file from the offscreen document
//      with a temporary header rule, store it in OPFS and download the Blob.
//
// Stream jobs (HLS/DASH) hand their finished Blob to `downloadBlob`.

import * as store from './store.js';
import { buildFilename } from '../lib/filename.js';
import { extensionOf, KIND } from '../lib/media-url.js';
import { runOffscreenJob } from './offscreen.js';
import { addUrlRule, removeRule } from './header-rules.js';
import { recordDownload } from './history.js';
import { getSettings } from '../lib/settings.js';
import { pathOf } from '../lib/badge-resolve.js';
import { t } from '../lib/i18n.js';

const DEFAULT_EXT = { [KIND.VIDEO]: 'mp4', [KIND.AUDIO]: 'm4a' };
const SERVER_ERRORS = new Set([
  'SERVER_FORBIDDEN',
  'SERVER_UNAUTHORIZED',
  'SERVER_BAD_CONTENT',
  'SERVER_FAILED',
  'NETWORK_INVALID_REQUEST',
]);

/** downloadId -> tracked download */
const tracked = new Map();
/**
 * downloads.onChanged can report a final state (a fast 403) before the
 * chrome.downloads.download() promise has handed us the id. Such deltas are
 * parked here and replayed when the id gets tracked.
 */
const earlyFinal = new Map(); // downloadId -> { state, delta }
const listeners = new Set();
/**
 * Latest progressive download per page entry (`${tabId}:${itemId}`), kept after
 * it ends so the in-page badge can show the result, open the folder or retry.
 */
const byItem = new Map();
const BY_ITEM_LIMIT = 200;

function remember(job) {
  if (job.tabId == null || !job.itemId) return;
  // By id, by the item's stable key and by URL path: a page reload re-creates
  // the item with a new id, and some hosts rotate mirror hostnames and tokens.
  for (const key of [
    `${job.tabId}:id:${job.itemId}`,
    job.itemKey ? `${job.tabId}:key:${job.itemKey}` : null,
    job.itemPath ? `${job.tabId}:path:${job.itemPath}` : null,
  ].filter(Boolean)) {
    byItem.delete(key);
    byItem.set(key, job);
  }
  while (byItem.size > BY_ITEM_LIMIT) byItem.delete(byItem.keys().next().value);
}

/** Progressive download state of an entry (in-memory; lost if the service worker restarts). */
export function directJobFor(tabId, itemId, itemKey = null, itemPath = null) {
  return (
    byItem.get(`${tabId}:id:${itemId}`) ??
    (itemKey ? byItem.get(`${tabId}:key:${itemKey}`) : null) ??
    (itemPath ? byItem.get(`${tabId}:path:${itemPath}`) : null) ??
    null
  );
}

/** Progressive downloads still running (any tab), for the toolbar indicator. */
export function activeDirectJobs() {
  return [...new Set(byItem.values())].filter((job) => !job.outcome);
}

/** Cancels a running progressive download of an entry. */
export async function cancelDirect(tabId, itemId, itemKey = null, itemPath = null) {
  const job = directJobFor(tabId, itemId, itemKey, itemPath);
  if (!job || job.outcome) return { cancelled: false };
  job.cancelRequested = true;
  if (job.downloadId != null) await chrome.downloads.cancel(job.downloadId).catch(() => {});
  return { cancelled: true };
}

function track(downloadId, job) {
  job.downloadId = downloadId;
  tracked.set(downloadId, job);
  const early = earlyFinal.get(downloadId);
  if (early) {
    earlyFinal.delete(downloadId);
    onFinalState(downloadId, early.state, early.delta);
  }
}

/** Register a callback({downloadId, state, error, entry}) for tracked downloads. */
export function onTrackedDownloadEnd(fn) {
  listeners.add(fn);
}

async function finish(job) {
  await removeRule(job.ruleId);
  if (job.blobJobId) await runOffscreenJob('release', { jobId: job.blobJobId }).catch(() => {});
}

async function startFallback(job) {
  job.mode = 'fallback';
  job.downloadId = null; // the direct attempt was erased; nothing in Chrome's list until the Blob is ready
  job.blobJobId = crypto.randomUUID();
  try {
    const { blobUrl } = await runOffscreenJob('fetch-to-blob', { jobId: job.blobJobId, url: job.url });
    if (job.cancelRequested) {
      job.outcome = { state: 'cancelled' };
      await finish(job);
      return;
    }
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: job.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    track(downloadId, job);
  } catch (error) {
    console.warn('[video-downloader] fallback download failed', job.url, error);
    job.outcome = { state: 'error', error: String(error?.message ?? error) };
    await finish(job);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (!state || state === 'in_progress') return;
  if (!tracked.has(delta.id)) {
    // Possibly ours, not yet tracked: keep it briefly.
    earlyFinal.set(delta.id, { state, delta });
    setTimeout(() => earlyFinal.delete(delta.id), 10_000);
    return;
  }
  onFinalState(delta.id, state, delta);
});

function onFinalState(downloadId, state, delta) {
  const job = tracked.get(downloadId);
  if (!job) return;
  tracked.delete(downloadId);

  chrome.downloads.search({ id: downloadId }).then(([entry]) => {
    const error = entry?.error ?? delta.error?.current;
    if (state === 'interrupted' && job.mode === 'direct' && job.ruleId != null && SERVER_ERRORS.has(error)) {
      // Hide the failed attempt from the downloads shelf and retry with headers.
      chrome.downloads.erase({ id: downloadId }).catch(() => {});
      startFallback(job);
      return;
    }
    finish(job);
    job.outcome =
      state === 'complete'
        ? { state: 'done' }
        : error === 'USER_CANCELED' || job.cancelRequested
          ? { state: 'cancelled' }
          : { state: 'error', error: error ?? t('progressInterrupted') };
    if (state === 'complete' && entry) {
      // Chrome may have uniquified the name ("(1)"); prefer the real one when
      // it still looks like a media file, otherwise the name we asked for.
      const actual = String(entry.filename ?? '')
        .split(/[\\/]/)
        .pop();
      recordDownload({
        filename: /\.[a-z0-9]{2,5}$/i.test(actual) ? actual : job.filename,
        path: entry.filename,
        url: job.sourceUrl ?? job.url,
        pageUrl: job.pageUrl ?? null,
        size: entry.fileSize ?? entry.totalBytes ?? null,
        downloadId,
        kind: job.kind ?? null,
        site: job.site ?? null,
      }).catch(() => {});
    }
    for (const fn of listeners) fn({ downloadId, state, error, job, entry });
  });
}

/**
 * Progressive file: direct download with Referer fallback.
 * @param {{tabId:number,id:string}} payload
 */
export async function downloadItem({ tabId, id }) {
  const item = await store.get(tabId, id);
  if (!item) throw new Error(t('errItemNotFoundReload'));
  if (item.kind !== KIND.VIDEO && item.kind !== KIND.AUDIO) {
    throw new Error('downloadItem is for plain video/audio files only');
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = item.pageUrl ?? tab?.url ?? null;
  const contextUrl = item.frameUrl ?? pageUrl; // the player iframe when there is one
  const ext = extensionOf(item.url) || DEFAULT_EXT[item.kind];
  const { filenameTemplate } = await getSettings();
  const quality = item.height ? `${item.height}p` : null;
  const filename = buildFilename({ pageUrl, title: item.title ?? tab?.title, ext, template: filenameTemplate, quality });

  const job = {
    url: item.url,
    pageUrl,
    contextUrl,
    filename,
    mode: 'direct',
    ruleId: null,
    blobJobId: null,
    kind: item.kind,
    site: item.site ?? null,
    tabId,
    itemId: id,
    itemKey: item.key ?? null,
    itemPath: pathOf(item.url),
    startedAt: Date.now(),
    outcome: null,
  };
  job.ruleId = await addUrlRule(item.url, contextUrl);
  remember(job);
  try {
    const downloadId = await chrome.downloads.download({ url: item.url, filename, conflictAction: 'uniquify', saveAs: false });
    track(downloadId, job);
    return { downloadId, filename, itemId: id };
  } catch (error) {
    await finish(job);
    throw error;
  }
}

/**
 * Downloads a Blob produced by the offscreen document; releases it afterwards.
 * @returns {Promise<number>} downloadId
 */
export async function downloadBlob({ blobUrl, filename, blobJobId, hlsJobId, sourceUrl = null, pageUrl = null, kind = null }) {
  const downloadId = await chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false });
  track(downloadId, { mode: 'blob', url: blobUrl, sourceUrl, pageUrl, kind, filename, ruleId: null, blobJobId, hlsJobId });
  return downloadId;
}
