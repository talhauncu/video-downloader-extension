// HLS playlist parser (RFC 8216 subset). Pure functions, no chrome.* usage.
//
// Supported: master playlists (EXT-X-STREAM-INF, EXT-X-MEDIA), media playlists
// (EXTINF, EXT-X-BYTERANGE, EXT-X-MAP, EXT-X-KEY AES-128/NONE,
// EXT-X-MEDIA-SEQUENCE, EXT-X-ENDLIST, EXT-X-TARGETDURATION,
// EXT-X-DISCONTINUITY). Relative URIs are resolved against baseUrl.

import { t } from './i18n.js';
export function isMasterPlaylist(text) {
  return /^#EXT-X-STREAM-INF/m.test(text);
}

export function isPlaylist(text) {
  return /^\s*#EXTM3U/.test(text);
}

/** Parses `KEY=VALUE,KEY="quoted, value"` attribute lists. */
export function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return attrs;
}

function resolve(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

function parseResolution(value) {
  const m = /^(\d+)x(\d+)$/.exec(value ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * @returns {{variants: Array, audio: Array, subtitles: Array}}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const variants = [];
  const audio = [];
  const subtitles = [];
  let pending = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const entry = {
        type: a.TYPE,
        groupId: a['GROUP-ID'],
        name: a.NAME ?? '',
        language: a.LANGUAGE ?? null,
        default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        forced: a.FORCED === 'YES',
        url: a.URI ? resolve(a.URI, baseUrl) : null, // null = muxed into the variant
      };
      if (a.TYPE === 'AUDIO') audio.push(entry);
      else if (a.TYPE === 'SUBTITLES') subtitles.push(entry);
    } else if (!line.startsWith('#') && pending) {
      variants.push({
        url: resolve(line, baseUrl),
        bandwidth: Number(pending.BANDWIDTH ?? pending['AVERAGE-BANDWIDTH'] ?? 0),
        resolution: parseResolution(pending.RESOLUTION),
        codecs: pending.CODECS ?? null,
        frameRate: pending['FRAME-RATE'] ? Number(pending['FRAME-RATE']) : null,
        audioGroup: pending.AUDIO ?? null,
        subtitlesGroup: pending.SUBTITLES ?? null,
      });
      pending = null;
    }
  }
  return { variants, audio, subtitles };
}

/** Video codec family of a variant from its CODECS attribute: 'h264' | 'hevc' | 'av1' | 'vp9' | null (not stated). */
export function variantVideoCodec(v) {
  const codecs = String(v?.codecs ?? '')
    .toLowerCase()
    .split(',')
    .map((c) => c.trim());
  if (codecs.some((c) => /^(avc1|avc3)/.test(c))) return 'h264';
  if (codecs.some((c) => /^(hvc1|hev1)/.test(c))) return 'hevc';
  if (codecs.some((c) => c.startsWith('av01'))) return 'av1';
  if (codecs.some((c) => /^(vp09|vp9)/.test(c))) return 'vp9';
  return null;
}

/**
 * Highest resolution first, bandwidth as tie-breaker. With preferH264,
 * variants stated as HEVC/AV1/VP9 come after the others (QuickTime on most
 * Macs cannot play AV1; some players' top variant is AV1).
 */
export function sortVariants(variants, { preferH264 = false } = {}) {
  const other = (v) => Number(preferH264 && ![null, 'h264'].includes(variantVideoCodec(v)));
  return [...variants].sort((a, b) => {
    if (other(a) !== other(b)) return other(a) - other(b);
    const ah = a.resolution?.height ?? 0;
    const bh = b.resolution?.height ?? 0;
    if (bh !== ah) return bh - ah;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  });
}

const CODEC_NAMES = { hevc: 'HEVC', av1: 'AV1', vp9: 'VP9' };

