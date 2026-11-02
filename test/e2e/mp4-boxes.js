// Minimal MP4 box walker for assertions on downloaded files.
export function topLevelBoxes(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= view.byteLength) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...buffer.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = view.byteLength - offset;
    }
    if (size < header) break;
    boxes.push({ type, size, offset });
    offset += size;
  }
  return boxes;
}

/** Walks nested boxes under `moov` and returns child box types (e.g. trak count) and codec sample entries. */
export function moovSummary(buffer) {
  const boxes = topLevelBoxes(buffer);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return { traks: 0, codecs: [], languages: [], duration: null, mediaDurations: [], fragmentDuration: null };
  const children = (offset, end) => {
    const out = [];
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let o = offset;
    while (o + 8 <= end) {
      let size = view.getUint32(o);
      const type = String.fromCharCode(...buffer.subarray(o + 4, o + 8));
      let header = 8;
      if (size === 1) {
        size = Number(view.getBigUint64(o + 8));
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header) break;
      out.push({ type, offset: o, end: o + size, header });
      o += size;
    }
    return out;
  };
  const moovChildren = children(moov.offset + 8, moov.offset + moov.size);
  const traks = moovChildren.filter((c) => c.type === 'trak');
  const codecs = [];
  const languages = [];
  const mediaDurations = []; // mdhd, in each track's timescale
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // mvhd: movie duration in seconds.
  let duration = null;
  const mvhd = moovChildren.find((c) => c.type === 'mvhd');
  if (mvhd) {
    const p = mvhd.offset + mvhd.header;
    const v1 = buffer[p] === 1;
    const timescale = view.getUint32(p + (v1 ? 20 : 12));
    const d = v1 ? Number(view.getBigUint64(p + 24)) : view.getUint32(p + 16);
    duration = timescale ? d / timescale : null;
  }
  for (const trak of traks) {
    // trak > mdia > mdhd: packed ISO 639-2 language
    const mdia = children(trak.offset + trak.header, trak.end).find((c) => c.type === 'mdia');
    const mdhd = mdia && children(mdia.offset + mdia.header, mdia.end).find((c) => c.type === 'mdhd');
    if (mdhd) {
      const p = mdhd.offset + mdhd.header;
      mediaDurations.push(buffer[p] === 1 ? Number(view.getBigUint64(p + 24)) : view.getUint32(p + 16));
      const packed = view.getUint16(p + (buffer[p] === 1 ? 32 : 20));
      languages.push(String.fromCharCode(((packed >> 10) & 31) + 0x60, ((packed >> 5) & 31) + 0x60, (packed & 31) + 0x60));
    }
    // trak > mdia > minf > stbl > stsd > [entries]
    let node = trak;
    for (const name of ['mdia', 'minf', 'stbl', 'stsd']) {
      node = children(node.offset + node.header, node.end).find((c) => c.type === name);
      if (!node) break;
    }
    if (node) {
      // stsd: version/flags (4) + entry count (4), then sample entries
      const entries = children(node.offset + 16, node.end);
      if (entries[0]) codecs.push(entries[0].type);
    }
  }
  // mvex/mehd: length of the fragmented movie, in the movie timescale.
  const mvex = moovChildren.find((c) => c.type === 'mvex');
  const mehd = mvex && children(mvex.offset + mvex.header, mvex.end).find((c) => c.type === 'mehd');
  let fragmentDuration = null;
  if (mehd && mvhd) {
    const p = mehd.offset + mehd.header;
    const p0 = mvhd.offset + mvhd.header;
    const timescale = view.getUint32(p0 + (buffer[p0] === 1 ? 20 : 12));
    fragmentDuration = (buffer[p] === 1 ? Number(view.getBigUint64(p + 4)) : view.getUint32(p + 4)) / timescale;
  }
  return { traks: traks.length, codecs, languages, duration, mediaDurations, fragmentDuration };
}

/** Sequence numbers of every fragment header (moof/mfhd), in file order. */
export function fragmentSequences(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return topLevelBoxes(buffer)
    .filter((b) => b.type === 'moof')
    .map((moof) => {
      const type = String.fromCharCode(...buffer.subarray(moof.offset + 12, moof.offset + 16));
      return type === 'mfhd' ? view.getUint32(moof.offset + 20) : null;
    });
}
