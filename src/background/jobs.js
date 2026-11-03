// Stream download jobs (HLS and DASH). State lives in chrome.storage.session
// under job:<id> so the popup can render progress and the service worker can
// be restarted mid-job. A job may produce several files (video + audio).

import * as store from './store.js';
import { runOffscreenJob } from './offscreen.js';
import { addJobRule, removeRule } from './header-rules.js';
import { buildFilename, buildFolder } from '../lib/filename.js';
import { downloadBlob, onTrackedDownloadEnd } from './downloads.js';
import { KIND, groupKey, extensionOf } from '../lib/media-url.js';
import { rangePlan, sizeFromContentRange } from '../lib/file-plan.js';
import { isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist, sortVariants, variantLabel } from '../lib/m3u8.js';
import { parseMpd, tracksOf, videoLabel, audioLabel } from '../lib/mpd.js';
import { formatOf, normalizeLanguage, languageLabel, languageSuffix, describeSubtitle } from '../lib/subtitles.js';
import { subtitleSegmentDirs } from '../lib/organize.js';
import { pickAudio, audioLanguage, audioTrackLabel } from '../lib/audio-lang.js';
import { getSettings } from '../lib/settings.js';
import { pathOf } from '../lib/badge-resolve.js';
import { fetchWithRetry, Throttle, scheduleForBudget } from '../lib/retry.js';
import { t } from '../lib/i18n.js';

/** Manifest reads are interactive: short cooldowns only. */
const swThrottle = () => new Throttle({ concurrency: 1, cooldownSchedule: [5_000, 15_000] });

const PREFIX = 'job:';

/** @returns {Promise<any>} a job's stored state (see launch()), or undefined */
async function load(jobId) {
  return (await chrome.storage.session.get(PREFIX + jobId))[PREFIX + jobId] ?? null;
}

async function save(state) {
  await chrome.storage.session.set({ [PREFIX + state.jobId]: state });
}

// Progress, completion and download-end handlers run concurrently; without
// serialization two read-modify-write patches on the same job lose updates.
const queues = new Map();
function serialized(jobId, fn) {
  const prev = queues.get(jobId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    jobId,
    next.finally(() => {
      if (queues.get(jobId) === next) queues.delete(jobId);
    }),
  );
  return next;
}

function patch(jobId, changes) {
  return serialized(jobId, async () => {
    const state = await load(jobId);
    if (!state) return null;
    Object.assign(state, typeof changes === 'function' ? changes(state) : changes, { updatedAt: Date.now() });
    await save(state);
    return state;
  });
}

/** One job's public state (used by the in-page badge to show progress). */
export async function getJob(jobId) {
  const s = await load(jobId);
  if (!s) return null;
  const {
    status,
    phase,
    phaseProgress,
    done,
    total,
    bytes,
    error,
    filename,
    files,
    cooldownUntil,
    startedAt,
    itemId,
    downloadIds,
    waitedMs,
    resumedFrom,
    resumable,
  } = s;
  return {
    jobId,
    itemId,
    status,
    phase,
    phaseProgress,
    done,
    total,
    bytes,
    error,
    filename,
    files: files?.map((f) => f.filename) ?? [],
    cooldownUntil,
    startedAt,
    downloadIds: downloadIds ?? [],
    waitedMs: waitedMs ?? 0,
    resumedFrom: resumedFrom ?? null,
    resumable: Boolean(resumable),
  };
}

/** @returns {Promise<any[]>} */
export async function listJobs(tabId) {
  /** @type {Record<string, any>} */
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key, value]) => key.startsWith(PREFIX) && (tabId == null || value.tabId === tabId))
    .map(([, value]) => value)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Referer context of an item: the frame that requested it, else the page. */
export function contextUrlOf(item, fallback = null) {
  return item.frameUrl ?? item.pageUrl ?? fallback;
}

/** Fetches a manifest/playlist from the extension with the requesting frame's headers; retries once on 403/404. */
async function fetchWithPageHeaders(url, contextUrl) {
  const ruleId = await addJobRule(contextUrl);
  try {
    const res = await fetchWithRetry(url, {}, undefined, swThrottle());
    if (!res.ok) {
      const expired = res.status === 403 || res.status === 410;
      const error = /** @type {Error & {detail?: Object}} */ (
        new Error(expired ? t('errPlayerUrlExpired', res.status) : t('errManifest', res.status))
      );
      error.detail = { step: 'manifest', status: res.status, url, referer: contextUrl, expired };
      throw error;
    }
    return await res.text();
  } finally {
    await removeRule(ruleId);
  }
}

// ---- describe ------------------------------------------------------------

/** Subtitle renditions of a master playlist, in the shape organize.subtitleChoices uses. */
function hlsSubtitleChoices(subtitles) {
  const seen = new Set();
  return subtitles
    .filter((s) => s.url && !seen.has(s.url) && seen.add(s.url))
    .map((s) => {
      const lang = normalizeLanguage(s.language) ?? null;
      return { source: 'hls', ref: s.url, lang, label: languageLabel(lang, s.name), default: s.default, forced: s.forced ?? false };
    });
}

