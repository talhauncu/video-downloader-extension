// Turns the raw per-tab media list into what the user should see first.
// Pure functions (no chrome.*): used by the popup, the toolbar badge and the
// keyboard shortcut so all three agree on the "main video".
//
//  - sub-playlists listed by a described master fold under it
//  - a MediaSource player (blob:) merges with the playlist of the same frame
//  - ads (banner sizes, tiny clips, ad hosts) and neighbouring site entries
//    (Instagram reels next to the open one) go to "others"
//  - one entry is chosen as the main video
//  - subtitle files attach to the card of their player (chips in the popup);
//    subtitle playlists and WebVTT segments of a stream fold away

import { KIND, groupKey, normalizeMediaUrl } from './media-url.js';
import { languageLabel } from './subtitles.js';

/** Common IAB banner sizes (w×h); matched with a small tolerance. */
export const BANNER_SIZES = [
  [728, 90],
  [970, 90],
  [970, 250],
  [468, 60],
  [320, 50],
  [320, 100],
  [300, 250],
  [336, 280],
  [250, 250],
  [200, 200],
  [160, 600],
  [300, 600],
  [120, 600],
];

/** Hosts (suffix match) that serve ads, ad video (VAST) or ad iframes. */
export const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'imasdk.googleapis.com',
  'adnxs.com',
  'exoclick.com',
  'exosrv.com',
  'exdynsrv.com',
  'adsterra.com',
  'popads.net',
  'propellerads.com',
  'juicyads.com',
  'trafficjunky.net',
  'trafficjunky.com',
  'adform.net',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  'smartadserver.com',
  'teads.tv',
  'spotxchange.com',
  'springserve.com',
  'adcolony.com',
  'vidoomy.com',
  'aniview.com',
];

