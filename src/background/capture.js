// Network capture: watches every response the browser receives and files
// the ones that look like media under the tab that requested them.

import { classify, sizeFromHeaders, groupKey, KIND, MIN_FILE_BYTES, normalizeMediaUrl, cdnTrackHint } from '../lib/media-url.js';
import { worthSniffing, classifyText } from '../lib/sniff.js';
import { addJobRule, removeRule } from './header-rules.js';
import { fetchWithRetry, Throttle } from '../lib/retry.js';
import { autoDescribe } from './jobs.js';
import * as store from './store.js';
import { updateBadge } from './badge.js';
import { subtitleSegmentDirs } from '../lib/organize.js';
import { guessLanguage } from '../lib/subtitles.js';
import { siteChunkKey } from '../sites/index.js';

const pageUrlByTab = new Map();
/** `${tabId}:${frameId}` -> document URL of that frame (main frame = 0). */
const frameUrls = new Map();
/** Sniff results by URL (without query): 'hls' | 'dash' | null (not a playlist). */
const sniffCache = new Map();

function frameKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

/** URL of the frame that issued a request, falling back to its initiator origin. */
export function frameUrlFor(tabId, frameId, initiator) {
  return frameUrls.get(frameKey(tabId, frameId)) ?? (initiator && initiator !== 'null' ? `${initiator}/` : null);
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
}

/**
 * Playlists disguised as .txt (text/plain) do not classify by headers; fetch
 * the small body with the frame's headers and look at its first bytes.
 */
async function sniffPlaylist({ tabId, url, size, frameUrl, pageUrl, frameId }) {
  const key = groupKey(url, KIND.HLS);
  let found;
  if (sniffCache.has(key)) {
    found = sniffCache.get(key); // seen before (another tab or a reload): no refetch
  } else {
    if (sniffCache.size > 500) sniffCache.clear();
    sniffCache.set(key, null); // pessimistic until the body says otherwise
    const ruleId = await addJobRule(frameUrl ?? pageUrl);
    try {
      const res = await fetchWithRetry(url, {}, undefined, new Throttle({ concurrency: 1, cooldownSchedule: [5_000, 15_000] }));
      if (!res.ok) {
        sniffCache.delete(key); // transient failure: allow a later retry
        return;
      }
      found = classifyText(await res.text());
      sniffCache.set(key, found);
    } catch {
      sniffCache.delete(key);
      return;
    } finally {
      await removeRule(ruleId);
    }
  }
  if (!found) return;
  const kind = found === 'hls' ? KIND.HLS : KIND.DASH;
  try {
    const changed = await store.upsert(tabId, {
      key: groupKey(url, kind),
      url,
      kind,
      size,
      contentType: found === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml',
      sniffed: true,
      frameId,
      frameUrl,
      frameOrigin: frameUrl ? originOf(frameUrl) : null,
      pageUrl,
      source: 'network',
    });
    if (changed) {
      await updateBadge(tabId);
      autoDescribe(tabId, groupKey(url, kind), updateBadge);
    }
  } catch {
    // tab may be gone
  }
}