/** DASH text representations we can download as files (WebVTT, TTML, SRT). */
function dashSubtitleChoices(texts) {
  return texts
    .filter((t) => t.plan && ['vtt', 'ttml', 'srt'].includes(t.format))
    .map((t) => {
      const lang = normalizeLanguage(t.lang) ?? null;
      return { source: 'dash', ref: t.id, lang, label: languageLabel(lang, t.label), forced: t.forced, format: t.format };
    });
}

function describeHlsText(text, url, settings) {
  if (isMasterPlaylist(text)) {
    const { variants, audio, subtitles } = parseMasterPlaylist(text, url);
    const audios = audio.filter((a) => a.url);
    return {
      type: 'master',
      variants: sortVariants(variants, { preferH264: settings.preferH264 }).map((v) => ({
        url: v.url,
        label: variantLabel(v),
        height: v.resolution?.height ?? null,
        bandwidth: v.bandwidth,
        audioGroup: v.audioGroup,
      })),
      audios: audios.map((a) => ({
        url: a.url,
        groupId: a.groupId,
        label: [a.name, a.language].filter(Boolean).join(' · ') || a.groupId,
        default: a.default,
        lang: audioLanguage({ lang: a.language, name: a.name }),
        name: a.name || null,
      })),
      separateAudio: audios.length > 0,
      subtitles: hlsSubtitleChoices(subtitles),
    };
  }
  const media = parseMediaPlaylist(text, url);
  // A subtitle rendition: WebVTT (or other text) segments instead of media.
  const subtitle = media.segments.length > 0 && media.segments.every((s) => ['vtt', 'srt', 'ttml'].includes(formatOf({ url: s.url })));
  return {
    type: 'media',
    ...(subtitle ? { subtitle: true, segmentDir: groupKey(media.segments[0].url, KIND.SEGMENT) } : {}),
    live: media.live,
    duration: Math.round(media.totalDuration),
    segments: media.segments.length,
    encrypted: media.encrypted,
    unsupportedKey: media.unsupportedKey,
    container: media.container,
  };
}

function describeMpdText(text, url, settings) {
  const manifest = parseMpd(text, url);
  const { videos, audios, texts } = tracksOf(manifest, { preferH264: settings.preferH264 });
  return {
    type: 'dash',
    live: manifest.live,
    duration: manifest.duration ? Math.round(manifest.duration) : null,
    drm: manifest.drm.length > 0 || videos.some((v) => v.drm),
    videos: videos.map((v) => ({
      id: v.id,
      label: videoLabel(v),
      height: v.height,
      bandwidth: v.bandwidth,
      segments: v.plan?.segments.length ?? 0,
    })),
    audios: audios.map((a) => ({ id: a.id, label: audioLabel(a), lang: audioLanguage(a), name: a.label ?? null, bandwidth: a.bandwidth })),
    separateAudio: audios.length > 0,
    subtitles: dashSubtitleChoices(texts),
    unsupportedSubtitles: texts.filter((t) => t.format === 'mp4').length,
  };
}

const describing = new Map(); // `${tabId}:${id}` -> Promise (popup and background share one fetch)

/** Reads the manifest of an HLS/DASH item and caches a summary on the item. */
export function describe({ tabId, id }) {
  const key = `${tabId}:${id}`;
  if (!describing.has(key)) {
    describing.set(
      key,
      describeNow({ tabId, id }).finally(() => describing.delete(key)),
    );
  }
  return describing.get(key);
}

/**
 * Background describe right after capture, so sub-playlists fold and the
 * badge is right before the popup opens. Errors are ignored here; the popup
 * shows them when it describes the item itself.
 */
export async function autoDescribe(tabId, key, onDone) {
  try {
    const item = (await store.list(tabId)).find((it) => it.key === key);
    if (item?.kind === KIND.SUBTITLE) {
      if (await describeSubtitleItem(tabId, item)) await onDone?.(tabId);
      return;
    }
    if (!item || item.stream || (item.kind !== KIND.HLS && item.kind !== KIND.DASH)) return;
    await describe({ tabId, id: item.id });
    await onDone?.(tabId);
  } catch {
    // shown by the popup if it matters
  }
}

/** A subtitle playlist's pieces arrive by the dozen; reading a few files of one folder is enough. */
const SUBTITLE_DESCRIBE_DELAY_MS = 1500;
const SUBTITLE_FILES_PER_DIR = 8;

/**
 * Reads a standalone subtitle file once: its language from the words when
 * the URL and the page name none, and whether it is a dub's forced
 * (signs-only) track. Skips WebVTT segments of a stream.
 * @returns {Promise<boolean>} whether the item changed
 */
