// Pure helpers that decide whether a network response is media worth
// listing, and what kind. No chrome.* usage so they are unit-testable.

export const KIND = {
  VIDEO: 'video', // progressive file: mp4, webm, mov, ...
  AUDIO: 'audio', // progressive audio: mp3, m4a, ...
  HLS: 'hls', // .m3u8 playlist
  DASH: 'dash', // .mpd manifest
  SEGMENT: 'segment', // .ts / .m4s chunk of a stream
  BLOB: 'blob', // blob: URL fed by MediaSource; bytes arrive as HLS/DASH segments
  SUBTITLE: 'subtitle', // standalone subtitle file: .vtt, .srt, .ttml
};

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv', 'flv', 'avi', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4v-segment', 'cmfv', 'cmfa']);

const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const DASH_TYPES = ['application/dash+xml'];
const SEGMENT_TYPES = ['video/mp2t', 'video/iso.segment'];
const SUBTITLE_TYPES = ['text/vtt', 'application/x-subrip', 'text/srt', 'application/ttml+xml', 'application/ttaf+xml'];
const SUBTITLE_EXT = new Set(['vtt', 'webvtt', 'srt', 'ttml', 'dfxp']);

/** Minimum size for a progressive file to be listed (filters tracking pixels, tiny blips). */
export const MIN_FILE_BYTES = 10 * 1024;

export function extensionOf(url) {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Classifies a response. Returns null when it is not media.
 * @param {{url: string, contentType?: string|null}} input
 */
export function classify({ url, contentType }) {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const ext = extensionOf(url);

  if (HLS_TYPES.includes(type) || ext === 'm3u8') return KIND.HLS;
  if (DASH_TYPES.includes(type) || ext === 'mpd') return KIND.DASH;
  if (SEGMENT_TYPES.includes(type) || SEGMENT_EXT.has(ext)) return KIND.SEGMENT;
  if (SUBTITLE_TYPES.includes(type)) return KIND.SUBTITLE;
  if (SUBTITLE_EXT.has(ext) && !type.includes('html') && !type.includes('json') && !type.startsWith('video/') && !type.startsWith('audio/'))
    return KIND.SUBTITLE;

  // Some CDNs serve segments as video/mp4 with ranges or numbered names;
  // treat "video/mp4" + .m4s already handled, otherwise it's progressive.
  if (type.startsWith('video/')) return KIND.VIDEO;
  if (type.startsWith('audio/')) return KIND.AUDIO;
  if (type === 'application/octet-stream' || type === '' || type === 'binary/octet-stream') {
    if (VIDEO_EXT.has(ext)) return KIND.VIDEO;
    if (AUDIO_EXT.has(ext)) return KIND.AUDIO;
  }
  if (VIDEO_EXT.has(ext) && !type.startsWith('text/') && !type.includes('json') && !type.includes('html')) {
    return KIND.VIDEO;
  }
  return null;
}

/**
 * Total size from headers: Content-Range wins ("bytes 0-99/12345"),
 * otherwise Content-Length. Returns null when unknown.
 */
export function sizeFromHeaders(headers) {
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;
  const range = get('content-range');
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) return Number(m[1]);
  }
  const length = get('content-length');
  const status = get(':status');
  // A partial response's Content-Length is only the chunk; without
  // Content-Range we cannot know the total.
  if (length != null && status !== '206') return Number(length);
  return null;
}

/**
 * Query parameters that only select a byte range of a larger file. Dropping
 * them turns a chunk URL into the whole-file URL (Instagram/Facebook CDNs:
 * bytestart/byteend).
 */
const RANGE_PARAMS = ['bytestart', 'byteend'];

/** Removes range-selecting query parameters; returns the URL unchanged otherwise. */
export function normalizeMediaUrl(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const p of RANGE_PARAMS) {
      if (u.searchParams.has(p)) {
        u.searchParams.delete(p);
        changed = true;
      }
    }
    return changed ? u.href : url;
  } catch {
    return url;
  }
}

/**
 * Instagram/Facebook CDN URLs carry an `efg` parameter: base64 JSON whose
 * vencode_tag says whether the file is a DASH audio or video track.
 * @returns {{track:'audio'|'video'|null, tag:string|null}|null}
 */
export function cdnTrackHint(url) {
  try {
    const u = new URL(url);
    const efg = u.searchParams.get('efg');
    const isMetaCdn = /(cdninstagram\.com|fbcdn\.net)$/.test(u.hostname);
    if (!isMetaCdn && !efg) return null;
    if (!efg) return { track: null, tag: null };
    const json = JSON.parse(atob(efg.replace(/-/g, '+').replace(/_/g, '/')));
    const tag = String(json.vencode_tag ?? '');
    const track = /audio/i.test(tag) ? 'audio' : /video|vp9|avc|hevc|dash|progressive/i.test(tag) ? 'video' : null;
    return { track, tag: tag || null };
  } catch {
    return null;
  }
}

/**
 * Codec family from a CDN encode tag such as "dash_r2gen2hq_ln_avc_v1",
 * "dash_vp9-basic-gen2_q80", "dash_ln_heaac_vbr3_audio".
 * @returns {'AVC'|'VP9'|'AV1'|'HEVC'|'AAC'|null}
 */
export function codecHint(tag) {
  if (!tag) return null;
  const t = tag.toLowerCase();
  if (/vp9|vp09/.test(t)) return 'VP9';
  if (/av1|av01/.test(t)) return 'AV1';
  if (/hevc|h265|hvc1/.test(t)) return 'HEVC';
  if (/avc|h264|x264/.test(t)) return 'AVC';
  if (/aac|heaac|mp4a/.test(t)) return 'AAC';
  return null;
}

/** Codecs QuickTime / macOS Preview cannot play from an MP4. */
export const QUICKTIME_UNSUPPORTED = new Set(['VP9', 'AV1']);

/**
 * Key used to collapse many requests for the same media into one entry.
 * - Progressive files: URL without query (Range requests repeat the URL;
 *   signed query strings may rotate).
 * - Segments: their parent directory, so a stream is one entry.
 */
export function groupKey(url, kind) {
  try {
    const u = new URL(url);
    if (kind === KIND.SEGMENT) {
      const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
      return `${u.origin}${dir}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Human-readable size, Turkish separators are not needed for units. */
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
