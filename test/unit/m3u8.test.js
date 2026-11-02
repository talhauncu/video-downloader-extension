import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMasterPlaylist,
  parseAttributes,
  parseMasterPlaylist,
  parseMediaPlaylist,
  sortVariants,
  variantLabel,
  ivForSegment,
  variantVideoCodec,
} from '../../src/lib/m3u8.js';

const BASE = 'https://cdn.test/v/abc/master.m3u8';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="audio/tr/playlist.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=29.970,AUDIO="aud",SUBTITLES="subs"
360p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
https://other.test/1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"
720p/playlist.m3u8
`;

test('parseAttributes handles quoted values with commas', () => {
  const a = parseAttributes('BANDWIDTH=1,CODECS="avc1.4d401e,mp4a.40.2",NAME="a, b",RESOLUTION=1x2');
  assert.deepEqual(a, { BANDWIDTH: '1', CODECS: 'avc1.4d401e,mp4a.40.2', NAME: 'a, b', RESOLUTION: '1x2' });
});

test('isMasterPlaylist', () => {
  assert.equal(isMasterPlaylist(MASTER), true);
  assert.equal(isMasterPlaylist('#EXTM3U\n#EXTINF:4,\nseg.ts'), false);
});

test('parseMasterPlaylist: variants, renditions, relative and absolute urls', () => {
  const { variants, audio, subtitles } = parseMasterPlaylist(MASTER, BASE);
  assert.equal(variants.length, 3);
  assert.equal(variants[0].url, 'https://cdn.test/v/abc/360p/playlist.m3u8');
  assert.deepEqual(variants[0].resolution, { width: 640, height: 360 });
  assert.equal(variants[0].bandwidth, 1200000);
  assert.equal(variants[0].frameRate, 29.97);
  assert.equal(variants[0].codecs, 'avc1.4d401e,mp4a.40.2');
  assert.equal(variants[0].audioGroup, 'aud');
  assert.equal(variants[1].url, 'https://other.test/1080p/playlist.m3u8');
  assert.equal(audio.length, 1);
  assert.equal(audio[0].url, 'https://cdn.test/v/abc/audio/tr/playlist.m3u8');
  assert.equal(audio[0].default, true);
  assert.equal(subtitles[0].language, 'en');
});

test('sortVariants puts the highest resolution first; variantLabel is readable', () => {
  const { variants } = parseMasterPlaylist(MASTER, BASE);
  const sorted = sortVariants(variants);
  assert.deepEqual(
    sorted.map((v) => v.resolution.height),
    [1080, 720, 360],
  );
  assert.equal(variantLabel(sorted[0]), '1080p · 4.2 Mbps');
  assert.equal(variantLabel({ resolution: null, bandwidth: 0 }), 'varsayılan');
});

test('parseMediaPlaylist: TS segments, VOD, durations', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:4.000,
seg10.ts
#EXTINF:4.000,title here
seg11.ts
#EXT-X-DISCONTINUITY
#EXTINF:2.500,
https://cdn2.test/seg12.ts
#EXT-X-ENDLIST
`;
  const p = parseMediaPlaylist(text, 'https://cdn.test/v/720p/playlist.m3u8');
  assert.equal(p.live, false);
  assert.equal(p.targetDuration, 4);
  assert.equal(p.mediaSequence, 10);
  assert.equal(p.segments.length, 3);
  assert.equal(p.segments[0].url, 'https://cdn.test/v/720p/seg10.ts');
  assert.equal(p.segments[0].seq, 10);
  assert.equal(p.segments[1].title, 'title here');
  assert.equal(p.segments[2].url, 'https://cdn2.test/seg12.ts');
  assert.equal(p.segments[2].discontinuity, true);
  assert.equal(p.totalDuration, 10.5);
  assert.equal(p.encrypted, false);
  assert.equal(p.container, 'ts');
});

test('parseMediaPlaylist: live playlist has no ENDLIST', () => {
  const p = parseMediaPlaylist('#EXTM3U\n#EXTINF:2,\na.ts\n', 'https://x.test/p.m3u8');
  assert.equal(p.live, true);
});

