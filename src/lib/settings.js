// User settings in chrome.storage.sync with defaults. Read by the service
// worker; edited on the options page.

import { DEFAULT_TEMPLATE, normalizeFolderTemplate } from './filename.js';
import { normalizeLanguage } from './subtitles.js';

/** @type {Readonly<Record<string, any>>} */
export const DEFAULTS = Object.freeze({
  mergeTracks: true, // ffmpeg.wasm: video + audio → one MP4 (remux only)
  transcodeToH264: false, // ffmpeg.wasm: re-encode VP9/AV1 video to H.264 for QuickTime (slow)
  preferH264: true, // DASH: pick H.264 representations before VP9/AV1 ones
  stripJunk: true, // drop junk bytes some hosts prepend to segments
  maxCooldownMinutes: 10, // total time a job may spend in rate-limit cooldowns (0 = none, max 120)
  hideAds: true, // popup: fold likely ads into "Other"
  badgeMode: 'hover', // in-page download badge: 'hover' | 'always' | 'off'
  badgeDisabledHosts: [], // sites (host or parent domain) where the badge is hidden
  concurrency: 4, // parallel segment fetches (1-8)
  filenameTemplate: DEFAULT_TEMPLATE,
  historyLimit: 50,
  subtitleLangs: ['tr'], // subtitles taken automatically (badge, shortcut, popup preselection); '*' = all
  subtitleFormat: 'srt', // 'srt' | 'vtt'
  embedSubtitles: false, // ffmpeg.wasm: put the chosen subtitles into the MP4 (mov_text) instead of separate files
  audioLang: 'default', // separate audio tracks: 'default' (the site's) | 'original' (not the dub) | language code
  uiLanguage: 'auto', // interface language: 'auto' (Chrome's) | 'en' | 'tr'
  maxJobs: 2, // stream jobs (HLS/DASH) downloading at once (1-4); the rest wait in the queue
  notify: true, // system notification when a stream job ends (done or failed)
  subfolder: '', // folder inside Downloads, a template with {site} {date} ('' = Downloads itself)
});

export function normalizeSettings(input) {
  const out = { ...DEFAULTS };
  if (typeof input.mergeTracks === 'boolean') out.mergeTracks = input.mergeTracks;
  if (typeof input.transcodeToH264 === 'boolean') out.transcodeToH264 = input.transcodeToH264;
  if (typeof input.preferH264 === 'boolean') out.preferH264 = input.preferH264;
  if (typeof input.stripJunk === 'boolean') out.stripJunk = input.stripJunk;
  if (typeof input.hideAds === 'boolean') out.hideAds = input.hideAds;
  if (['hover', 'always', 'off'].includes(input.badgeMode)) out.badgeMode = input.badgeMode;
  const hosts = Array.isArray(input.badgeDisabledHosts)
    ? input.badgeDisabledHosts
    : typeof input.badgeDisabledHosts === 'string'
      ? input.badgeDisabledHosts.split(/[\s,]+/)
      : null;
  if (hosts) {
    out.badgeDisabledHosts = [
      ...new Set(
        hosts
          .map((h) =>
            String(h)
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\//, '')
              .replace(/\/.*$/, '')
              .replace(/:\d+$/, '')
              .replace(/^www\./, ''),
          )
          .filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h) && (h.includes('.') || h === 'localhost')),
      ),
    ].slice(0, 200);
  }
  const cd = Number(input.maxCooldownMinutes);
  if (Number.isFinite(cd) && cd >= 0 && cd <= 120) out.maxCooldownMinutes = Math.round(cd);
  const c = Number(input.concurrency);
  if (Number.isInteger(c) && c >= 1 && c <= 8) out.concurrency = c;
  if (typeof input.filenameTemplate === 'string' && input.filenameTemplate.trim()) out.filenameTemplate = input.filenameTemplate.trim();
  const langs = Array.isArray(input.subtitleLangs)
    ? input.subtitleLangs
    : typeof input.subtitleLangs === 'string'
      ? input.subtitleLangs.split(/[\s,;]+/)
      : null;
  if (langs) {
    out.subtitleLangs = [...new Set(langs.map((l) => (String(l).trim() === '*' ? '*' : normalizeLanguage(l))).filter(Boolean))].slice(
      0,
      20,
    );
  }
  if (['srt', 'vtt'].includes(input.subtitleFormat)) out.subtitleFormat = input.subtitleFormat;
  if (typeof input.embedSubtitles === 'boolean') out.embedSubtitles = input.embedSubtitles;
  if (['default', 'original'].includes(input.audioLang)) out.audioLang = input.audioLang;
  else if (normalizeLanguage(input.audioLang)) out.audioLang = normalizeLanguage(input.audioLang);
  if (['auto', 'en', 'tr'].includes(input.uiLanguage)) out.uiLanguage = input.uiLanguage;
  const m = Number(input.maxJobs);
  if (Number.isInteger(m) && m >= 1 && m <= 4) out.maxJobs = m;
  if (typeof input.notify === 'boolean') out.notify = input.notify;
  if (typeof input.subfolder === 'string') out.subfolder = normalizeFolderTemplate(input.subfolder);
  const h = Number(input.historyLimit);
  if (Number.isInteger(h) && h >= 0 && h <= 500) out.historyLimit = h;
  return out;
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS)).catch(() => ({}));
  return normalizeSettings({ ...DEFAULTS, ...stored });
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.sync.set(next);
  return next;
}
