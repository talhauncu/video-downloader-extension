import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setInitDuration, renumberFragments } from '../../src/lib/fmp4-fix.js';

const ROOT = new URL('../../', import.meta.url);

/** Runs the vendored mux.js over the TS fixture, as the offscreen document does. */
function muxjsOutput() {
  const ctx = {};
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('src/vendor/mux-mp4.min.js', ROOT), 'utf8'), ctx);
  const transmuxer = new ctx.muxjs.Transmuxer({ remux: true });
  let init = null;
  const data = [];
  transmuxer.on('data', (s) => {
    init ??= new Uint8Array(s.initSegment);
    data.push(new Uint8Array(s.data));
  });
  for (let i = 0; i < 4; i++) {
    transmuxer.push(new Uint8Array(readFileSync(new URL(`test/fixtures/media/hls-ts/seg${i}.ts`, ROOT))));
    transmuxer.flush();
  }
  return { init, data };
}

/** Type → [offset, end] of the first box of each type along a path. */
function find(bytes, path) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0;
  let end = bytes.length;
  let found = null;
  for (const type of path) {
    found = null;
    for (let o = start; o + 8 <= end; o += view.getUint32(o)) {
      if (String.fromCharCode(...bytes.subarray(o + 4, o + 8)) === type) {
        found = [o, o + view.getUint32(o)];
        break;
      }
    }
    if (!found) return null;
    [start, end] = [found[0] + 8, found[1]];
  }
  return found;
}
const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

test('mux.js writes "unknown" durations and repeats fragment numbers (the bug)', () => {
  const { init, data } = muxjsOutput();
  assert.equal(u32(init, find(init, ['moov', 'mvhd'])[0] + 24), 0xffffffff);
  assert.equal(u32(init, find(init, ['moov', 'trak', 'mdia', 'mdhd'])[0] + 24), 0xffffffff);
  // Audio and video fragments of the first segment both say 0.
  const first = data[0];
  assert.equal(u32(first, find(first, ['moof', 'mfhd'])[0] + 12), 0);
});

test('setInitDuration: movie/track durations from the playlist, media durations 0, mehd added', () => {
  const { init } = muxjsOutput();
  const fixed = setInitDuration(init, 4);
  assert.equal(u32(fixed, find(fixed, ['moov', 'mvhd'])[0] + 24), 4 * 90000);
  assert.equal(u32(fixed, find(fixed, ['moov', 'trak', 'tkhd'])[0] + 28), 4 * 90000);
  assert.equal(u32(fixed, find(fixed, ['moov', 'trak', 'mdia', 'mdhd'])[0] + 24), 0);
  const mehd = find(fixed, ['moov', 'mvex', 'mehd']);
  assert.ok(mehd, 'mehd inserted');
  assert.equal(u32(fixed, mehd[0] + 12), 4 * 90000);
  // Box sizes still add up: moov grew by the 16-byte mehd, ftyp untouched.
  assert.equal(fixed.length, init.length + 16);
  const moov = find(fixed, ['moov']);
  assert.equal(moov[1], fixed.length);
  assert.ok(find(fixed, ['moov', 'mvex', 'trex']), 'trex still found after mehd');
  // The input is not modified; nothing to do without a length.
  assert.equal(u32(init, find(init, ['moov', 'mvhd'])[0] + 24), 0xffffffff);
  assert.equal(setInitDuration(init, 0), init);
  assert.equal(setInitDuration(new Uint8Array(8), 4).length, 8);
});

test('renumberFragments: every moof numbered 1, 2, 3, … across chunks', () => {
  const { data } = muxjsOutput();
  let next = 1;
  for (const chunk of data) next = renumberFragments(chunk, next);
  const numbers = data.flatMap((chunk) => {
    const out = [];
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let o = 0; o + 8 <= chunk.length; o += view.getUint32(o)) {
      if (String.fromCharCode(...chunk.subarray(o + 4, o + 8)) === 'moof') out.push(view.getUint32(o + 20));
    }
    return out;
  });
  assert.equal(numbers.length, 8); // 4 segments × audio + video fragment
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(next, 9);
});