async function describeSubtitleItem(tabId, item) {
  if (item.subtitleInfo) return false;
  await new Promise((r) => setTimeout(r, SUBTITLE_DESCRIBE_DELAY_MS));
  const items = await store.list(tabId);
  const dir = groupKey(item.url, KIND.SEGMENT);
  if (subtitleSegmentDirs(items).has(dir)) return false;
  if (items.filter((it) => it.kind === KIND.SUBTITLE && groupKey(it.url, KIND.SEGMENT) === dir).length > SUBTITLE_FILES_PER_DIR)
    return false;
  const current = items.find((it) => it.id === item.id);
  if (!current || current.subtitleInfo) return false;
  const info = describeSubtitle(await fetchWithPageHeaders(item.url, contextUrlOf(item)));
  await store.update(tabId, item.id, {
    subtitleInfo: info,
    ...(current.lang || current.langGuess || !info.langGuess ? {} : { langGuess: info.langGuess }),
  });
  return true;
}

async function describeNow({ tabId, id }) {
  const item = await store.get(tabId, id);
  if (!item) throw new Error(t('errItemNotFound'));
  if (item.stream) return item.stream;
  if (item.kind !== KIND.HLS && item.kind !== KIND.DASH) throw new Error(t('errNotAStream'));

  const text = item.manifestText ?? (await fetchWithPageHeaders(item.url, contextUrlOf(item)));
  const settings = await getSettings();
  const info = item.kind === KIND.HLS ? describeHlsText(text, item.url, settings) : describeMpdText(text, item.url, settings);
  await store.update(tabId, id, { stream: info });
  return info;
}

// ---- start ---------------------------------------------------------------

/** Language and label of a chosen audio track; the label only when there were several to choose from. */
function audioMeta(track, choices) {
  return { lang: audioLanguage(track), ...(choices > 1 ? { audioLabel: audioTrackLabel(track) } : {}) };
}

/** Track of a chosen subtitle (HLS rendition or subtitle file); DASH ones come from dashTracks. */
function subtitleTrackFor(choice, items) {
  const base = { role: 'subtitle', lang: choice.lang ?? null, label: choice.label ?? null };
  if (choice.source === 'hls') return { ...base, type: 'hls-subs', url: choice.ref };
  if (choice.source === 'item') {
    const sub = items.find((it) => it.id === choice.ref);
    return sub ? { ...base, type: 'file-subs', url: sub.url } : null;
  }
  return null;
}

/**
 * The entry of a fresh master that a URL from an earlier read names: the
 * same URL, else the only one with the same file name (some CDNs rotate the
 * directory or the host between reads).
 */
function sameEntry(list, url) {
  if (!url) return null;
  const exact = list.find((x) => x.url === url);
  if (exact) return exact;
  const name = (u) => pathOf(u)?.split('/').pop() ?? null;
  const same = list.filter((x) => x.url && name(x.url) === name(url));
  return same.length === 1 ? same[0] : null;
}

async function hlsTracks(item, { variantUrl, audioUrl, subtitles = [] }) {
  const text = await fetchWithPageHeaders(item.url, contextUrlOf(item));
  const tracks = [];
  if (isMasterPlaylist(text)) {
    const { variants, audio, subtitles: subRenditions } = parseMasterPlaylist(text, item.url);
    // Chosen subtitle renditions, re-read from the fresh master (signed URLs rotate).
    for (const c of subtitles.filter((x) => x.source === 'hls')) {
      const fresh = subRenditions.find((r) => r.url === c.ref) ?? subRenditions.find((r) => r.url && pathOf(r.url) === pathOf(c.ref));
      tracks.push({ ...subtitleTrackFor(c, []), url: fresh?.url ?? c.ref });
    }
    const { preferH264, audioLang } = await getSettings();
    const sorted = sortVariants(variants, { preferH264 });
    const variant = sameEntry(sorted, variantUrl) ?? sorted[0];
    if (!variant) throw new Error(t('errMasterEmpty'));
    tracks.push({ role: 'video', type: 'hls', url: variant.url });
    const renditions = audio.filter((a) => a.url && (!variant.audioGroup || a.groupId === variant.audioGroup));
    // The popup's choice, else the language preference (dub or original).
    const rendition =
      sameEntry(renditions, audioUrl) ??
      pickAudio(
        renditions.map((a) => ({ ...a, lang: a.language })),
        audioLang,
      );
    if (rendition)
      tracks.push({
        role: 'audio',
        type: 'hls',
        url: rendition.url,
        ...audioMeta({ lang: rendition.language, name: rendition.name }, renditions.length),
      });
  } else {
    tracks.push({ role: 'video', type: 'hls', url: item.url });
  }
  return tracks;
}

