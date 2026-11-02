import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideo, hostDisabled, streamOptions } from '../../src/lib/badge-resolve.js';

const PLAYER = 'https://player.test/embed/1/';
const PAGE = 'https://film.test/movie/';
let n = 0;
const it = (o) => ({ id: `b${++n}`, firstSeen: n, frameUrl: PAGE, ...o });

const master = it({
  kind: 'hls',
  url: 'https://cdn.test/hls/x/master.txt?s=T',
  frameUrl: PLAYER,
  stream: {
    type: 'master',
    separateAudio: true,
    variants: [
      { url: 'https://cdn.test/hls/x/v1.txt', label: '800p · 2.6 Mbps', height: 800 },
      { url: 'https://cdn.test/hls/x/v2.txt', label: '480p · 1.0 Mbps', height: 480 },
    ],
    audios: [],
  },
});
const blob = it({ kind: 'blob', url: 'blob:https://player.test/abc', frameUrl: PLAYER, width: 1920, height: 800, duration: 5885 });
const banner = it({ kind: 'video', url: 'https://ads.test/k/1.mp4', width: 728, height: 90, duration: 10, size: 500_000, source: 'both' });
const plain = it({ kind: 'video', url: 'https://news.test/v/clip.mp4', width: 1280, height: 720, duration: 95, size: 9_000_000 });

test('hostDisabled matches the host and its subdomains, ignoring www', () => {
  assert.equal(hostDisabled('https://www.instagram.com/reels/x/', ['instagram.com']), true);
  assert.equal(hostDisabled('https://m.instagram.com/', ['instagram.com']), true);
  assert.equal(hostDisabled('https://notinstagram.com/', ['instagram.com']), false);
  assert.equal(hostDisabled('https://a.test/', []), false);
});

test('streamOptions returns the quality list in popup order', () => {
  assert.deepEqual(streamOptions(master), {
    options: [
      { value: 'https://cdn.test/hls/x/v1.txt', label: '800p · 2.6 Mbps' },
      { value: 'https://cdn.test/hls/x/v2.txt', label: '480p · 1.0 Mbps' },
    ],
    payloadKey: 'variantUrl',
  });
  assert.deepEqual(streamOptions({ stream: { type: 'dash', videos: [{ id: 'v', label: '1080p' }] } }), {
    options: [{ value: 'v', label: '1080p' }],
    payloadKey: 'videoRepId',
  });
  assert.deepEqual(streamOptions({}), { options: [], payloadKey: null });
});

test('a blob player resolves to the playlist it was merged with, with quality options', () => {
  const r = resolveVideo([banner, blob, master], { src: blob.url, duration: 5885, frameUrl: PLAYER }, { tabUrl: PAGE });
  assert.equal(r.show, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.item.id, master.id);
  assert.equal(r.options.length, 2);
  assert.equal(r.payloadKey, 'variantUrl');
  assert.equal(r.note, 'Ses ayrı iner, birleştirilir');
});

test('banners get no badge; a plain video resolves to itself', () => {
  assert.deepEqual(resolveVideo([banner, plain], { src: banner.url }, { tabUrl: PAGE }), { show: false, reason: 'ad' });
  const r = resolveVideo([banner, plain], { src: plain.url }, { tabUrl: PAGE });
  assert.equal(r.status, 'ok');
  assert.equal(r.item.id, plain.id);
  assert.deepEqual(r.options, []);
  // With the ad filter off banners are downloadable too.
  assert.equal(resolveVideo([banner], { src: banner.url }, { tabUrl: PAGE, hideAds: false }).status, 'ok');
});

test('a not-yet-captured banner is still recognised as an ad from its element metrics', () => {
  assert.deepEqual(resolveVideo([], { src: 'https://ads.test/k/9.mp4', width: 300, height: 250, duration: 6 }, { tabUrl: PAGE }), {
    show: false,
    reason: 'ad',
  });
  assert.equal(
    resolveVideo([], { src: 'https://news.test/v/new.mp4', width: 1280, height: 720, duration: 300 }, { tabUrl: PAGE }).status,
    'pending',
  );
});

