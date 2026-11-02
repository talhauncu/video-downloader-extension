import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyText, worthSniffing, trimJunk, tsSyncOffset, mp4BoxOffset } from '../../src/lib/sniff.js';

test('classifyText recognises HLS and DASH bodies regardless of extension', () => {
  assert.equal(classifyText('#EXTM3U\n#EXT-X-VERSION:3\n'), 'hls');
  assert.equal(classifyText('﻿  #EXTM3U\n'), 'hls');
  assert.equal(classifyText('<?xml version="1.0"?>\n<MPD type="static">'), 'dash');
  assert.equal(classifyText('<MPD xmlns="x">'), 'dash');
  assert.equal(classifyText('<html><body>nope</body></html>'), null);
  assert.equal(classifyText(''), null);
  assert.equal(classifyText(null), null);
});

test('worthSniffing picks text/plain playlists by name hints or .txt, skips big or typed bodies', () => {
  assert.equal(worthSniffing({ url: 'https://h.test/v/master.txt', contentType: 'text/plain', size: 1200 }), true);
  assert.equal(worthSniffing({ url: 'https://h.test/v/sublist_aud1.txt', contentType: 'text/plain; charset=utf-8', size: null }), true);
  assert.equal(worthSniffing({ url: 'https://h.test/v/chunklist', contentType: 'application/octet-stream', size: 500 }), true);
  assert.equal(worthSniffing({ url: 'https://h.test/v/notes.txt', contentType: 'text/plain', size: 5_000_000 }), false);
  assert.equal(worthSniffing({ url: 'https://h.test/v/robots.txt', contentType: 'text/plain', size: 100 }), true); // name alone cannot exclude; the body decides
  assert.equal(worthSniffing({ url: 'https://h.test/v/page.html', contentType: 'text/html', size: 100 }), false);
  assert.equal(worthSniffing({ url: 'https://h.test/v/master.m3u8', contentType: 'application/vnd.apple.mpegurl', size: 100 }), false);
});

function tsPackets(count, junk = 0) {
  const out = new Uint8Array(junk + count * 188);
  for (let i = 0; i < junk; i++) out[i] = 0xaa;
  for (let p = 0; p < count; p++) out[junk + p * 188] = 0x47;
  return out;
}

function mp4(junk = 0) {
  const box = new Uint8Array(junk + 16);
  for (let i = 0; i < junk; i++) box[i] = 0x55;
  const v = new DataView(box.buffer);
  v.setUint32(junk, 16);
  box.set([0x73, 0x74, 0x79, 0x70], junk + 4); // 'styp'
  return box;
}

test('tsSyncOffset / mp4BoxOffset find the first real data', () => {
  assert.equal(tsSyncOffset(tsPackets(3)), 0);
  assert.equal(tsSyncOffset(tsPackets(3, 37)), 37);
  assert.equal(tsSyncOffset(new Uint8Array(600)), -1);
  assert.equal(mp4BoxOffset(mp4()), 0);
  assert.equal(mp4BoxOffset(mp4(21)), 21);
  assert.equal(mp4BoxOffset(new Uint8Array(64)), -1);
});

test('trimJunk removes leading junk and leaves clean data untouched (same array)', () => {
  const clean = tsPackets(3);
  assert.equal(trimJunk(clean, 'ts'), clean);
  const dirty = tsPackets(3, 100);
  const trimmed = trimJunk(dirty, 'ts');
  assert.equal(trimmed.length, 3 * 188);
  assert.equal(trimmed[0], 0x47);
  const dirtyMp4 = mp4(9);
  assert.equal(trimJunk(dirtyMp4, 'fmp4').length, 16);
  // unknown container: tries TS then MP4
  assert.equal(trimJunk(mp4(9), 'unknown').length, 16);
  // tiny inputs pass through
  const tiny = new Uint8Array(4);
  assert.equal(trimJunk(tiny, 'ts'), tiny);
});