async function dashTracks(item, { videoRepId, audioRepId, subtitles = [] }) {
  const text = item.manifestText ?? (await fetchWithPageHeaders(item.url, contextUrlOf(item)));
  const manifest = parseMpd(text, item.url);
  if (manifest.live) throw new Error(t('errLiveStream'));
  const { preferH264, audioLang } = await getSettings();
  const { videos, audios, texts } = tracksOf(manifest, { preferH264 });
  const video = videos.find((v) => v.id === videoRepId) ?? videos[0];
  const audio = audios.find((a) => a.id === audioRepId) ?? pickAudio(audios, audioLang);
  if (!video && !audio) throw new Error(t('errMpdNothing'));
  if (video?.drm || audio?.drm) throw new Error(t('errDrmStream'));
  const tracks = [];
  for (const c of subtitles.filter((x) => x.source === 'dash')) {
    const rep = texts.find((t) => t.id === c.ref && t.plan);
    if (rep)
      tracks.push({ role: 'subtitle', type: 'dash-subs', segments: rep.plan.segments, lang: c.lang ?? null, label: c.label ?? null });
  }
  const meta = { mpdUrl: item.url, manifestText: item.manifestText ?? null };
  if (video) {
    if (!video.plan) throw new Error(video.planError ?? t('errVideoRepresentation'));
    tracks.push({
      role: 'video',
      type: 'dash',
      init: video.plan.init,
      segments: video.plan.segments,
      ext: 'mp4',
      repId: video.id,
      ...meta,
    });
  }
  if (audio) {
    if (!audio.plan) throw new Error(audio.planError ?? t('errAudioRepresentation'));
    tracks.push({
      role: 'audio',
      type: 'dash',
      init: audio.plan.init,
      segments: audio.plan.segments,
      ext: 'm4a',
      repId: audio.id,
      ...audioMeta(audio, new Set(audios.map((a) => audioLanguage(a) ?? a.id)).size),
      ...meta,
    });
  }
  return tracks;
}

/** "1080p" style label of the chosen variant/representation, when known. */
function qualityLabel(item, { variantUrl, videoRepId }) {
  const info = item.stream;
  if (!info) return null;
  const chosen =
    info.type === 'master'
      ? (info.variants.find((v) => v.url === variantUrl) ?? info.variants[0])
      : info.type === 'dash'
        ? (info.videos.find((v) => v.id === videoRepId) ?? info.videos[0])
        : null;
  return chosen?.height ? `${chosen.height}p` : null;
}

/**
 * @param {{tabId:number, id:string, variantUrl?:string, audioUrl?:string, videoRepId?:string, audioRepId?:string,
 *   subtitles?:{source:string, ref:string, lang?:string|null, label?:string}[]}} p  subtitles: chosen subtitle choices
 */
export async function startStreamJob({ tabId, id, variantUrl, audioUrl, videoRepId, audioRepId, subtitles = [] }) {
  const item = await store.get(tabId, id);
  if (!item) throw new Error(t('errItemNotFound'));
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = item.pageUrl ?? tab?.url ?? null;
  const settings = await getSettings();
  const media =
    item.kind === KIND.DASH
      ? await dashTracks(item, { videoRepId, audioRepId, subtitles })
      : await hlsTracks(item, { variantUrl, audioUrl, subtitles });
  // Subtitle files attached to the card (page <track>s, captured .vtt files).
  const items = await store.list(tabId);
  const fileSubs = subtitles
    .filter((c) => c.source === 'item')
    .map((c) => subtitleTrackFor(c, items))
    .filter(Boolean);
  // Subtitles first: small, and their signed URLs are freshest now.
  const tracks = [...fileSubs, ...media.filter((t) => t.role === 'subtitle'), ...media.filter((t) => t.role !== 'subtitle')];
  const quality = qualityLabel(item, { variantUrl, videoRepId });
  const filename = buildFilename({
    pageUrl: tab?.url ?? pageUrl,
    title: item.title ?? tab?.title,
    ext: 'mp4',
    template: settings.filenameTemplate,
    quality,
  });
  return launch({
    tabId,
    item,
    itemId: id,
    tracks,
    pageUrl,
    siteUrl: tab?.url ?? pageUrl,
    filename,
    stem: filename.replace(/\.mp4$/, ''),
    settings,
  });
}

/**
 * Size of a plain file and whether its server serves byte ranges, asked with
 * the requesting frame's headers (a one-byte range request).
 * @returns {Promise<{size:number|null, ranges:boolean}>}
 */