test('an unmatched player points to the list; Instagram players map to the site entry', () => {
  assert.equal(
    resolveVideo([it({ kind: 'blob', url: 'blob:x/1', duration: 30 })], { src: 'blob:x/1', duration: 30 }, { tabUrl: PAGE }).status,
    'unmatched',
  );
  const reelA = it({ kind: 'video', site: 'instagram', code: 'AAA', url: 'https://cdn.test/a.mp4', duration: 12, title: '@a hello' });
  const reelB = it({ kind: 'video', site: 'instagram', code: 'BBB', url: 'https://cdn.test/b.mp4', duration: 31 });
  const igBlob = it({
    kind: 'blob',
    url: 'blob:https://www.instagram.com/z',
    frameUrl: 'https://www.instagram.com/reels/BBB/',
    duration: 12,
  });
  const r = resolveVideo([reelA, reelB, igBlob], { src: igBlob.url, duration: 12 }, { tabUrl: 'https://www.instagram.com/reels/BBB/' });
  assert.equal(r.item.id, reelA.id); // duration decides, not the page's main reel
  assert.equal(r.title, '@a hello');
  const r2 = resolveVideo([reelA, reelB, igBlob], { src: igBlob.url, duration: null }, { tabUrl: 'https://www.instagram.com/reels/BBB/' });
  assert.equal(r2.item.id, reelB.id); // unknown duration: the open reel
});

test('mode off, disabled sites and unsupported streams', () => {
  assert.deepEqual(resolveVideo([plain], { src: plain.url }, { mode: 'off' }), { show: false, reason: 'off' });
  assert.deepEqual(resolveVideo([plain], { src: plain.url }, { tabUrl: 'https://news.test/a', disabledHosts: ['news.test'] }), {
    show: false,
    reason: 'disabled',
  });
  const live = it({ kind: 'hls', url: 'https://x.test/live.m3u8', frameUrl: PLAYER, stream: { type: 'media', live: true } });
  const liveBlob = it({ kind: 'blob', url: 'blob:live', frameUrl: PLAYER });
  const r = resolveVideo([live, liveBlob], { src: 'blob:live' }, { tabUrl: PAGE });
  assert.equal(r.status, 'unsupported');
  assert.equal(r.note, 'Canlı yayın, indirilemez');
});

test('Instagram feed: the post shortcode decides; no fallback to the longest reel', () => {
  const FEED = 'https://www.instagram.com/';
  const ad = it({
    kind: 'video',
    site: 'instagram',
    code: 'CLEAR',
    url: 'https://cdn.test/clear.mp4',
    duration: 60,
    title: '@sponsor',
  });
  const a = it({ kind: 'video', site: 'instagram', code: 'POSTA', url: 'https://cdn.test/a.mp4', duration: 15 });
  const b = it({ kind: 'video', site: 'instagram', code: 'POSTB', url: 'https://cdn.test/b.mp4', duration: 15 });
  const blobA = it({ kind: 'blob', url: 'blob:https://www.instagram.com/a', frameUrl: FEED, duration: 15 });
  const items = [ad, a, b, blobA];
  // Shortcode wins even when the duration is ambiguous.
  assert.equal(resolveVideo(items, { src: blobA.url, duration: 15, postCode: 'POSTB' }, { tabUrl: FEED }).item.id, b.id);
  // Code not captured yet: wait, never guess.
  assert.equal(resolveVideo(items, { src: blobA.url, duration: 15, postCode: 'NEWONE' }, { tabUrl: FEED }).status, 'pending');
  // No code and two reels of the same length: unmatched (the old code picked one, or the longest).
  assert.equal(resolveVideo(items, { src: blobA.url, duration: 15 }, { tabUrl: FEED }).status, 'unmatched');
  // No code, no duration, a feed URL: unmatched instead of the 60 s reel.
  assert.equal(resolveVideo(items, { src: blobA.url }, { tabUrl: FEED }).status, 'unmatched');
  // No code but a unique duration: accepted.
  assert.equal(resolveVideo(items, { src: blobA.url, duration: 60 }, { tabUrl: FEED }).item.id, ad.id);
});

