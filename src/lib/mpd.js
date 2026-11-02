// MPEG-DASH MPD parser. Resolves each Representation into a concrete list
// of fetchable segments. Pure functions; XML via ../lib/xml.js.
//
// Supported: static MPDs, multiple Periods (first one used for downloads),
// BaseURL at every level, SegmentTemplate ($RepresentationID$, $Bandwidth$,
// $Number$, $Time$, %0Nd formatting) with or without SegmentTimeline,
// SegmentList (Initialization + SegmentURL with mediaRange), SegmentBase
// (single file, e.g. Reddit), inheritance from AdaptationSet to
// Representation, ContentProtection detection (DRM → not downloadable).

import { parseXml, childrenOf, childOf, textOf } from './xml.js';
import { t } from './i18n.js';

/** ISO 8601 duration ("PT1H2M3.5S") → seconds. */
export function parseDuration(text) {
  if (!text) return null;
  const m =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      text.trim(),
    );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map((v) => (v === undefined ? 0 : Number(v)));
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + s;
}

function resolveUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** Applies the first <BaseURL> child of `node` to `base`. */
function baseFor(node, base) {
  const b = childOf(node, 'BaseURL');
  return b ? resolveUrl(textOf(b), base) : base;
}

function parseRange(text) {
  const m = /^(\d+)-(\d+)$/.exec(text ?? '');
  return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : null;
}

/** Fills $RepresentationID$, $Bandwidth$, $Number$, $Time$ (with %0Nd). */
export function fillTemplate(template, values) {
  return template
    .replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (_, key, pad) => {
      const v = values[key];
      if (v === undefined || v === null) return '';
      return pad ? String(v).padStart(Number(pad), '0') : String(v);
    })
    .replace(/\$\$/g, '$');
}

/** Merges SegmentTemplate/SegmentList/SegmentBase attributes from parent to child. */
function mergedSegmentInfo(parentNode, childNode, name) {
  const a = parentNode && childOf(parentNode, name);
  const b = childNode && childOf(childNode, name);
  if (!a && !b) return null;
  const attrs = { ...(a?.attrs ?? {}), ...(b?.attrs ?? {}) };
  const timeline = (b && childOf(b, 'SegmentTimeline')) ?? (a && childOf(a, 'SegmentTimeline')) ?? null;
  const init = (b && childOf(b, 'Initialization')) ?? (a && childOf(a, 'Initialization')) ?? null;
  const segmentUrls = b ? childrenOf(b, 'SegmentURL') : a ? childrenOf(a, 'SegmentURL') : [];
  return { attrs, timeline, init, segmentUrls };
}

function timelineEntries(timeline) {
  const out = [];
  let time = 0;
  for (const s of childrenOf(timeline, 'S')) {
    const d = Number(s.attrs.d);
    if (s.attrs.t !== undefined) time = Number(s.attrs.t);
    const r = s.attrs.r !== undefined ? Number(s.attrs.r) : 0;
    const repeat = r < 0 ? 0 : r; // negative r (until period end) not supported → single
    for (let k = 0; k <= repeat; k++) {
      out.push({ time, duration: d });
      time += d;
    }
  }
  return out;
}

/**
 * Builds the segment plan for one representation.
 * @returns {{init:{url:string,byteRange:Object|null}|null, segments:Array<{url:string,byteRange:Object|null}>, mode:'template'|'list'|'base'}}
 */
