// Maps a <video> element (as reported by the in-page badge) to the entry the
// popup would download for it. Pure: uses organize() so the badge, the popup,
// the toolbar badge and the shortcut agree.

import { KIND, groupKey, normalizeMediaUrl } from './media-url.js';
import { organize, isAd, durationsMatch, subtitleChoices, urlNamesCode } from './organize.js';
import { autoPick } from './subtitles.js';
import { pickAudio, audioLanguage, audioTrackLabel } from './audio-lang.js';
import { t } from './i18n.js';

export const BADGE_MODES = ['hover', 'always', 'off'];

/** URL path without host or query: the same stream behind rotating mirror hosts and tokens. */
export function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** True when the tab's host (or a parent domain of it) is in the list. */
export function hostDisabled(tabUrl, disabledHosts = []) {
  const host = hostOf(tabUrl);
  if (!host) return false;
  return disabledHosts.some((h) => {
    const d = String(h)
      .toLowerCase()
      .replace(/^www\./, '');
    return d && (host === d || host.endsWith(`.${d}`));
  });
}

/** Quality choices of a stream item, in the same order as the popup. */
export function streamOptions(item) {
  const info = item?.stream;
  if (!info) return { options: [], payloadKey: null };
  if (info.type === 'master') return { options: info.variants.map((v) => ({ value: v.url, label: v.label })), payloadKey: 'variantUrl' };
  if (info.type === 'dash') return { options: info.videos.map((v) => ({ value: v.id, label: v.label })), payloadKey: 'videoRepId' };
  return { options: [], payloadKey: null };
}

function notesFor(item) {
  const info = item?.stream;
  if (!info) return '';
  if (info.live) return t('noteLive');
  if (info.unsupportedKey) return t('noteEncrypted', info.unsupportedKey);
  if (info.type === 'dash' && info.drm) return t('noteDrm');
  if (info.separateAudio) return t('badgeNoteSeparateAudio');
  return '';
}

/** Length of an entry: its own, else its described stream's (Facebook manifests). */
const durationOf = (item) => item.duration ?? item.stream?.duration ?? null;

const SHAPE_TOLERANCE = 0.05;
/** True when both sizes are known and have the same aspect ratio (a stream may be scaled down). */
function sameShape(item, video) {
  if (!item.width || !item.height || !video.width || !video.height) return false;
  const a = item.width / item.height;
  const b = video.width / video.height;
  return Math.abs(a - b) / Math.max(a, b) <= SHAPE_TOLERANCE;
}

/**
 * Site players (Instagram, X, Facebook, Vimeo) stream through MSE without a playlist; their
 * complete files are the site entries. The post's shortcode, read from the
 * page around the <video>, identifies the entry exactly. Without a code a
 * single duration match is accepted, and the open page's entry when the URL
 * names it. Feeds never fall back to "the main video": that downloaded the
 * same (longest) reel for every post.
 * @returns {{card?:Object, status?:'pending', note?:string}}
 */
export function siteCardFor(cards, video, tabUrl = '') {
  const siteCards = cards.filter((c) => c.item.site);
  if (video.postCode) {
    const exact = siteCards.find((c) => c.item.code === video.postCode);
    if (exact) return { card: exact };
  }
  // An embedded player whose own frame names the video (player.vimeo.com/video/ID).
  const framed = video.frameUrl && video.frameUrl !== tabUrl ? siteCards.find((c) => urlNamesCode(video.frameUrl, c.item.code)) : null;
  if (framed) return { card: framed };
  if (video.duration) {
    const byDuration = siteCards.filter((c) => durationsMatch(durationOf(c.item), video.duration));
    if (byDuration.length === 1) return { card: byDuration[0] };
    // Same length (feeds of short clips): the frame's shape — portrait, landscape, square — may tell them apart.
    const shaped = byDuration.filter((c) => sameShape(c.item, video));
    if (shaped.length === 1) return { card: shaped[0] };
  }
  const onPage = siteCards.find((c) => urlNamesCode(tabUrl, c.item.code));
  const pageLength = onPage ? durationOf(onPage.item) : null;
  if (onPage && (!video.duration || !pageLength || durationsMatch(pageLength, video.duration))) return { card: onPage };
  // A post we can name but whose data has not arrived: wait instead of guessing.
  if (video.postCode)
    return {
      status: 'pending',
      note: t('badgePostPending'),
    };
  return {};
}