async function onResponse(details) {
  const { tabId, url, responseHeaders, type, statusCode, frameId, initiator } = details;
  if (tabId < 0) return; // not associated with a tab (extension, prefetch)
  if (statusCode >= 400) return;
  if (type === 'main_frame') return;

  const contentType = headerValue(responseHeaders, 'content-type');
  const frameUrl = frameUrlFor(tabId, frameId, initiator);
  const pageUrlNow = pageUrlByTab.get(tabId) ?? null;
  let kind = classify({ url, contentType });
  if (!kind) {
    const headersForSize = [...(responseHeaders ?? [])];
    if (statusCode === 206) headersForSize.push({ name: ':status', value: '206' });
    const size = sizeFromHeaders(headersForSize);
    if (worthSniffing({ url, contentType, size })) {
      sniffPlaylist({ tabId, url, size, frameUrl, pageUrl: pageUrlNow, frameId }).catch(() => {});
    }
    return;
  }

  // Instagram/Facebook: separate audio/video tracks fetched in byte ranges.
  const hint = cdnTrackHint(url);
  if (hint?.track === 'audio' && kind === KIND.VIDEO) kind = KIND.AUDIO;

  const headers = [...(responseHeaders ?? [])];
  if (statusCode === 206) headers.push({ name: ':status', value: '206' });
  const size = sizeFromHeaders(headers);

  // Skip tiny progressive files (beacons, 1-second "poster" clips) when the
  // size is known. Streams and segments are always kept.
  if ((kind === KIND.VIDEO || kind === KIND.AUDIO) && size != null && size < MIN_FILE_BYTES) return;

  // WebVTT pieces of a subtitle playlist belong to the stream, not the list
  // (a film has hundreds). Ones seen before the playlist was read are folded
  // by organize() instead.
  if (kind === KIND.SUBTITLE && subtitleSegmentDirs(await store.list(tabId)).has(groupKey(url, KIND.SEGMENT))) return;

  const changed = await store.upsert(tabId, {
    key: groupKey(url, kind),
    url: normalizeMediaUrl(url), // whole file, not one byte range of it
    kind,
    frameId,
    frameUrl,
    frameOrigin: frameUrl ? originOf(frameUrl) : null,
    trackTag: hint?.tag ?? null,
    ...(kind === KIND.SUBTITLE ? { langGuess: guessLanguage(url) } : {}),
    // Instagram/Facebook players stream separate DASH tracks; the site
    // extractor lists the complete file instead, so these are hidden.
    hidden: Boolean(hint?.tag),
    // A site extractor's chunk (X's HLS pieces): hidden once its entry exists.
    coveredBy: siteChunkKey(url),
    size,
    contentType,
    pageUrl: pageUrlByTab.get(tabId) ?? details.initiator ?? null,
    source: 'network',
  });
  if (changed) {
    await updateBadge(tabId);
    if (kind === KIND.HLS || kind === KIND.DASH || kind === KIND.SUBTITLE) autoDescribe(tabId, groupKey(url, kind), updateBadge);
  }
}

function onFrameRequest(details) {
  const { tabId, frameId, type, url } = details;
  if (tabId < 0) return;
  if (type === 'main_frame') {
    // A real navigation starts a fresh list for this tab.
    pageUrlByTab.set(tabId, url);
    for (const key of [...frameUrls.keys()]) if (key.startsWith(`${tabId}:`)) frameUrls.delete(key);
    frameUrls.set(frameKey(tabId, 0), url);
    store.clear(tabId).then(() => updateBadge(tabId));
  } else if (type === 'sub_frame') {
    frameUrls.set(frameKey(tabId, frameId), url);
  }
}

/**
 * The tab's page can change without a page request in the tab: a page restored
 * from the back/forward cache, a prerendered search result, a single-page app
 * moving to another address. Follow the tab's URL so new entries (and their
 * file names and Referer) name the page that is really open. The list is not
 * cleared here: single-page apps change the URL on every in-app navigation.
 */
function onTabUpdated(tabId, changeInfo) {
  if (!changeInfo.url) return;
  pageUrlByTab.set(tabId, changeInfo.url);
  frameUrls.set(frameKey(tabId, 0), changeInfo.url);
}

function onTabRemoved(tabId) {
  pageUrlByTab.delete(tabId);
  for (const key of [...frameUrls.keys()]) if (key.startsWith(`${tabId}:`)) frameUrls.delete(key);
  store.clear(tabId);
}

export function startCapture() {
  chrome.webRequest.onResponseStarted.addListener(onResponse, { urls: ['<all_urls>'] }, ['responseHeaders']);
  chrome.webRequest.onBeforeRequest.addListener(/** @type {any} */ (onFrameRequest), {
    urls: ['<all_urls>'],
    types: ['main_frame', 'sub_frame'],
  });
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
}

export function pageUrlOf(tabId) {
  return pageUrlByTab.get(tabId) ?? null;
}
