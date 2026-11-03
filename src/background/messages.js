// Message router shared by popup, content scripts and the offscreen document.
// Each handler receives (payload, sender) and returns a value or a promise.

import * as store from './store.js';
import { updateBadge } from './badge.js';
import { startDownload } from './start.js';
import * as jobs from './jobs.js';
import { groupKey, KIND } from '../lib/media-url.js';
import { pageUrlOf } from './capture.js';
import { addJobRule, removeRule } from './header-rules.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { listHistory, clearHistory } from './history.js';
import { downloadBest } from './quick.js';
import { ensureInjected, probeTab } from './sites.js';
import { siteById } from '../sites/index.js';
import { redactDeep } from '../lib/redact.js';
import { resolveVideo, pathOf } from '../lib/badge-resolve.js';
import { streamProgress, fileProgress, isActive } from '../lib/progress.js';
import { directJobFor, cancelDirect } from './downloads.js';
import { normalizeLanguage, guessLanguage } from '../lib/subtitles.js';
import { t, effectiveLanguage, loadMessages } from '../lib/i18n.js';

const handlers = {
  ping: async () => ({ pong: true, time: Date.now() }),

  // Texts for places without chrome.i18n or with a chosen language: the offscreen document, content scripts.
  'i18n:get': async () => {
    const lang = effectiveLanguage((await getSettings()).uiLanguage);
    return { lang, messages: await loadMessages(lang) };
  },

  'media:list': async ({ tabId }) => {
    // Popup opened: make sure site extractors run in this tab (no-op elsewhere)
    // and tell the popup what state the extractor is in.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    /** @type {any} */
    const site = tab?.url ? await ensureInjected(tabId, tab.url).catch(() => ({ applicable: false })) : { applicable: false };
    // Jobs of this tab, plus running (or just finished) ones of other tabs:
    // downloads continue after their tab was closed or navigated away.
    // Other tabs: running jobs, and for 15 s after they end (so a cancel or
    // finish is seen), not their whole history (that is the Geçmiş panel).
    const recent = Date.now() - 15_000;
    const others = (await jobs.listJobs(null))
      .filter((j) => j.tabId !== tabId && (['queued', 'downloading', 'saving'].includes(j.status) || (j.updatedAt ?? 0) > recent))
      .map((j) => ({
        ...j,
        otherTab: true,
        otherSite: (() => {
          try {
            return new URL(j.pageUrl ?? j.url).hostname.replace(/^www\./, '');
          } catch {
            return '';
          }
        })(),
      }));
    return {
      tabId,
      items: await store.list(tabId),
      jobs: [...(await jobs.listJobs(tabId)), ...others],
      site: {
        applicable: Boolean(site.applicable),
        hooked: Boolean(site.probe?.hooked),
        injectedNow: Boolean(site.injected),
        found: site.probe?.stats?.found ?? 0,
        label: site.site ? (siteById(site.site)?.label ?? null) : null,
      },
    };
  },

  'media:clear': async ({ tabId }) => {
    await store.clear(tabId);
    await jobs.clearFinishedJobs(tabId);
    await updateBadge(tabId);
    return { tabId };
  },

  'media:download': async ({ tabId, id, variantUrl, audioUrl, videoRepId, audioRepId, subtitles }) =>
    startDownload({ tabId, id, variantUrl, audioUrl, videoRepId, audioRepId, subtitles }),

  // ---- in-page download badge (content script, any frame) ----
  'badge:resolve': async (video, sender) => {
    const tabId = sender?.tab?.id;
    if (tabId == null || tabId < 0) return { show: false, reason: 'no-tab' };
    const settings = await getSettings();
    const opts = {
      tabUrl: sender.tab.url ?? '',
      hideAds: settings.hideAds,
      mode: settings.badgeMode,
      disabledHosts: settings.badgeDisabledHosts,
      subtitleLangs: settings.subtitleLangs,
      audioLang: settings.audioLang,
    };
    const input = { ...video, frameUrl: video?.frameUrl ?? sender.url ?? null };
    /** @type {any} */
    let result = resolveVideo(await store.list(tabId), input, opts);
    if (result.status === 'ok' && !result.item.described) {
      try {
        await jobs.describe({ tabId, id: result.item.id });
      } catch (error) {
        return { show: true, status: 'unsupported', note: error.message, mode: settings.badgeMode };
      }
      result = resolveVideo(await store.list(tabId), input, opts);
    }
    // A download of this entry still running (e.g. after a page reload): let the badge pick it up.
    if (result.item?.id) {
      const progress = await progressFor(tabId, result.item.id, null, result.item.key, result.item.path);
      if (isActive(progress)) result.progress = progress;
    }
    return { ...result, mode: settings.badgeMode };
  },

  'badge:download': async ({ id, variantUrl, videoRepId }, sender) => {
    const tabId = sender?.tab?.id;
    if (tabId == null || tabId < 0) throw new Error(t('errTabNotFound'));
    const result = await handlers['media:download']({
      tabId,
      id,
      variantUrl,
      audioUrl: undefined,
      videoRepId,
      audioRepId: undefined,
      subtitles: 'auto',
    });
    // The download may have gone to the master of the clicked sub-playlist: the badge follows that entry.
    const itemId = result.itemId ?? id;
    const item = itemId === id ? null : await store.get(tabId, itemId);
    return { ...result, itemId, ...(item ? { itemKey: item.key ?? null, itemPath: pathOf(item.url) } : {}) };
  },

  // One shape for stream jobs and progressive files (see lib/progress.js).
  'badge:progress': async ({ itemId, itemKey = null, itemPath = null, downloadId }, sender) => {
    const tabId = sender?.tab?.id;
    if (tabId == null || tabId < 0) return null;
    return progressFor(tabId, itemId, downloadId, itemKey, itemPath);
  },

  'badge:cancel': async ({ itemId, itemKey = null, itemPath = null }, sender) => {
    const tabId = sender?.tab?.id;
    if (tabId == null || tabId < 0) throw new Error(t('errTabNotFound'));
    const running = (await jobs.listJobs(tabId)).filter(
      (j) =>
        (j.itemId === itemId || (itemKey && j.itemKey === itemKey) || (itemPath && j.itemPath === itemPath)) &&
        (j.status === 'downloading' || j.status === 'queued'),
    );
    if (running.length) {
      for (const j of running) await jobs.cancelJob({ jobId: j.jobId });
      return { cancelled: true, type: 'stream' };
    }
    return { ...(await cancelDirect(tabId, itemId, itemKey, itemPath)), type: 'file' };
  },

  'badge:show': async ({ downloadId }) => {
    const [entry] = await chrome.downloads.search({ id: downloadId });
    if (!entry || !entry.exists) throw new Error(t('errFileGone'));
    globalThis.__vdlLastShown = downloadId; // test hook
    chrome.downloads.show(downloadId);
    return { shown: true };
  },

  'badge:job': async ({ jobId }) => jobs.getJob(jobId),

  'media:describe': async ({ tabId, id }) => {
    const info = await jobs.describe({ tabId, id });
    await updateBadge(tabId);
    return info;
  },
  'media:cancel': async ({ jobId }) => jobs.cancelJob({ jobId }),

  // Offscreen document → service worker.
  'job:progress': async (payload) => jobs.onProgress(payload),
  'job:complete': async (payload) => jobs.onComplete(payload),
  'job:error': async (payload) => jobs.onError(payload),
  'job:phase': async (payload) => jobs.onPhase(payload),

  'settings:get': async () => getSettings(),
  'settings:set': async (patch) => setSettings(patch),

  'history:list': async () => listHistory(),
  'history:clear': async () => {
    await clearHistory();
    return { cleared: true };
  },
  'history:show': async ({ downloadId }) => {
    const [entry] = await chrome.downloads.search({ id: downloadId });
    if (!entry || !entry.exists) throw new Error(t('errFileGone'));
    chrome.downloads.show(downloadId);
    return { shown: true };
  },

  'quick:download-best': async ({ tabId }) => downloadBest(tabId),

  // Everything a bug report needs, without cookies, tokens or query values
  // (URLs are masked, redact.js) and without the page title.
  'debug:info': async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const items = (await store.list(tabId)).map(
      ({
        url,
        kind,
        size,
        width,
        height,
        duration,
        source,
        site,
        hidden,
        coveredBy,
        trackTag,
        stream,
        manifestText,
        frameId,
        frameUrl,
        sniffed,
        lang,
        langGuess,
        label,
      }) => ({
        url,
        kind,
        size,
        width,
        height,
        duration,
        source,
        site,
        hidden,
        coveredBy,
        trackTag,
        stream,
        manifestLength: manifestText?.length ?? null,
        frameId,
        frameUrl,
        sniffed: sniffed ?? false,
        ...(kind === KIND.SUBTITLE ? { lang: lang ?? null, langGuess: langGuess ?? null, label: label ?? null } : {}),
      }),
    );
    const registered = await chrome.scripting.getRegisteredContentScripts().catch((e) => String(e));
    const siteStats = (await chrome.storage.session.get(`stats:${tabId}`))[`stats:${tabId}`] ?? null;
    return redactDeep({
      extension: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      time: new Date().toISOString(),
      tabUrl: tab?.url ?? null,
      settings: await getSettings(),
      siteScripts: Array.isArray(registered) ? registered.map((r) => ({ id: r.id, matches: r.matches, world: r.world })) : registered,
      siteStats,
      mainWorldProbe: await probeTab(tabId),
      items,
      jobs: (await jobs.listJobs(tabId)).map(
        ({
          jobId,
          kind,
          status,
          phase,
          done,
          total,
          bytes,
          error,
          warning,
          files,
          filename,
          contextUrl,
          lastHttp,
          retries,
          cooldowns,
          refreshes,
          spacingMs,
          mirrorSwitches,
          subtitles,
          audio,
        }) => ({
          jobId,
          kind,
          status,
          phase,
          done,
          total,
          bytes,
          error,
          warning,
          files,
          filename,
          contextUrl,
          lastHttp,
          retries,
          cooldowns,
          refreshes,
          spacingMs,
          mirrorSwitches,
          subtitles,
          audio,
        }),
      ),
    });
  },

  // Site extractor diagnostics (shown in debug info).
  'site:stats': async ({ site, stats }, sender) => {
    const tabId = sender?.tab?.id;
    if (tabId == null || tabId < 0) return { stored: false };
    await chrome.storage.session.set({ [`stats:${tabId}`]: { site, ...stats, at: Date.now() } });
    return { stored: true };
  },

  // Site extractor report (main-world hook): complete files the network capture cannot see.
  'site:media': async ({ site: siteId, items = [], pageUrl }, sender) => {
    const tabId = sender?.tab?.id;
    const site = siteById(siteId);
    if (tabId == null || tabId < 0 || !site) return { accepted: 0 };
    // The reporting tab's own URL: the recorded page can lag behind (back/forward cache, prerender).
    const page = sender.tab.url ?? pageUrlOf(tabId) ?? pageUrl ?? null;
    let changed = false;
    // A report from an embedded player (an iframe): its entries are fetched in that frame's context.
    const frameUrl = site.fetchContext === 'frame' && sender.frameId ? (sender.url ?? null) : null;
    for (const { entry, sizeFrom, describe } of site.toItems({ items }, { pageUrl: page })) {
      if (frameUrl && !entry.frameUrl) entry.frameUrl = frameUrl;
      const result = await store.upsert(tabId, entry);
      changed = changed || result;
      if (!result) continue;
      if (describe) jobs.autoDescribe(tabId, entry.key, updateBadge);
      if (sizeFrom) {
        const context = site.fetchContext === 'frame' ? (sender.url ?? page) : page;
        fillSize(tabId, entry.key, sizeFrom, context).catch((e) => console.warn('[video-downloader] size lookup failed', e));
      }
    }
    if (changed) await updateBadge(tabId);
    return { accepted: items.length };
  },

  // Content script report: media elements found in one frame of a tab.
  'dom:media': async ({ items = [], page = /** @type {any} */ ({}) }, sender) => {
    const tabId = sender?.tab?.id;
    if (tabId == null || tabId < 0) return { accepted: 0 };
    const pageUrl = sender.tab.url ?? pageUrlOf(tabId) ?? page.url ?? null;
    let changed = false;
    for (const item of items) {
      if (!item?.url || !item.kind) continue;
      const key = item.kind === KIND.BLOB ? item.url : groupKey(item.url, item.kind);
      const result = await store.upsert(tabId, {
        key,
        url: item.url,
        kind: item.kind,
        size: null,
        contentType: null,
        width: item.width ?? null,
        height: item.height ?? null,
        duration: item.duration ?? null,
        title: page.isTop ? page.title || null : null,
        pageUrl,
        frameUrl: page.url ?? sender.url ?? null,
        source: 'dom',
        ...(item.kind === KIND.SUBTITLE
          ? {
              lang: normalizeLanguage(item.lang),
              label: item.label || null,
              default: Boolean(item.default),
              langGuess: guessLanguage(item.url),
            }
          : {}),
      });
      changed = changed || result;
      if (result && item.kind === KIND.SUBTITLE) jobs.autoDescribe(tabId, key, updateBadge);
    }
    if (changed) await updateBadge(tabId);
    return { accepted: items.length };
  },
};