function planSegments({ adaptationSet, representation, base, periodDuration, repId, bandwidth }) {
  const values = { RepresentationID: repId, Bandwidth: bandwidth };

  const tpl = mergedSegmentInfo(adaptationSet, representation, 'SegmentTemplate');
  if (tpl && (tpl.attrs.media || tpl.attrs.initialization)) {
    const timescale = Number(tpl.attrs.timescale ?? 1);
    const startNumber = Number(tpl.attrs.startNumber ?? 1);
    const init = tpl.attrs.initialization
      ? { url: resolveUrl(fillTemplate(tpl.attrs.initialization, values), base), byteRange: null }
      : null;
    const segments = [];
    if (tpl.timeline) {
      let number = startNumber;
      for (const entry of timelineEntries(tpl.timeline)) {
        segments.push({
          url: resolveUrl(fillTemplate(tpl.attrs.media, { ...values, Number: number, Time: entry.time }), base),
          byteRange: null,
        });
        number++;
      }
    } else {
      const segDuration = Number(tpl.attrs.duration);
      if (!segDuration || !periodDuration) throw new Error('SegmentTemplate without timeline needs duration and period length');
      const count = Math.ceil(periodDuration / (segDuration / timescale));
      for (let k = 0; k < count; k++) {
        const number = startNumber + k;
        segments.push({
          url: resolveUrl(fillTemplate(tpl.attrs.media, { ...values, Number: number, Time: k * segDuration }), base),
          byteRange: null,
        });
      }
    }
    return { init, segments, mode: 'template' };
  }

  const list = mergedSegmentInfo(adaptationSet, representation, 'SegmentList');
  if (list && list.segmentUrls.length) {
    const init = list.init
      ? { url: resolveUrl(list.init.attrs.sourceURL ?? '', base), byteRange: parseRange(list.init.attrs.range) }
      : null;
    const segments = list.segmentUrls.map((s) => ({
      url: resolveUrl(s.attrs.media ?? '', base),
      byteRange: parseRange(s.attrs.mediaRange),
    }));
    return { init, segments, mode: 'list' };
  }

  // SegmentBase (or nothing): the BaseURL is the whole file.
  return { init: null, segments: [{ url: base, byteRange: null }], mode: 'base' };
}

function contentTypeOf(adaptationSet, representation) {
  const mime = representation.attrs.mimeType ?? adaptationSet.attrs.mimeType ?? '';
  const ct = adaptationSet.attrs.contentType ?? (mime.split('/')[0] || '');
  if (ct === 'video' || ct === 'audio' || ct === 'text') return ct;
  // Subtitles: TTML/WebVTT files or ISO-BMFF wrapped text (stpp/wvtt).
  const codecs = representation.attrs.codecs ?? adaptationSet.attrs.codecs ?? '';
  if (/ttml|vtt/i.test(mime) || /^(stpp|wvtt)/i.test(codecs)) return 'text';
  if (representation.attrs.width || adaptationSet.attrs.width || adaptationSet.attrs.maxWidth) return 'video';
  if (
    representation.attrs.audioSamplingRate ||
    adaptationSet.attrs.audioSamplingRate ||
    childOf(adaptationSet, 'AudioChannelConfiguration')
  )
    return 'audio';
  return 'unknown';
}

/**
 * @param {string} text  MPD XML
 * @param {string} mpdUrl
 */
export function parseMpd(text, mpdUrl) {
  const mpd = parseXml(text);
  if (mpd.name !== 'MPD') throw new Error(t('errMpdRoot'));
  const type = mpd.attrs.type === 'dynamic' ? 'dynamic' : 'static';
  const duration = parseDuration(mpd.attrs.mediaPresentationDuration);
  const mpdBase = baseFor(mpd, mpdUrl);
  const periods = childrenOf(mpd, 'Period');
  if (!periods.length) throw new Error(t('errMpdNoPeriod'));

  const period = periods[0];
  const periodDuration = parseDuration(period.attrs.duration) ?? duration;
  const periodBase = baseFor(period, mpdBase);
  const drm = [];

  const adaptationSets = childrenOf(period, 'AdaptationSet').map((as) => {
    const asBase = baseFor(as, periodBase);
    if (childOf(as, 'ContentProtection')) drm.push(as.attrs.contentType ?? as.attrs.mimeType ?? 'unknown');
    const representations = childrenOf(as, 'Representation').map((rep) => {
      const repBase = baseFor(rep, asBase);
      const repId = rep.attrs.id ?? '';
      const bandwidth = Number(rep.attrs.bandwidth ?? 0);
      let plan = null;
      let planError = null;
      try {
        plan = planSegments({ adaptationSet: as, representation: rep, base: repBase, periodDuration, repId, bandwidth });
      } catch (error) {
        planError = error.message;
      }
      return {
        id: repId,
        bandwidth,
        width: Number(rep.attrs.width ?? as.attrs.width ?? 0) || null,
        height: Number(rep.attrs.height ?? as.attrs.height ?? 0) || null,
        codecs: rep.attrs.codecs ?? as.attrs.codecs ?? null,
        mimeType: rep.attrs.mimeType ?? as.attrs.mimeType ?? null,
        frameRate: rep.attrs.frameRate ?? as.attrs.frameRate ?? null,
        audioSamplingRate: Number(rep.attrs.audioSamplingRate ?? as.attrs.audioSamplingRate ?? 0) || null,
        contentType: contentTypeOf(as, rep),
        drm: Boolean(childOf(as, 'ContentProtection') || childOf(rep, 'ContentProtection')),
        plan,
        planError,
      };
    });
    return {
      id: as.attrs.id ?? null,
      contentType: representations[0]?.contentType ?? contentTypeOf(as, { attrs: {} }),
      lang: as.attrs.lang ?? null,
      label: as.attrs.label ?? textOf(childOf(as, 'Label')) ?? null,
      roles: childrenOf(as, 'Role')
        .map((r) => r.attrs.value)
        .filter(Boolean),
      mimeType: as.attrs.mimeType ?? null,
      representations,
    };
  });

  return { type, live: type === 'dynamic', duration, periodCount: periods.length, adaptationSets, drm };
}

