// Repairs for mux.js fragmented MP4 so QuickTime (AVFoundation) plays it.
// Pure (unit-tested). Measured with AVFoundation on the TS fixture:
//  - mux.js writes "unknown" (0xFFFFFFFF) durations into mvhd/tkhd/mdhd.
//    AVFoundation adds the mdhd value to the fragments' times: the film
//    starts after 13:15:21 (90 kHz) and the file looks silent and blank.
//  - every fragment's mfhd sequence number restarts at 0 and the audio and
//    video fragments of a segment share it; AVFoundation stops reading at
//    the first repeat (0 video frames, one audio fragment).
// Chrome and VLC ignore both, which is why it went unnoticed.

const UNKNOWN = 0xffffffff;

function boxes(view, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    const size = view.getUint32(o);
    const type = String.fromCharCode(view.getUint8(o + 4), view.getUint8(o + 5), view.getUint8(o + 6), view.getUint8(o + 7));
    if (size < 8 || o + size > end) break;
    out.push({ type, start: o, end: o + size });
    o += size;
  }
  return out;
}

const child = (view, box, type) => boxes(view, box.start + 8, box.end).find((b) => b.type === type) ?? null;
const children = (view, box, type) => boxes(view, box.start + 8, box.end).filter((b) => b.type === type);

/** Writes a duration field (version 0: 32 bits, version 1: 64 bits). */
function setDuration(view, box, offset0, offset1, value) {
  const v1 = view.getUint8(box.start + 8) === 1;
  if (v1) view.setBigUint64(box.start + offset1, BigInt(value));
  else view.setUint32(box.start + offset0, Math.min(value, UNKNOWN - 1));
}

/**
 * Returns the init segment with the movie and track durations set to the
 * stream's length (mvhd, tkhd in the movie timescale), media durations
 * cleared (mdhd: the samples are in the fragments) and a movie-extends
 * header (mvex/mehd) giving the fragmented length, as ffmpeg writes it.
 * Leaves anything it does not understand untouched.
 * @param {Uint8Array} init  ftyp + moov
 * @param {number} seconds  stream length (playlist total)
 * @returns {Uint8Array}
 */
export function setInitDuration(init, seconds) {
  if (!(seconds > 0)) return init;
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const moov = boxes(view, 0, init.byteLength).find((b) => b.type === 'moov');
  const mvhd = moov && child(view, moov, 'mvhd');
  if (!mvhd) return init;
  const out = new Uint8Array(init); // copy; the caller's bytes stay as they were
  const w = new DataView(out.buffer);
  const v1 = w.getUint8(mvhd.start + 8) === 1;
  const timescale = w.getUint32(mvhd.start + (v1 ? 28 : 20));
  const total = Math.round(seconds * timescale);
  setDuration(w, mvhd, 24, 32, total);
  for (const trak of children(w, moov, 'trak')) {
    const tkhd = child(w, trak, 'tkhd');
    if (tkhd) setDuration(w, tkhd, 28, 36, total);
    const mdia = child(w, trak, 'mdia');
    const mdhd = mdia && child(w, mdia, 'mdhd');
    if (mdhd) setDuration(w, mdhd, 24, 32, 0);
  }
  const mvex = child(w, moov, 'mvex');
  if (!mvex || child(w, mvex, 'mehd')) return out;
  // mehd (version 0): size, 'mehd', version+flags, fragment_duration.
  const mehd = new Uint8Array(16);
  const m = new DataView(mehd.buffer);
  m.setUint32(0, 16);
  mehd.set([0x6d, 0x65, 0x68, 0x64], 4);
  m.setUint32(12, Math.min(total, UNKNOWN - 1));
  const grown = new Uint8Array(out.length + 16);
  grown.set(out.subarray(0, mvex.start + 8));
  grown.set(mehd, mvex.start + 8);
  grown.set(out.subarray(mvex.start + 8), mvex.start + 24);
  const g = new DataView(grown.buffer);
  g.setUint32(moov.start, g.getUint32(moov.start) + 16);
  g.setUint32(mvex.start, g.getUint32(mvex.start) + 16);
  return grown;
}

/**
 * Renumbers the fragment headers (moof/mfhd) of a chunk of top-level boxes
 * in place, continuing from `next`. Returns the next number to use.
 * @param {Uint8Array} chunk  whole boxes (moof, mdat, …) as mux.js emits them
 * @param {number} next  first sequence number (1 for a new file)
 */
export function renumberFragments(chunk, next) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (const moof of boxes(view, 0, chunk.byteLength).filter((b) => b.type === 'moof')) {
    const mfhd = child(view, moof, 'mfhd');
    if (mfhd && mfhd.end - mfhd.start >= 16) view.setUint32(mfhd.start + 12, next++);
  }
  return next;
}