/** Latest download of a page entry (stream job or progressive file), normalised. */
async function progressFor(tabId, itemId, downloadId = null, itemKey = null, itemPath = null) {
  const mine = (j) => j.itemId === itemId || (itemKey && j.itemKey === itemKey) || (itemPath && j.itemPath === itemPath);
  const streamJob = (await jobs.listJobs(tabId)).filter(mine).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  const direct = directJobFor(tabId, itemId, itemKey, itemPath);
  if (streamJob && (!direct || streamJob.startedAt >= direct.startedAt)) return streamProgress(await jobs.getJob(streamJob.jobId));
  const id = direct?.downloadId ?? downloadId;
  const [entry] = id != null ? await chrome.downloads.search({ id }) : [];
  const progress = fileProgress(entry ?? null, direct);
  return progress ? { ...progress, itemId } : null;
}

/** HEAD request (with the page's headers) to learn the file size. */
async function fillSize(tabId, key, url, pageUrl) {
  const ruleId = await addJobRule(pageUrl);
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'include' });
    const length = Number(res.headers.get('content-length'));
    if (res.ok && length > 0) {
      const items = await store.list(tabId);
      const item = items.find((it) => it.key === key);
      if (item) await store.update(tabId, item.id, { size: length });
    }
  } finally {
    await removeRule(ruleId);
  }
}

export async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') {
    throw new Error('Invalid message');
  }
  const handler = handlers[message.type];
  if (!handler) throw new Error(`Unknown message type: ${message.type}`);
  return handler(message.payload ?? {}, sender);
}