async function fileSize(url, contextUrl) {
  const ruleId = await addJobRule(contextUrl);
  try {
    const res = await fetchWithRetry(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include' }, undefined, swThrottle());
    await res.body?.cancel().catch(() => {});
    if (!res.ok) {
      const error = /** @type {Error & {detail?: Object}} */ (new Error(t('errFileHttp', res.status)));
      error.detail = { step: 'file', status: res.status, url, referer: contextUrl };
      throw error;
    }
    if (res.status === 206) return { size: sizeFromContentRange(res.headers.get('content-range')), ranges: true };
    return { size: Number(res.headers.get('content-length')) || null, ranges: false };
  } finally {
    await removeRule(ruleId);
  }
}

/**
 * A plain video file downloaded by the extension instead of Chrome, so ffmpeg
 * can convert it to H.264 or embed the page's subtitles: one 'file' track
 * fetched in byte ranges (a stream job: queue, progress, resume).
 * @param {{tabId:number, id:string, subtitles?:{source:string, ref:string, lang?:string|null, label?:string}[]}} p
 */
export async function startFileJob({ tabId, id, subtitles = [] }) {
  const item = await store.get(tabId, id);
  if (!item) throw new Error(t('errItemNotFound'));
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = item.pageUrl ?? tab?.url ?? null;
  const settings = await getSettings();
  const { size, ranges } = await fileSize(item.url, contextUrlOf(item, pageUrl));
  const items = await store.list(tabId);
  const fileSubs = subtitles.map((c) => subtitleTrackFor(c, items)).filter(Boolean);
  const ext = extensionOf(item.url) || 'mp4';
  // Test hook: e2e uses small pieces (never set by the UI).
  const tracks = [
    ...fileSubs,
    {
      role: 'video',
      type: 'file',
      url: item.url,
      segments: rangePlan(item.url, ranges ? size : null, globalThis.__vdlFileChunkBytes),
      ext,
    },
  ];
  const filename = buildFilename({
    pageUrl: tab?.url ?? pageUrl,
    title: item.title ?? tab?.title,
    ext,
    template: settings.filenameTemplate,
    quality: item.height ? `${item.height}p` : null,
  });
  return launch({
    tabId,
    item,
    itemId: id,
    tracks,
    pageUrl,
    siteUrl: tab?.url ?? pageUrl,
    filename,
    stem: filename.replace(/\.[a-z0-9]+$/i, ''),
    settings,
  });
}

/**
 * Subtitles only: a standalone subtitle entry, or the subtitles of a plain
 * video file (which chrome.downloads fetches on its own).
 * @param {{tabId:number, item:Object, choices:Object[], filename?:string|null, own?:boolean}} p
 *   own: the job belongs to `item` (badge/popup progress); false for a video's side job
 */
export async function startSubtitleJob({ tabId, item, choices, filename = null, own = true }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = item.pageUrl ?? tab?.url ?? null;
  const settings = await getSettings();
  const items = await store.list(tabId);
  const tracks = choices.map((c) => subtitleTrackFor(c, items)).filter(Boolean);
  if (!tracks.length) throw new Error(t('errNoSubtitles'));
  const stem = (
    filename ??
    buildFilename({ pageUrl: tab?.url ?? pageUrl, title: item.title ?? tab?.title, ext: 'mp4', template: settings.filenameTemplate })
  ).replace(/\.[a-z0-9]+$/i, '');
  const display =
    tracks.length === 1
      ? `${stem}-${languageSuffix(tracks[0].lang)}.${settings.subtitleFormat}`
      : t('subtitleJobName', stem, tracks.length);
  return launch({
    tabId,
    item,
    itemId: own ? item.id : null,
    tracks,
    pageUrl,
    siteUrl: tab?.url ?? pageUrl,
    filename: display,
    stem,
    settings,
    kind: 'subtitle',
  });
}

/**
 * What makes a retry the same download: the entry and the tracks chosen
 * (by role, representation or URL path; signed query values change).
 */
export function resumeKeyOf(item, tracks) {
  const entry = item.key ?? pathOf(item.url) ?? item.id;
  const parts = tracks.map((t) => [t.role, t.type ?? '', t.repId ?? pathOf(t.url ?? t.mpdUrl ?? '') ?? ''].join(':'));
  return [entry, ...parts].join('|');
}

/** Stream jobs take a queue slot; subtitle jobs are small and never wait. */
const takesSlot = (job) => job.kind !== 'subtitle';
const RUN_PREFIX = 'jobrun:'; // a queued job's offscreen payload, kept apart from the state the popup reads

async function launch({ tabId, item, itemId, tracks, pageUrl, siteUrl = pageUrl, filename, stem, settings, kind = item.kind }) {
  const contextUrl = contextUrlOf(item, pageUrl);
  const resumeKey = kind === 'subtitle' ? null : resumeKeyOf(item, tracks);
  const payload = {
    tracks,
    postProcess: {
      merge: settings.mergeTracks,
      transcode: settings.transcodeToH264,
      embedSubtitles: settings.embedSubtitles,
      // Test hook: e2e picks the ffmpeg core ('single', 'mt-fail'; never set by the UI).
      ffmpegCore: globalThis.__vdlFfmpegCore ?? undefined,
    },
    concurrency: settings.concurrency,
    stripJunk: settings.stripJunk,
    subtitleFormat: settings.subtitleFormat,
    cooldownSchedule: scheduleForBudget(settings.maxCooldownMinutes),
    // Test hook: e2e shortens the late-retry delays (never set by the UI).
    fallbackDelays: globalThis.__vdlFallbackDelays ?? undefined,
  };
  const state = await exclusive(async () => {
    // "Retry" after a failure in this session: the offscreen document still
    // holds what was downloaded, the job continues from there.
    const failed = resumeKey
      ? (await listJobs(null))
          .filter((j) => j.status === 'error' && j.resumable && j.resumeKey === resumeKey)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      : null;
    const slot = !takesSlot({ kind }) || (await runningCount()) < settings.maxJobs;
    const now = Date.now();
    const next = failed
      ? {
          ...failed,
          tabId,
          itemId,
          status: slot ? 'downloading' : 'queued',
          error: null,
          lastHttp: null,
          phase: null,
          resumable: false,
          resume: true,
          notified: null,
          warning: null,
          files: [],
          downloadIds: [],
          queuedAt: now,
          updatedAt: now,
        }
      : {
          jobId: crypto.randomUUID(),
          kind,
          tabId,
          itemId,
          itemKey: itemId ? (item.key ?? null) : null, // survives page reloads (the item id does not)
          itemPath: itemId ? pathOf(item.url) : null, // survives mirror-host and token changes between page loads
          resumeKey,
          url: item.url,
          pageUrl,
          contextUrl,
          filename,
          stem,
          folder: buildFolder(settings.subfolder, { pageUrl: siteUrl }),
          tracks: tracks.length,
          subtitles: tracks.filter((t) => t.role === 'subtitle').map((t) => t.lang ?? t.label ?? '?'),
          audio: tracks.find((t) => t.role === 'audio' && t.audioLabel)?.audioLabel ?? null, // shown when there was a choice
          files: [],
          status: slot ? 'downloading' : 'queued',
          done: 0,
          total: 0,
          bytes: 0,
          ruleId: null,
          queuedAt: now,
          startedAt: now,
          updatedAt: now,
        };
    await save(next);
    if (!slot) await chrome.storage.session.set({ [RUN_PREFIX + next.jobId]: payload });
    return next;
  });
  if (state.status === 'downloading') await begin(state, payload);
  return {
    jobId: state.jobId,
    filename: state.filename,
    kind: state.kind,
    tracks: tracks.length,
    subtitles: state.subtitles.length,
    queued: state.status === 'queued',
    resumed: Boolean(state.resume),
  };
}

// Queue decisions (count, then claim) must not interleave.
/** @type {Promise<unknown>} */
let scheduling = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function exclusive(fn) {
  const next = scheduling.then(fn, fn);
  scheduling = next.catch(() => undefined);
  return next;
}

async function runningCount() {
  return (await listJobs(null)).filter((j) => j.status === 'downloading' && takesSlot(j)).length;
}

/** Starts a job that holds a slot: its header rule, then the offscreen work (a resume when it can). */
async function begin(state, payload) {
  const { jobId } = state;
  try {
    const ruleId = await addJobRule(state.contextUrl);
    await patch(jobId, { ruleId, startedAt: Date.now() });
    if (state.resume) {
      const resumed = await runOffscreenJob('stream-resume', { jobId, ...payload });
      if (resumed.resumed) {
        await patch(jobId, { done: resumed.done, total: resumed.total, resumedFrom: resumed.done });
        return;
      }
      // The offscreen document lost what it had (closed, or too long ago): from the start.
      await patch(jobId, { done: 0, total: 0, bytes: 0, resumedFrom: null, resume: false });
    }
    await runOffscreenJob('stream-download', { jobId, ...payload });
  } catch (error) {
    const s = await load(jobId);
    await removeRule(s?.ruleId);
    await patch(jobId, { status: 'error', error: error.message });
    await ended(jobId);
    throw error;
  }
}

/** Starts queued jobs while slots are free (oldest first). */
export function pumpQueue() {
  return exclusive(async () => {
    const { maxJobs } = await getSettings();
    const all = await listJobs(null);
    const free = maxJobs - all.filter((j) => j.status === 'downloading' && takesSlot(j)).length;
    const queued = all.filter((j) => j.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt);
    const starting = [];
    for (const job of queued.slice(0, Math.max(0, free))) {
      const key = RUN_PREFIX + job.jobId;
      const payload = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      if (!payload) {
        await patch(job.jobId, { status: 'error', error: t('errJobNotFound') });
        continue;
      }
      starting.push([await patch(job.jobId, { status: 'downloading' }), payload]);
    }
    return starting;
  }).then((starting) =>
    Promise.all(starting.map(([state, payload]) => begin(state, payload).catch((e) => console.warn('[video-downloader] queued job', e)))),
  );
}

// More slots in the settings: start waiting jobs now.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.maxJobs) pumpQueue().catch(() => {});
});