/**
 * @param {Object[]} items  tab store items
 * @param {{src:string, duration?:number|null, width?:number|null, height?:number|null, frameUrl?:string|null, postCode?:string|null}} video
 * @param {{tabUrl?:string, hideAds?:boolean, mode?:string, disabledHosts?:string[], subtitleLangs?:string[], audioLang?:string}} opts
 * @returns {{show:boolean, reason?:string, status?:'ok'|'unmatched'|'pending'|'unsupported', item?:{id:string, kind:string, key?:string|null, path?:string|null, described?:boolean}, options?:Object[], payloadKey?:string|null, note?:string, title?:string, subtitles?:string[], progress?:Object}}
 */
export function resolveVideo(
  items,
  video,
  { tabUrl = '', hideAds = true, mode = 'hover', disabledHosts = [], subtitleLangs = [], audioLang = 'default' } = {},
) {
  if (mode === 'off') return { show: false, reason: 'off' };
  if (hostDisabled(tabUrl, disabledHosts)) return { show: false, reason: 'disabled' };
  const src = video?.src ?? '';
  if (!src) return { show: false, reason: 'no-source' };

  const o = organize(items, { tabUrl, hideAds });
  const cards = [...o.recommended, ...o.others];
  let card;

  // A player stream: blob: URL, or "mse:" for one fed through srcObject (no URL to match).
  if (src.startsWith('blob:') || src === 'mse:') {
    card = cards.find((c) => c.merged.some((b) => b.url === src)) ?? null;
    if (!card && items.some((it) => it.site)) {
      const site = siteCardFor(cards, video, tabUrl);
      if (site.status === 'pending') return { show: true, status: 'pending', note: site.note };
      card = site.card;
    }
    if (!card) return { show: true, status: 'unmatched', note: t('badgeUnmatched') };
  } else {
    const normalized = normalizeMediaUrl(src);
    const item =
      // A site entry with this very file (an X GIF) knows its post's title.
      items.find((it) => it.site && (it.url === src || it.url === normalized)) ??
      items.find((it) => it.url === src || it.url === normalized) ??
      items.find(
        (it) => (it.kind === KIND.VIDEO || it.kind === KIND.AUDIO) && groupKey(it.url, it.kind) === groupKey(normalized, KIND.VIDEO),
      );
    if (!item) {
      const probe = {
        kind: KIND.VIDEO,
        url: src,
        width: video.width ?? null,
        height: video.height ?? null,
        duration: video.duration ?? null,
        frameUrl: video.frameUrl ?? null,
      };
      if (hideAds && isAd(probe)) return { show: false, reason: 'ad' };
      return { show: true, status: 'pending', note: t('badgeNotListed') };
    }
    card = cards.find((c) => c.item.id === item.id) ?? { item, merged: [], display: {} };
  }

  if (card.reason === 'ad' && hideAds) return { show: false, reason: 'ad' };
  const item = card.item;
  // Subtitles the badge takes along (preferred languages, see settings).
  const subtitles = autoPick(subtitleChoices(card), subtitleLangs).map((c) => c.label);
  // The audio track the job will take when the stream has several languages.
  const audios = item.stream?.audios ?? [];
  const audio =
    new Set(audios.map((a) => audioLanguage(a) ?? a.url ?? a.id)).size > 1 ? audioTrackLabel(pickAudio(audios, audioLang)) : null;
  const note = [
    notesFor(item),
    audio ? t('badgeNoteAudio', audio) : '',
    subtitles.length ? t('badgeNoteSubtitles', subtitles.join(', ')) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (item.stream?.live || item.stream?.unsupportedKey || (item.stream?.type === 'dash' && item.stream?.drm)) {
    return { show: true, status: 'unsupported', item: { id: item.id, kind: item.kind }, note };
  }
  const { options, payloadKey } = streamOptions(item);
  return {
    show: true,
    status: 'ok',
    item: {
      id: item.id,
      key: item.key ?? null,
      path: pathOf(item.url),
      kind: item.kind,
      described: Boolean(item.stream) || (item.kind !== KIND.HLS && item.kind !== KIND.DASH),
    },
    options,
    payloadKey,
    note,
    subtitles,
    title: item.site && item.title ? item.title : null,
  };
}
