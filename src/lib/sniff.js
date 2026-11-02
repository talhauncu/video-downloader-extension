// Content-based helpers for disguised media: playlists served as .txt, and
// segments with junk bytes in front (some hosts prepend garbage so that the
// files do not look like video).

/** Classifies a text body as 'hls' | 'dash' | null. */
export function classifyText(text) {
  if (typeof text !== 'string') return null;
  const head = text
    .slice(0, 4096)
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (/^#EXTM3U/.test(head)) return 'hls';
  if (/^<\?xml[^>]*>\s*<MPD\b/i.test(head) || /^<MPD\b/i.test(head)) return 'dash';
  return null;
}

/**
 * URL/content-type pairs worth a sniff: text/plain or octet-stream bodies
 * whose name hints at a playlist (or that hide behind .txt).
 */
const NAME_HINT = /(m3u8|master|playlist|chunklist|sublist|manifest|index|prog_index|\.mpd)/i;
export function worthSniffing({ url, contentType, size }) {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!['text/plain', 'application/octet-stream', 'binary/octet-stream', 'text/html', ''].includes(type)) return false;
  if (size != null && size > 512 * 1024) return false;
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').pop() ?? '';
    return /\.txt$/i.test(last) || NAME_HINT.test(last);
  } catch {
    return false;
  }
}

const TS_PACKET = 188;
const KNOWN_BOXES = new Set(['ftyp', 'styp', 'moov', 'moof', 'mdat', 'sidx', 'free', 'skip', 'emsg', 'prft', 'uuid']);

/** First offset of three consecutive TS sync bytes, or -1. */
export function tsSyncOffset(bytes, limit = 4096) {
  const max = Math.min(limit, bytes.length - 2 * TS_PACKET - 1);
  for (let i = 0; i <= max; i++) {
    if (bytes[i] === 0x47 && bytes[i + TS_PACKET] === 0x47 && bytes[i + 2 * TS_PACKET] === 0x47) return i;
  }
  return -1;
}

/** First offset that looks like an ISO BMFF box header with a known type, or -1. */
export function mp4BoxOffset(bytes, limit = 4096) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const max = Math.min(limit, bytes.length - 8);
  for (let i = 0; i <= max; i++) {
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (!KNOWN_BOXES.has(type)) continue;
    const size = view.getUint32(i);
    if (size === 1 || (size >= 8 && size <= bytes.length - i)) return i;
  }
  return -1;
}

/**
 * Drops leading junk from a media segment. Returns the same array when
 * nothing has to be removed.
 * @param {Uint8Array} bytes
 * @param {'ts'|'fmp4'|'unknown'} container
 */
export function trimJunk(bytes, container) {
  if (!bytes || bytes.length < 16) return bytes;
  if (container === 'ts' || container === 'unknown') {
    const o = tsSyncOffset(bytes);
    if (o > 0) return bytes.subarray(o);
    if (o === 0) return bytes;
  }
  if (container === 'fmp4' || container === 'unknown') {
    const o = mp4BoxOffset(bytes);
    if (o > 0) return bytes.subarray(o);
  }
  return bytes;
}