export async function cancelJob({ jobId }) {
  const state = await load(jobId);
  if (!state) throw new Error(t('errJobNotFound'));
  if (state.status === 'queued') {
    await chrome.storage.session.remove(RUN_PREFIX + jobId);
    const cancelled = await patch(jobId, (s) => (s.status === 'queued' ? { status: 'cancelled', error: t('cancelled') } : {}));
    if (cancelled?.status === 'cancelled') return { cancelled: true };
    return cancelJob({ jobId }); // started meanwhile
  }
  if (state.status !== 'downloading') return { cancelled: false, status: state.status };
  await runOffscreenJob('cancel', { jobId });
  return { cancelled: true };
}

export async function clearFinishedJobs(tabId) {
  const jobs = (await listJobs(tabId)).filter((j) => !['downloading', 'saving', 'queued'].includes(j.status));
  if (!jobs.length) return;
  await chrome.storage.session.remove(jobs.map((j) => PREFIX + j.jobId));
  // What a failed job kept for a retry goes with it.
  for (const j of jobs.filter((j) => j.resumable)) await runOffscreenJob('release', { jobId: j.jobId }).catch(() => {});
}

// ---- end of a job: next in the queue, notification -----------------------

/** A job left its slot (saving, done, failed, cancelled): start the next one, tell the user. */
async function ended(jobId) {
  pumpQueue().catch((e) => console.warn('[video-downloader] queue', e));
  const s = await load(jobId);
  if (s && (s.status === 'done' || s.status === 'error')) await notifyEnd(s).catch(() => {});
}