export function isH264(rep) {
  return /^(avc|h264)/i.test(rep.codecs ?? '');
}

/**
 * Flattened video/audio representation lists, best first. With preferH264
 * (default) H.264 representations come before VP9/AV1 ones of any size, since
 * QuickTime and most players handle them without transcoding.
 */
export function tracksOf(manifest, { preferH264 = true } = {}) {
  const videos = [];
  const audios = [];
  const texts = [];
  for (const as of manifest.adaptationSets) {
    for (const rep of as.representations) {
      const entry = { ...rep, lang: as.lang };
      if (rep.contentType === 'video') videos.push(entry);
      else if (rep.contentType === 'audio') audios.push({ ...entry, label: as.label || null });
      else if (rep.contentType === 'text')
        texts.push({
          ...entry,
          label: as.label || null,
          forced: as.roles?.includes('forced-subtitle') ?? false,
          format: textFormatOf(rep),
        });
    }
  }
  videos.sort(
    (a, b) => (preferH264 ? Number(isH264(b)) - Number(isH264(a)) : 0) || (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth,
  );
  audios.sort((a, b) => b.bandwidth - a.bandwidth);
  return { videos, audios, texts };
}

/**
 * Subtitle representation format: 'vtt' | 'ttml' (downloadable as text),
 * 'mp4' (stpp/wvtt inside ISO-BMFF: not supported), null when unknown.
 */
export function textFormatOf(rep) {
  const mime = (rep.mimeType ?? '').toLowerCase();
  if (/^(stpp|wvtt)/i.test(rep.codecs ?? '') || mime === 'application/mp4') return 'mp4';
  if (mime.includes('vtt')) return 'vtt';
  if (mime.includes('ttml')) return 'ttml';
  const url = rep.plan?.segments?.[0]?.url ?? '';
  if (/\.(vtt|webvtt)(\?|$)/i.test(url)) return 'vtt';
  if (/\.(ttml|dfxp|xml)(\?|$)/i.test(url)) return 'ttml';
  if (/\.srt(\?|$)/i.test(url)) return 'srt';
  return null;
}

export function videoLabel(rep) {
  const parts = [];
  if (rep.height) parts.push(`${rep.height}p`);
  if (rep.bandwidth) parts.push(`${(rep.bandwidth / 1e6).toFixed(1)} Mbps`);
  if (rep.codecs) parts.push(rep.codecs.split('.')[0]);
  return parts.join(' · ') || rep.id;
}

export function audioLabel(rep) {
  const parts = [];
  if (rep.lang) parts.push(rep.lang);
  if (rep.bandwidth) parts.push(`${Math.round(rep.bandwidth / 1000)} kbps`);
  return parts.join(' · ') || rep.id;
}