test('an unknown shortcode falls back to a unique duration, else waits', () => {
  const FEED = 'https://www.instagram.com/reels/XYZXYZXYZ1/';
  const a = it({ kind: 'video', site: 'instagram', code: 'POSTAAAA', url: 'https://cdn.test/a.mp4', duration: 21 });
  const b = it({ kind: 'video', site: 'instagram', code: 'POSTBBBB', url: 'https://cdn.test/b.mp4', duration: 33 });
  const blob = it({ kind: 'blob', url: 'blob:https://www.instagram.com/q', frameUrl: FEED, duration: 33 });
  assert.equal(resolveVideo([a, b, blob], { src: blob.url, duration: 33, postCode: 'NOTCAPTURED' }, { tabUrl: FEED }).item.id, b.id);
  assert.equal(resolveVideo([a, b, blob], { src: blob.url, duration: 50, postCode: 'NOTCAPTURED' }, { tabUrl: FEED }).status, 'pending');
});

test('resolveVideo names the subtitles the badge takes along', () => {
  const page = 'https://site.test/watch/';
  const items = [
    { id: 'v', kind: 'video', url: 'https://cdn.test/film.mp4', frameUrl: page, duration: 100, width: 640, height: 360, firstSeen: 1 },
    { id: 's1', kind: 'subtitle', url: 'https://cdn.test/film-tr.vtt', frameUrl: page, lang: 'tr', label: 'Türkçe', firstSeen: 2 },
    { id: 's2', kind: 'subtitle', url: 'https://cdn.test/film-en.vtt', frameUrl: page, lang: 'en', firstSeen: 3 },
  ];
  const r = resolveVideo(items, { src: 'https://cdn.test/film.mp4', duration: 100 }, { tabUrl: page, subtitleLangs: ['tr'] });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.subtitles, ['Türkçe']);
  assert.match(r.note, /Altyazı: Türkçe/);
  const none = resolveVideo(items, { src: 'https://cdn.test/film.mp4', duration: 100 }, { tabUrl: page, subtitleLangs: [] });
  assert.deepEqual(none.subtitles, []);
  assert.equal(none.note, '');
});

test('resolveVideo names the audio language the badge takes when a stream has several', () => {
  const page = 'https://player.test/vx/1';
  const master = {
    id: 'm',
    kind: 'hls',
    url: 'https://cdn.test/master.m3u8',
    frameUrl: page,
    firstSeen: 1,
    stream: {
      type: 'master',
      separateAudio: true,
      variants: [{ url: 'https://cdn.test/v.m3u8', label: '720p', height: 720 }],
      audios: [
        { url: 'https://cdn.test/tr.m3u8', lang: 'tr', name: 'Türkçe', default: true },
        { url: 'https://cdn.test/en.m3u8', lang: 'en', name: 'English' },
      ],
    },
  };
  const child = {
    id: 'v',
    kind: 'hls',
    url: 'https://cdn.test/v.m3u8',
    frameUrl: page,
    firstSeen: 2,
    stream: { type: 'media', duration: 100 },
  };
  const video = { src: 'blob:https://player.test/x', duration: 100, frameUrl: page };
  const blob = { id: 'b', kind: 'blob', url: video.src, frameUrl: page, duration: 100, firstSeen: 3 };
  assert.match(resolveVideo([master, child, blob], video, { tabUrl: page }).note, /Ses: Türkçe/);
  assert.match(resolveVideo([master, child, blob], video, { tabUrl: page, audioLang: 'original' }).note, /Ses: English/);
  // One language: nothing to say.
  const single = { ...master, stream: { ...master.stream, audios: master.stream.audios.slice(0, 1) } };
  assert.doesNotMatch(resolveVideo([single, child, blob], video, { tabUrl: page }).note, /Ses:/);
});