const NOTIFICATION_PREFIX = 'vdl-job:';
const NOTIFICATION_ICON = 'src/icons/notification.png';

async function notifyEnd(job) {
  // A video's side job (its subtitles) is not a download of its own.
  if (job.itemId == null || job.notified === job.status) return;
  const { notify } = await getSettings();
  if (!notify) return;
  await patch(job.jobId, { notified: job.status });
  const done = job.status === 'done';
  const name = job.files?.length ? job.files.map((f) => f.filename).join(' + ') : job.filename;
  /** @type {chrome.notifications.NotificationCreateOptions} */
  const options = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title: done ? t('notifyDoneTitle') : t('notifyErrorTitle'),
    message: done ? name : `${name}\n${job.error ?? t('jobStateError')}`,
    contextMessage: done ? t('notifyDoneHint') : job.resumable ? t('jobResumable') : '',
    priority: 0,
  };
  globalThis.__vdlNotifications?.push({ id: NOTIFICATION_PREFIX + job.jobId, ...options }); // test hook
  await chrome.notifications.create(NOTIFICATION_PREFIX + job.jobId, options);
}

// Clicking a "done" notification shows the file in its folder.
chrome.notifications?.onClicked.addListener(async (id) => {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return;
  chrome.notifications.clear(id).catch(() => {});
  const job = await load(id.slice(NOTIFICATION_PREFIX.length));
  const downloadId = job?.status === 'done' ? job.downloadIds?.[0] : null;
  if (downloadId == null) return;
  const [entry] = await chrome.downloads.search({ id: downloadId });
  if (entry?.exists) chrome.downloads.show(downloadId);
});

// ---- messages from the offscreen document -------------------------------

export async function onProgress({ jobId, done, total, bytes, track, tracks, retries, cooldowns, refreshes, spacingMs, mirrorSwitches }) {
  await patch(jobId, (s) =>
    s.status === 'downloading'
      ? {
          done,
          total,
          bytes,
          track,
          tracks,
          retries: retries ?? s.retries ?? 0,
          cooldowns: cooldowns ?? s.cooldowns ?? 0,
          refreshes: refreshes ?? s.refreshes ?? 0,
          spacingMs: spacingMs ?? s.spacingMs ?? 0,
          mirrorSwitches: mirrorSwitches ?? s.mirrorSwitches ?? 0,
          ...(s.phase === 'cooldown' ? { phase: null } : {}),
        }
      : {},
  );
}

/** Final file names: "<stem>.mp4", "-video/-ses" when media is split, "-<lang>.srt" for subtitles. */
export function fileNameFor(stem, files, file) {
  if (file.role === 'subtitle') {
    const suffix = languageSuffix(file.lang);
    const same = files.filter((f) => f.role === 'subtitle' && languageSuffix(f.lang) === suffix);
    const n = same.indexOf(file);
    return `${stem}-${suffix}${n > 0 ? `-${n + 1}` : ''}.${file.ext}`;
  }
  const media = files.filter((f) => f.role !== 'subtitle');
  const suffix = media.length > 1 ? `-${file.role === 'audio' ? t('fileSuffixAudio') : t('fileSuffixVideo')}` : '';
  return `${stem}${suffix}.${file.ext}`;
}

function joinWarning(previous, next) {
  return previous ? `${previous} · ${next}` : next;
}