/** Human label like "1080p · 4.2 Mbps"; non-H.264 codecs are named ("800p · 1.5 Mbps · AV1"). */
export function variantLabel(v) {
  const parts = [];
  if (v.resolution) parts.push(`${v.resolution.height}p`);
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1e6).toFixed(1)} Mbps`);
  if (!parts.length) parts.push(t('variantDefault'));
  const codec = CODEC_NAMES[variantVideoCodec(v)];
  if (codec) parts.push(codec);
  return parts.join(' · ');
}

function parseByteRange(value, previousEnd) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(value ?? '');
  if (!m) return null;
  const length = Number(m[1]);
  const offset = m[2] !== undefined ? Number(m[2]) : previousEnd;
  return { length, offset };
}

/**
 * @returns {{
 *   segments: Array<{url:string, duration:number, seq:number, byteRange:{length:number,offset:number}|null, key:Object|null, map:{url:string,byteRange:Object|null}|null, discontinuity:boolean}>,
 *   live: boolean, targetDuration: number|null, mediaSequence: number, totalDuration: number,
 *   encrypted: boolean, unsupportedKey: string|null, container: 'ts'|'fmp4'|'unknown'
 * }}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const segments = [];
  let live = true;
  let targetDuration = null;
  let mediaSequence = 0;
  let key = null; // current EXT-X-KEY (null = unencrypted)
  let map = null;
  let duration = null;
  let title = null;
  let byteRange = null;
  let discontinuity = false;
  let previousEnd = 0;
  let unsupportedKey = null;

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const body = line.slice('#EXTINF:'.length);
      const comma = body.indexOf(',');
      duration = parseFloat(comma === -1 ? body : body.slice(0, comma));
      title = comma === -1 ? null : body.slice(comma + 1) || null;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), previousEnd);
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length));
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      live = false;
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuity = true;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      if (a.METHOD === 'NONE') {
        key = null;
      } else if (a.METHOD === 'AES-128') {
        key = { method: 'AES-128', url: resolve(a.URI, baseUrl), iv: a.IV ? a.IV.toLowerCase() : null };
      } else {
        unsupportedKey = a.METHOD; // SAMPLE-AES, DRM: cannot decrypt
        key = { method: a.METHOD, url: a.URI ? resolve(a.URI, baseUrl) : null, iv: null };
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      map = { url: resolve(a.URI, baseUrl), byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (!line.startsWith('#')) {
      const seq = mediaSequence + segments.length;
      segments.push({
        url: resolve(line, baseUrl),
        duration: duration ?? 0,
        title,
        seq,
        byteRange,
        key,
        map,
        discontinuity,
      });
      previousEnd = byteRange ? byteRange.offset + byteRange.length : 0;
      duration = null;
      title = null;
      byteRange = null;
      discontinuity = false;
    }
  }

  const totalDuration = segments.reduce((sum, s) => sum + (s.duration || 0), 0);
  const encrypted = segments.some((s) => s.key);
  const first = segments[0];
  /** @type {'fmp4'|'ts'|'unknown'} */
  let container = 'unknown';
  if (first) {
    const ext = (() => {
      try {
        const last = new URL(first.url).pathname.split('/').pop() ?? '';
        return last.includes('.') ? last.split('.').pop().toLowerCase() : '';
      } catch {
        return '';
      }
    })();
    if (map || ['m4s', 'mp4', 'm4v', 'm4a', 'cmfv', 'cmfa'].includes(ext)) container = 'fmp4';
    else if (ext === 'ts' || ext === 'aac' || ext === '') container = 'ts';
  }

  return { segments, live, targetDuration, mediaSequence, totalDuration, encrypted, unsupportedKey, container };
}

/**
 * HLS AES-128 default IV: media sequence number as a 16-byte big-endian int.
 * Explicit IVs are hex strings prefixed with 0x.
 * @returns {Uint8Array}
 */
export function ivForSegment(segment) {
  const iv = new Uint8Array(16);
  const hex = segment.key?.iv;
  if (hex) {
    const clean = hex.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return iv;
  }
  let n = BigInt(segment.seq);
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}