/** Score at or above which an item counts as an ad. */
export const AD_THRESHOLD = 3;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isAdHost(url) {
  const host = hostOf(url);
  return Boolean(host) && AD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function isBannerSize(w, h) {
  if (!w || !h) return false;
  return BANNER_SIZES.some(([bw, bh]) => Math.abs(w - bw) <= 4 && Math.abs(h - bh) <= 4);
}

/**
 * Ad likelihood of a progressive video/audio item. Site entries and streams
 * are never scored (0).
 *  +3 banner size · +2 extreme aspect ratio (> 4:1 or < 1:4)
 *  +1 duration < 15 s · +1 size < 1 MB · +3 ad host · +2 inside an ad iframe
 */
export function adScore(item) {
  if (!item || item.site) return 0;
  if (item.kind !== KIND.VIDEO && item.kind !== KIND.AUDIO) return 0;
  let score = 0;
  const { width: w, height: h } = item;
  if (isBannerSize(w, h)) score += 3;
  else if (w && h && (w / h > 4 || h / w > 4)) score += 2;
  if (item.duration != null && item.duration < 15) score += 1;
  if (item.size != null && item.size < 1024 * 1024) score += 1;
  if (isAdHost(item.url)) score += 3;
  if (item.frameUrl && isAdHost(item.frameUrl)) score += 2;
  return score;
}

export function isAd(item) {
  return adScore(item) >= AD_THRESHOLD;
}

function isStream(item) {
  return item.kind === KIND.HLS || item.kind === KIND.DASH;
}

function isDownloadable(item) {
  return item.kind === KIND.VIDEO || item.kind === KIND.AUDIO || isStream(item);
}

/** Frame identity without the hash; falls back to '' when unknown. */
function frameOf(item) {
  if (!item.frameUrl) return '';
  try {
    const u = new URL(item.frameUrl);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return item.frameUrl;
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Keys a child playlist is known by: groupKey (origin + path, query ignored),
 * and origin + file name when the name is a long token. Some CDNs
 * list "/mw/<token>" in the master while the player asks for "/mt/<token>":
 * the first directory rotates, the token does not.
 */
export function playlistKeys(url) {
  const keys = [groupKey(url, KIND.HLS)];
  try {
    const u = new URL(url);
    const name = u.pathname.split('/').pop();
    if (name.length >= 24) keys.push(`${u.origin}/…/${name}`);
  } catch {
    // keep the groupKey alone
  }
  return keys;
}

/**
 * Child playlist keys of every described master: variant and audio rendition
 * URLs (see playlistKeys).
 * @returns {Map<string, Object>} child key -> master item
 */
export function childMap(items) {
  const map = new Map();
  for (const item of items) {
    if (item.kind !== KIND.HLS || item.stream?.type !== 'master') continue;
    const urls = [
      ...(item.stream.variants ?? []).map((v) => v.url),
      ...(item.stream.audios ?? []).map((a) => a.url),
      ...(item.stream.subtitles ?? []).map((s) => s.ref),
    ].filter(Boolean);
    for (const url of urls) for (const key of playlistKeys(url)) map.set(key, item);
  }
  return map;
}

/**
 * The master an HLS sub-playlist belongs to, and the master's variant it is
 * (null for an audio or subtitle rendition). Null when it is not a child of
 * a described master. Used to send a download started on a sub-playlist
 * (picked before its master was described) to the whole stream.
 * @returns {{master:Object, variantUrl:string|null}|null}
 */
export function masterFor(items, item) {
  if (item?.kind !== KIND.HLS || item.stream?.type === 'master') return null;
  const keys = new Set(playlistKeys(item.url));
  const children = childMap(items);
  const master = [...keys].map((k) => children.get(k)).find(Boolean);
  if (!master || master.id === item.id) return null;
  const variant = (master.stream.variants ?? []).find((v) => v.url && playlistKeys(v.url).some((k) => keys.has(k)));
  return { master, variantUrl: variant?.url ?? null };
}

/**
 * Directories holding subtitle segments of a stream: subtitle playlists a
 * master lists, and described subtitle media playlists. A .vtt captured in
 * one of them is a segment, not a standalone file.
 * @returns {Set<string>} groupKey(..., SEGMENT) directory keys
 */
export function subtitleSegmentDirs(items) {
  const dirs = new Set();
  for (const item of items) {
    if (item.kind !== KIND.HLS || !item.stream) continue;
    if (item.stream.type === 'master') {
      for (const s of item.stream.subtitles ?? []) if (s.ref) dirs.add(groupKey(s.ref, KIND.SEGMENT));
    } else if (item.stream.subtitle && item.stream.segmentDir) {
      dirs.add(item.stream.segmentDir);
    }
  }
  return dirs;
}

/** HLS media playlist whose segments are subtitles (WebVTT). */
function isSubtitlePlaylist(item) {
  return item.kind === KIND.HLS && item.stream?.type === 'media' && Boolean(item.stream.subtitle);
}

/**
 * Subtitle choices of a card, in one shape for the popup chips, the badge
 * and the download job: stream renditions (HLS/DASH) first, then attached
 * subtitle files. A standalone subtitle card offers itself.
 * @returns {{source:'hls'|'dash'|'item', ref:string, lang:string|null, label:string, default?:boolean, forced?:boolean}[]}
 */
export function subtitleChoices(card) {
  if (!card?.item) return [];
  /** @returns {{source:'item', ref:string, lang:string|null, label:string, default:boolean, forced:boolean}} */
  const fromItem = (it) => {
    const lang = it.lang ?? it.langGuess ?? null;
    const forced = Boolean(it.subtitleInfo?.forced);
    return { source: 'item', ref: it.id, lang, label: languageLabel(lang, it.label), default: Boolean(it.default), forced };
  };
  if (card.item.kind === KIND.SUBTITLE) return [fromItem(card.item)];
  const fromStream = (card.item.stream?.subtitles ?? []).map((s) => ({ ...s }));
  return [...fromStream, ...(card.subtitles ?? []).map(fromItem)];
}

/** Duration of a stream item: its own, or the longest of its folded children (masters). */
export function streamDuration(item, children = []) {
  if (item.stream?.duration) return item.stream.duration;
  const durations = children.map((c) => c.stream?.duration).filter(Boolean);
  return durations.length ? Math.max(...durations) : null;
}

/** Durations match when within 2 % or 2 s, whichever is larger. */
export function durationsMatch(a, b) {
  if (!a || !b) return false;
  return Math.abs(a - b) <= Math.max(2, 0.02 * Math.max(a, b));
}

/**
 * Picks the playlist a blob player belongs to: same frame (else same origin),
 * then duration. With several candidates and no usable duration, no match.
 * @returns {Object|null} candidate stream item
 */
export function matchBlob(blob, streams, durationOf) {
  const sameFrame = streams.filter((s) => frameOf(s) && frameOf(s) === frameOf(blob));
  const pool = sameFrame.length
    ? sameFrame
    : streams.filter((s) => s.frameUrl && blob.frameUrl && originOf(s.frameUrl) === originOf(blob.frameUrl));
  if (!pool.length) return null;
  if (blob.duration) {
    const timed = pool.filter((s) => durationsMatch(durationOf(s), blob.duration));
    if (timed.length === 1) return timed[0];
    if (timed.length > 1) {
      return timed.sort((a, b) => Math.abs(durationOf(a) - blob.duration) - Math.abs(durationOf(b) - blob.duration))[0];
    }
    // Durations known on both sides but none matches: different videos.
    if (pool.every((s) => durationOf(s))) return null;
  }
  return pool.length === 1 ? pool[0] : null;
}

/** True when the tab's URL names the post `code`: a path segment (/reel/CODE/, /user/status/ID) or a query value (/watch/?v=ID). */
export function urlNamesCode(tabUrl, code) {
  if (!tabUrl || !code) return false;
  let u;
  try {
    u = new URL(tabUrl);
  } catch {
    return false;
  }
  return u.pathname.split('/').includes(String(code)) || [...u.searchParams.values()].includes(String(code));
}

function onPage(item, tabUrl) {
  return Boolean(item.site && urlNamesCode(tabUrl, item.code));
}

/**
 * @param {Object[]} items  per-tab store items (firstSeen order)
 * @param {{tabUrl?: string, hideAds?: boolean}} [opts]
 * @returns {{
 *   main: Object|null,          // card
 *   recommended: Object[],      // cards, main first
 *   others: Object[],           // cards: ads, neighbours, unmatched players, segments
 *   folded: Object[],           // items folded under a master or merged into a card
 *   raw: Object[],              // raw CDN chunks hidden because site entries exist (or the entry they belong to)
 *   all: Object[],              // every item, original order
 * }}
 * A card is { item, display: {width, height, duration}, merged: Object[], reason?: string }.
 */
export function organize(items, { tabUrl = '', hideAds = true } = {}) {
  const all = [...items];
  const siteItems = all.filter((it) => it.site);
  const siteKeys = new Set(siteItems.map((it) => it.key));
  const siteUrls = new Set(siteItems.map((it) => normalizeMediaUrl(it.url)));
  // Hidden: anything covered by an entry that exists (X player chunks, a
  // Facebook manifest entry once the video's MP4 is known); tagged player
  // tracks (Instagram, Facebook) when the page has site entries; captured
  // copies of a site entry's file.
  const raw = all.filter(
    (it) =>
      (it.coveredBy && it.key !== it.coveredBy && siteKeys.has(it.coveredBy)) ||
      (!it.site && ((siteItems.length && it.hidden) || (it.kind !== KIND.BLOB && siteUrls.has(normalizeMediaUrl(it.url))))),
  );
  const rawIds = new Set(raw.map((it) => it.id));

  // 1. Fold sub-playlists under their master.
  const children = childMap(all);
  const folded = [];
  const childrenOf = new Map(); // master id -> child items
  for (const item of all) {
    if (item.kind !== KIND.HLS || item.stream?.type === 'master') continue;
    const master = playlistKeys(item.url)
      .map((k) => children.get(k))
      .find(Boolean);
    if (master && master.id !== item.id) {
      folded.push(item);
      if (!childrenOf.has(master.id)) childrenOf.set(master.id, []);
      childrenOf.get(master.id).push(item);
    }
  }
  // Subtitle segments of a stream (WebVTT pieces of a subtitle playlist).
  const subDirs = subtitleSegmentDirs(all);
  for (const item of all) {
    if (item.kind === KIND.SUBTITLE && subDirs.has(groupKey(item.url, KIND.SEGMENT))) folded.push(item);
  }
  const foldedIds = new Set(folded.map((it) => it.id));

  // Site entries are not merge targets: their players are matched by post code,
  // player frame or length in badge-resolve (a same-length stream of another
  // frame would take the wrong player).
  const streams = all.filter((it) => isStream(it) && !it.site && !foldedIds.has(it.id) && !rawIds.has(it.id));
  const durationOf = (s) => streamDuration(s, childrenOf.get(s.id) ?? []);

  // 2. Merge blob players into the playlist of their frame.
  const cards = new Map(); // item id -> card
  const cardFor = (item) => {
    if (!cards.has(item.id)) {
      cards.set(item.id, {
        item,
        display: {
          width: item.width ?? null,
          height: item.height ?? null,
          duration: item.duration ?? (isStream(item) ? durationOf(item) : null),
        },
        merged: [],
        subtitles: [],
      });
    }
    return cards.get(item.id);
  };
  const unmatchedBlobs = [];
  for (const blob of all.filter((it) => it.kind === KIND.BLOB)) {
    const target = matchBlob(blob, streams, durationOf);
    if (!target) {
      unmatchedBlobs.push(blob);
      continue;
    }
    const card = cardFor(target);
    card.merged.push(blob);
    card.display.width = card.display.width ?? blob.width ?? null;
    card.display.height = card.display.height ?? blob.height ?? null;
    card.display.duration = blob.duration ?? card.display.duration;
    folded.push(blob);
  }

  // 3. Split into recommended and others.
  // A hidden entry (a manifest behind its MP4) never stands for the page.
  const pageEntry = all.find((it) => !rawIds.has(it.id) && onPage(it, tabUrl)) ?? null;
  const recommendedCards = [];
  const otherCards = [];
  for (const item of all) {
    if (rawIds.has(item.id) || foldedIds.has(item.id) || item.kind === KIND.BLOB || item.kind === KIND.SUBTITLE) continue;
    const card = cardFor(item);
    if (isSubtitlePlaylist(item)) {
      otherCards.push({ ...card, reason: 'subtitle' });
    } else if (item.kind === KIND.SEGMENT) {
      otherCards.push({ ...card, reason: 'segment' });
    } else if (hideAds && isAd(item)) {
      otherCards.push({ ...card, reason: 'ad' });
    } else if (pageEntry && item.site && item.id !== pageEntry.id) {
      otherCards.push({ ...card, reason: 'neighbour' });
    } else {
      recommendedCards.push(card);
    }
  }
  // Players without a playlist: informative when nothing else is downloadable.
  const anyDownloadable = recommendedCards.some((c) => isDownloadable(c.item));
  for (const blob of unmatchedBlobs) {
    const card = cardFor(blob);
    if (anyDownloadable) otherCards.push({ ...card, reason: 'player' });
    else recommendedCards.push(card);
  }

  // 4. Main video: the open page's site entry; else a playlist the page's
  // player is actually playing (merged blob); else the longest, then largest.
  const rank = (card) => {
    const it = card.item;
    if (pageEntry && it.id === pageEntry.id) return [2, 0, 0, 0, 0];
    const downloadable = isDownloadable(it) && !it.stream?.live && !it.stream?.drm && !it.stream?.unsupportedKey ? 1 : 0;
    const playing = card.merged.length ? 1 : 0;
    const area = (card.display.width ?? 0) * (card.display.height ?? 0);
    return [downloadable, playing, card.display.duration ?? 0, area, it.size ?? 0];
  };
  const byRank = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (rb[i] !== ra[i]) return rb[i] - ra[i];
    return 0;
  };
  recommendedCards.sort(byRank);
  const main = recommendedCards[0] ?? null;

  // 5. Subtitle files: onto the downloadable card of the same frame (main
  // first), else onto the main video; with no video they stand alone.
  const sameFrame = (a, b) => Boolean(frameOf(a)) && frameOf(a) === frameOf(b);
  const videoCards = recommendedCards.filter((c) => isDownloadable(c.item));
  const mainVideo = main && isDownloadable(main.item) ? main : null;
  for (const sub of all) {
    if (sub.kind !== KIND.SUBTITLE || foldedIds.has(sub.id) || rawIds.has(sub.id)) continue;
    const target =
      (mainVideo && sameFrame(mainVideo.item, sub) ? mainVideo : null) ?? videoCards.find((c) => sameFrame(c.item, sub)) ?? mainVideo;
    if (target) target.subtitles.push(sub);
    else otherCards.push({ ...cardFor(sub), reason: 'subtitle' });
  }

  return { main, recommended: recommendedCards, others: otherCards, folded, raw, all };
}

/** Number shown on the toolbar badge: downloadable recommended cards. */
export function badgeCount(organized) {
  return organized.recommended.filter((c) => isDownloadable(c.item)).length;
}
