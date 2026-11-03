// A plain file downloaded by the extension itself (to transcode it or embed
// subtitles) is fetched like a DASH SegmentBase track: as byte ranges, so it
// gets the stream jobs' progress, retries, queue and in-session resume.
// Pure (unit-tested).

/** Bytes per piece of a plain file. */
export const FILE_CHUNK_BYTES = 4 * 1024 * 1024;

/** Total size from a "Content-Range: bytes 0-0/12345" header, else null. */
export function sizeFromContentRange(header) {
  const m = /^bytes\s+\d+-\d+\/(\d+)\s*$/i.exec(String(header ?? '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * Pieces of a file of `size` bytes; one piece without a range when the size
 * is unknown or the server does not serve ranges.
 * @param {string} url
 * @param {number|null} size
 * @returns {{url:string, byteRange:{offset:number, length:number}|null}[]}
 */
export function rangePlan(url, size, chunk = FILE_CHUNK_BYTES) {
  if (!(size > 0)) return [{ url, byteRange: null }];
  const pieces = [];
  for (let offset = 0; offset < size; offset += chunk) pieces.push({ url, byteRange: { offset, length: Math.min(chunk, size - offset) } });
  return pieces;
}