/** Offscreen phase updates (merging/transcoding progress, merge failure). */
export async function onPhase({ jobId, phase, progress, error }) {
  await patch(jobId, (s) => {
    if (s.status !== 'downloading') return {};
    if (phase === 'merging') return { phase: 'merging', phaseProgress: progress ?? 0 };
    if (phase === 'cooldown')
      return {
        phase: 'cooldown',
        cooldownUntil: arguments[0].until ?? null,
        cooldownStatus: arguments[0].status ?? null,
        cooldownIndex: arguments[0].cooldown ?? null,
        cooldownOf: arguments[0].of ?? null,
      };
    if (phase === 'merge-failed') return { phase: null, warning: joinWarning(s.warning, t('warnMergeFailed', error)) };
    if (phase === 'subtitle-failed')
      return { warning: joinWarning(s.warning, t('warnSubtitleFailed', arguments[0].label ? ` (${arguments[0].label})` : '', error)) };
    return {};
  });
}

async function finalize(jobId) {
  const state = await load(jobId);
  if (!state) return;
  await removeRule(state.ruleId);
  await runOffscreenJob('release', { jobId }).catch(() => {});
}

export async function onComplete({ jobId, files, duration }) {
  const state = await load(jobId);
  if (!state || state.status !== 'downloading') return;
  const stem = state.stem ?? state.filename.replace(/\.mp4$/, '');
  const named = files.map((f) => ({ ...f, filename: fileNameFor(stem, files, f) }));
  await patch(jobId, {
    status: 'saving',
    phase: null,
    files: named.map(
      ({
        role,
        ext,
        size,
        filename,
        remuxed,
        transcoded,
        codecs,
        ffmpeg,
        junkBytes,
        retries,
        cooldowns,
        refreshes,
        spacingMs,
        mirrorSwitches,
        lang,
        label,
        embeddedSubtitles,
      }) => ({
        role,
        ext,
        size,
        filename,
        remuxed,
        transcoded,
        codecs,
        ...(ffmpeg ? { ffmpeg } : {}),
        junkBytes: junkBytes ?? 0,
        retries: retries ?? 0,
        cooldowns: cooldowns ?? 0,
        refreshes: refreshes ?? 0,
        spacingMs: spacingMs ?? 0,
        mirrorSwitches: mirrorSwitches ?? 0,
        ...(role === 'subtitle' ? { lang: lang ?? null, label: label ?? null } : {}),
        ...(embeddedSubtitles?.length ? { embeddedSubtitles } : {}),
      }),
    ),
    mirrorSwitches: files.reduce((s, f) => s + (f.mirrorSwitches ?? 0), 0),
    retries: files.reduce((s, f) => s + (f.retries ?? 0), 0),
    cooldowns: files.reduce((s, f) => s + (f.cooldowns ?? 0), 0),
    refreshes: files.reduce((s, f) => s + (f.refreshes ?? 0), 0),
    bytes: named.reduce((s, f) => s + f.size, 0),
    duration,
    pending: named.length,
    failed: 0,
  });
  ended(jobId);
  for (const f of named) {
    try {
      const downloadId = await downloadBlob({
        blobUrl: f.blobUrl,
        filename: f.filename,
        folder: state.folder ?? '',
        blobJobId: null,
        hlsJobId: jobId,
        sourceUrl: state.url,
        pageUrl: state.pageUrl ?? null,
        kind: state.kind,
      });
      await patch(jobId, (s) => ({ downloadIds: [...(s.downloadIds ?? []), downloadId] }));
    } catch (error) {
      await patch(jobId, (s) => ({ pending: (s.pending ?? 1) - 1, failed: (s.failed ?? 0) + 1, error: error.message }));
    }
  }
  const s = await load(jobId);
  if (s && s.pending === 0) {
    await finalize(jobId);
    await patch(jobId, { status: s.failed ? 'error' : 'done' });
    await ended(jobId);
  }
}

/** @param {{jobId:string, cancelled:boolean, error:string, detail?:Object|null, resumable?:boolean}} p
 *   resumable: the offscreen document kept what was downloaded; downloading the same again continues it */
export async function onError({ jobId, cancelled, error, detail, resumable = false }) {
  const state = await load(jobId);
  if (!state) return;
  await removeRule(state.ruleId);
  await patch(jobId, (s) => ({
    status: cancelled ? 'cancelled' : 'error',
    error,
    resumable: !cancelled && Boolean(resumable),
    phase: null,
    lastHttp: detail ? { ...detail, referer: state.contextUrl ?? null } : null,
    refreshes: detail?.refreshes ?? s.refreshes ?? 0,
  }));
  await ended(jobId);
}

onTrackedDownloadEnd(async ({ state, error, job }) => {
  if (!job?.hlsJobId) return;
  const jobId = job.hlsJobId;
  const updated = await patch(jobId, (s) => ({
    pending: (s.pending ?? 1) - 1,
    failed: (s.failed ?? 0) + (state === 'complete' ? 0 : 1),
    ...(state !== 'complete' ? { error: error ?? t('progressInterrupted') } : {}),
  }));
  if (!updated) return;
  if (updated.pending <= 0 && updated.status === 'saving') {
    await finalize(jobId);
    await patch(jobId, { status: updated.failed ? 'error' : 'done' });
    await ended(jobId);
  }
});
