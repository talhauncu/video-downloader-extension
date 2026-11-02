// One entry point for "download this entry", shared by the popup, the
// in-page badge and the keyboard shortcut: picks the subtitles that go with
// it and starts the right kind of job.

import * as store from './store.js';
import * as jobs from './jobs.js';
import { downloadItem } from './downloads.js';
import { KIND } from '../lib/media-url.js';
import { organize, subtitleChoices, masterFor } from '../lib/organize.js';
import { autoPick } from '../lib/subtitles.js';
import { getSettings } from '../lib/settings.js';
import { t } from '../lib/i18n.js';

/**
 * Subtitle choices to download.
 * @param {Object[]} choices  subtitleChoices(card)
 * @param {'auto'|{source:string, ref:string}[]|undefined} selection
 *   'auto' (badge, shortcut): the preferred languages; an array (popup): exactly those
 * @param {string[]} prefs  settings.subtitleLangs
 */
export function pickSubtitles(choices, selection, prefs) {
  if (selection == null || selection === 'auto') return autoPick(choices, prefs);
  if (!Array.isArray(selection)) return [];
  return choices.filter((c) => selection.some((s) => s?.source === c.source && s?.ref === c.ref));
}

/** Longest wait for the tab's playlists to be described before a download starts. */
export const SETTLE_TIMEOUT_MS = 10_000;

/**
 * Waits (up to SETTLE_TIMEOUT_MS) until every HLS/DASH entry of the tab is
 * described. Until a master is, its video playlist looks like a film of its
 * own and its WebVTT segments like subtitle files; a download started then
 * lost the audio and embedded one segment. Shares the background describe.
 */
async function settle(tabId) {
  const pending = (await store.list(tabId)).filter((it) => (it.kind === KIND.HLS || it.kind === KIND.DASH) && !it.stream);
  if (!pending.length) return;
  let timer;
  await Promise.race([
    Promise.allSettled(pending.map((it) => jobs.describe({ tabId, id: it.id }))),
    new Promise((resolve) => (timer = setTimeout(resolve, SETTLE_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
}

/** The organize() card of an entry (subtitles attached to it), or a bare one. */
async function cardOf(tabId, id, settings) {
  const [items, tab] = await Promise.all([store.list(tabId), chrome.tabs.get(tabId).catch(() => null)]);
  const o = organize(items, { tabUrl: tab?.url ?? '', hideAds: settings.hideAds });
  const item = items.find((it) => it.id === id) ?? null;
  return [...o.recommended, ...o.others].find((c) => c.item.id === id) ?? (item ? { item, merged: [], subtitles: [] } : null);
}

/**
 * @param {{tabId:number, id:string, variantUrl?:string, audioUrl?:string, videoRepId?:string, audioRepId?:string, subtitles?:'auto'|Object[]}} p
 */
export async function startDownload({ tabId, id, subtitles = 'auto', ...quality }) {
  const first = await store.get(tabId, id);
  if (!first) throw new Error(t('errItemNotFoundReload'));
  // Stream subtitles are listed by describe(); masters fold their sub-playlists and subtitle segments.
  await settle(tabId);
  // A sub-playlist picked before its master was described: download the whole stream.
  const parent = masterFor(await store.list(tabId), first);
  if (parent) {
    id = parent.master.id;
    quality = { ...quality, variantUrl: quality.variantUrl ?? parent.variantUrl ?? undefined };
  }
  const settings = await getSettings();
  const card = await cardOf(tabId, id, settings);
  const { item } = card;

  // A subtitle on its own: download it whatever its language.
  if (item.kind === KIND.SUBTITLE) return jobs.startSubtitleJob({ tabId, item, choices: subtitleChoices(card) });
  if (item.kind === KIND.HLS && item.stream?.subtitle) {
    return jobs.startSubtitleJob({ tabId, item, choices: [{ source: 'hls', ref: item.url, lang: null, label: t('subtitleGeneric') }] });
  }

  // Chips chosen on the sub-playlist's card may be gone (segments now folded): fall back to the preferences.
  let picked = pickSubtitles(subtitleChoices(card), subtitles, settings.subtitleLangs);
  if (parent && !picked.length) picked = pickSubtitles(subtitleChoices(card), 'auto', settings.subtitleLangs);
  if (item.kind === KIND.HLS || item.kind === KIND.DASH) {
    const result = await jobs.startStreamJob({ tabId, id, ...quality, subtitles: picked });
    return parent ? { ...result, itemId: id, redirectedFrom: first.id } : result;
  }
  if (item.kind === KIND.VIDEO || item.kind === KIND.AUDIO) {
    const result = await downloadItem({ tabId, id });
    if (!picked.length) return result;
    // chrome.downloads fetches the file itself; its subtitles come as a side job.
    try {
      const side = await jobs.startSubtitleJob({ tabId, item, choices: picked, filename: result.filename, own: false });
      return { ...result, subtitleJobId: side.jobId, subtitles: side.subtitles };
    } catch (error) {
      return { ...result, subtitleError: error.message };
    }
  }
  throw new Error(t('errCannotDownloadKind'));
}