test('parseMediaPlaylist: fMP4 with EXT-X-MAP and BYTERANGE', () => {
  const text = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:6,
#EXT-X-BYTERANGE:10000@720
media.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:12000
media.mp4
#EXTINF:6,
seg3.m4s
#EXT-X-ENDLIST
`;
  const p = parseMediaPlaylist(text, 'https://x.test/v/p.m3u8');
  assert.equal(p.container, 'fmp4');
  assert.deepEqual(p.segments[0].map, { url: 'https://x.test/v/init.mp4', byteRange: { length: 720, offset: 0 } });
  assert.deepEqual(p.segments[0].byteRange, { length: 10000, offset: 720 });
  // Offset omitted: continues after the previous range.
  assert.deepEqual(p.segments[1].byteRange, { length: 12000, offset: 10720 });
  assert.equal(p.segments[2].byteRange, null);
});

test('parseMediaPlaylist: AES-128 keys with and without IV, NONE resets', () => {
  const text = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:4,
s0.ts
#EXT-X-KEY:METHOD=AES-128,URI="https://k.test/k2"
#EXTINF:4,
s1.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4,
s2.ts
#EXT-X-ENDLIST
`;
  const p = parseMediaPlaylist(text, 'https://x.test/v/p.m3u8');
  assert.equal(p.encrypted, true);
  assert.equal(p.unsupportedKey, null);
  assert.equal(p.segments[0].key.url, 'https://x.test/v/key.bin');
  assert.equal(p.segments[0].key.iv, '0x000102030405060708090a0b0c0d0e0f');
  assert.equal(p.segments[1].key.url, 'https://k.test/k2');
  assert.equal(p.segments[1].key.iv, null);
  assert.equal(p.segments[2].key, null);

  // Explicit IV bytes.
  assert.deepEqual([...ivForSegment(p.segments[0])], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  // Default IV = sequence number, big-endian.
  const iv1 = ivForSegment(p.segments[1]);
  assert.equal(iv1[15], 1);
  assert.equal(
    iv1.slice(0, 15).every((b) => b === 0),
    true,
  );
});

test('parseMediaPlaylist flags SAMPLE-AES / DRM as unsupported', () => {
  const text = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
s0.ts
#EXT-X-ENDLIST`;
  const p = parseMediaPlaylist(text, 'https://x.test/p.m3u8');
  assert.equal(p.unsupportedKey, 'SAMPLE-AES');
});

test('AES-128-CBC decryption with WebCrypto matches a known vector', async () => {
  // Encrypt then decrypt round-trip using the same primitives the downloader uses.
  const keyBytes = new Uint8Array(16).map((_, i) => i);
  const iv = ivForSegment({ key: { iv: null }, seq: 7 });
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const plain = new TextEncoder().encode('hello hls segment bytes, length not a multiple of 16');
  const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain);
  const back = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipher));
  assert.deepEqual([...back], [...plain]);
});

test('sortVariants with preferH264 puts H.264 (or unstated) variants before AV1/HEVC/VP9; labels name them', () => {
  // The 800p variant is AV1, the smaller ones H.264.
  const av1 = { url: 'a', resolution: { height: 800 }, bandwidth: 1454360, codecs: 'av01.0.08M.08,mp4a.40.2' };
  const h264 = { url: 'b', resolution: { height: 532 }, bandwidth: 1208764, codecs: 'avc1.64001f,mp4a.40.2' };
  const unknown = { url: 'c', resolution: { height: 354 }, bandwidth: 708552, codecs: null };
  assert.deepEqual(
    sortVariants([unknown, h264, av1]).map((v) => v.url),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    sortVariants([unknown, h264, av1], { preferH264: true }).map((v) => v.url),
    ['b', 'c', 'a'],
  );
  assert.equal(variantVideoCodec(av1), 'av1');
  assert.equal(variantVideoCodec({ codecs: 'hvc1.1.6.L120.90' }), 'hevc');
  assert.equal(variantVideoCodec(unknown), null);
  assert.equal(variantLabel(av1), '800p · 1.5 Mbps · AV1');
  assert.equal(variantLabel(h264), '532p · 1.2 Mbps');
});
