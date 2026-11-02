import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, KIND, sizeFromHeaders, groupKey, extensionOf, formatBytes } from '../../src/lib/media-url.js';

test('classify by content type', () => {
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'video/mp4' }), KIND.VIDEO);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'video/webm; codecs=vp9' }), KIND.VIDEO);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'audio/mpeg' }), KIND.AUDIO);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'application/vnd.apple.mpegurl' }), KIND.HLS);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'application/x-mpegURL' }), KIND.HLS);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'application/dash+xml' }), KIND.DASH);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'video/mp2t' }), KIND.SEGMENT);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'video/iso.segment' }), KIND.SEGMENT);
});

test('classify by extension when content type is generic or missing', () => {
  assert.equal(
    classify({ url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/abc.mp4?tag=12', contentType: 'application/octet-stream' }),
    KIND.VIDEO,
  );
  assert.equal(classify({ url: 'https://a.test/clip.webm', contentType: null }), KIND.VIDEO);
  assert.equal(classify({ url: 'https://a.test/master.m3u8', contentType: 'text/plain' }), KIND.HLS);
  assert.equal(classify({ url: 'https://v.redd.it/abc/DASHPlaylist.mpd', contentType: 'text/xml' }), KIND.DASH);
  assert.equal(classify({ url: 'https://a.test/seg-0001.ts', contentType: 'application/octet-stream' }), KIND.SEGMENT);
  assert.equal(classify({ url: 'https://a.test/init.m4s', contentType: 'video/mp4' }), KIND.SEGMENT);
});

test('classify rejects non-media', () => {
  assert.equal(classify({ url: 'https://a.test/index.html', contentType: 'text/html' }), null);
  assert.equal(classify({ url: 'https://a.test/api/video.mp4', contentType: 'application/json' }), null);
  assert.equal(classify({ url: 'https://a.test/style.css', contentType: 'text/css' }), null);
  assert.equal(classify({ url: 'https://a.test/img.png', contentType: 'image/png' }), null);
});

test('extensionOf handles queries, hashes and no extension', () => {
  assert.equal(extensionOf('https://a.test/v/file.MP4?x=1#t'), 'mp4');
  assert.equal(extensionOf('https://a.test/v/file'), '');
  assert.equal(extensionOf('not a url'), '');
});

test('sizeFromHeaders prefers Content-Range total', () => {
  assert.equal(
    sizeFromHeaders([
      { name: 'Content-Length', value: '100' },
      { name: 'Content-Range', value: 'bytes 0-99/12345' },
    ]),
    12345,
  );
  assert.equal(sizeFromHeaders([{ name: 'content-length', value: '777' }]), 777);
  assert.equal(
    sizeFromHeaders([
      { name: 'content-length', value: '100' },
      { name: ':status', value: '206' },
    ]),
    null,
  );
  assert.equal(sizeFromHeaders([]), null);
});

test('groupKey collapses ranges/queries and segment directories', () => {
  const a = groupKey('https://cdn.test/v/clip.mp4?sig=1', KIND.VIDEO);
  const b = groupKey('https://cdn.test/v/clip.mp4?sig=2', KIND.VIDEO);
  assert.equal(a, b);
  assert.equal(a, 'https://cdn.test/v/clip.mp4');

  const s1 = groupKey('https://cdn.test/hls/720p/seg-1.ts', KIND.SEGMENT);
  const s2 = groupKey('https://cdn.test/hls/720p/seg-2.ts', KIND.SEGMENT);
  assert.equal(s1, s2);
  assert.equal(s1, 'https://cdn.test/hls/720p/');
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(41_000), '40 KB');
  assert.equal(formatBytes(5.5 * 1024 * 1024), '5.5 MB');
  assert.equal(formatBytes(null), '');
});

test('classify subtitle files by content type and extension', () => {
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'text/vtt; charset=utf-8' }), KIND.SUBTITLE);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'application/x-subrip' }), KIND.SUBTITLE);
  assert.equal(classify({ url: 'https://a.test/x', contentType: 'application/ttml+xml' }), KIND.SUBTITLE);
  assert.equal(classify({ url: 'https://a.test/subs/film-tr.vtt', contentType: 'text/plain' }), KIND.SUBTITLE);
  assert.equal(classify({ url: 'https://a.test/subs/film-tr.srt', contentType: 'application/octet-stream' }), KIND.SUBTITLE);
  assert.equal(classify({ url: 'https://a.test/subs/film.dfxp', contentType: null }), KIND.SUBTITLE);
  // An HTML error page at a .vtt address is not a subtitle.
  assert.equal(classify({ url: 'https://a.test/subs/film-tr.vtt', contentType: 'text/html' }), null);
});
