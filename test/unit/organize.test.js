import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoPick } from '../../src/lib/subtitles.js';
import {
  adScore,
  isAd,
  childMap,
  masterFor,
  durationsMatch,
  matchBlob,
  streamDuration,
  organize,
  badgeCount,
  subtitleSegmentDirs,
  subtitleChoices,
} from '../../src/lib/organize.js';

const PLAYER = 'https://player.test/embed/abc/?id=1';
const PAGE = 'https://film.test/movie/';
let n = 0;
const it = (o) => ({ id: `i${++n}`, firstSeen: n, frameUrl: PAGE, ...o });

test('adScore: banners and tiny clips are ads, real videos and site entries are not', () => {
  // Banners like those seen on real pages.
  assert.equal(
    isAd(it({ kind: 'video', url: 'https://banners.test/k/d2f4.mp4', width: 728, height: 90, duration: 10, size: 574634 })),
    true,
  );
  assert.equal(
    isAd(it({ kind: 'video', url: 'https://banners.test/k/35f3.mp4', width: 250, height: 250, duration: 5, size: 202642 })),
    true,
  );
  // Banner size alone is enough.
  assert.equal(adScore(it({ kind: 'video', url: 'https://x.test/a.mp4', width: 300, height: 250 })), 3);
  // Short and small but normal aspect: not an ad (score 2).
  assert.equal(isAd(it({ kind: 'video', url: 'https://x.test/clip.mp4', width: 320, height: 180, duration: 4, size: 41_000 })), false);
  // Ad host.
  assert.equal(isAd(it({ kind: 'video', url: 'https://pagead2.googlesyndication.com/v.mp4' })), true);
  assert.equal(isAd(it({ kind: 'video', url: 'https://cdn.test/v.mp4', frameUrl: 'https://ads.exoclick.com/frame', duration: 9 })), true);
  // Extreme aspect ratio + short.
  assert.equal(isAd(it({ kind: 'video', url: 'https://x.test/strip.mp4', width: 900, height: 100, duration: 6 })), true);
  // Never: site entries, streams, long films.
  assert.equal(adScore(it({ kind: 'video', site: 'instagram', url: 'https://x.test/r.mp4', width: 728, height: 90 })), 0);
  assert.equal(adScore(it({ kind: 'hls', url: 'https://x.test/master.m3u8' })), 0);
  assert.equal(isAd(it({ kind: 'video', url: 'https://x.test/film.mp4', width: 1920, height: 800, duration: 5885, size: 2e9 })), false);
});

test('durationsMatch uses max(2 s, 2 %)', () => {
  assert.equal(durationsMatch(5885, 5885), true);
  assert.equal(durationsMatch(5885, 5800), true); // 85 s ≤ 2 % of 5885 (117 s)
  assert.equal(durationsMatch(5885, 5700), false);
  assert.equal(durationsMatch(4, 5), true); // within 2 s
  assert.equal(durationsMatch(4, 7), false);
  assert.equal(durationsMatch(null, 4), false);
});

const master = () =>
  it({
    kind: 'hls',
    url: 'https://cdn.test/hls/x/txt/master.txt?s=TOKEN',
    frameUrl: PLAYER,
    stream: {
      type: 'master',
      variants: [{ url: 'https://cdn.test/hls/x/txt/sublist_2.txt', height: 800 }],
      audios: [{ url: 'https://cdn.test/hls/x/txt/sublist_aud1.txt' }, { url: 'https://cdn.test/hls/x/txt/sublist_aud2.txt' }],
    },
  });
const sub = (name, extra = {}) =>
  it({ kind: 'hls', url: `https://cdn.test/hls/x/txt/${name}`, frameUrl: PLAYER, stream: { type: 'media', duration: 5885 }, ...extra });

test('childMap links variant and audio playlists to their master by path (query ignored)', () => {
  const m = master();
  const map = childMap([m, sub('sublist_2.txt')]);
  assert.equal(map.get('https://cdn.test/hls/x/txt/sublist_2.txt'), m);
  assert.equal(map.get('https://cdn.test/hls/x/txt/sublist_aud1.txt'), m);
  assert.equal(map.size, 3);
});

test('streamDuration falls back to the longest child', () => {
  assert.equal(streamDuration({ stream: { duration: 10 } }), 10);
  assert.equal(streamDuration({ stream: { type: 'master' } }, [{ stream: { duration: 30 } }, { stream: { duration: 31 } }]), 31);
  assert.equal(streamDuration({}), null);
});

test('matchBlob: same frame first, duration decides between candidates, mismatched durations do not match', () => {
  const a = it({ kind: 'hls', url: 'https://cdn.test/a.m3u8', frameUrl: PLAYER, stream: { duration: 600 } });
  const b = it({ kind: 'hls', url: 'https://cdn.test/b.m3u8', frameUrl: PLAYER, stream: { duration: 5885 } });
  const other = it({ kind: 'hls', url: 'https://cdn.test/c.m3u8', frameUrl: 'https://elsewhere.test/', stream: { duration: 5885 } });
  const dur = (s) => s.stream?.duration ?? null;
  assert.equal(matchBlob(it({ kind: 'blob', frameUrl: PLAYER, duration: 5885 }), [a, b, other], dur), b);
  assert.equal(matchBlob(it({ kind: 'blob', frameUrl: PLAYER, duration: 30 }), [a, b], dur), null);
  // Single candidate in the frame and unknown durations: match.
  const lone = it({ kind: 'hls', url: 'https://cdn.test/l.m3u8', frameUrl: PLAYER });
  assert.equal(
    matchBlob(it({ kind: 'blob', frameUrl: PLAYER }), [lone], () => null),
    lone,
  );
  // Hash differences in the frame URL are ignored.
  assert.equal(
    matchBlob(it({ kind: 'blob', frameUrl: `${PLAYER}#t=1` }), [lone], () => null),
    lone,
  );
  // Nothing in this frame or origin.
  assert.equal(
    matchBlob(it({ kind: 'blob', frameUrl: 'https://nowhere.test/p' }), [lone], () => null),
    null,
  );
});

test('organize: film page → one main card, children folded, blob merged, six ads in others', () => {
  const ads = [
    [728, 90, 10],
    [728, 90, 6],
    [250, 250, 5],
    [728, 90, 6],
    [728, 90, 7],
    [728, 90, 14],
  ].map(([w, h, d], i) =>
    it({ kind: 'video', url: `https://banners.test/k/${i}.mp4`, width: w, height: h, duration: d, size: 400_000, source: 'both' }),
  );
  const m = master();
  const items = [
    ...ads,
    it({ kind: 'blob', url: 'blob:https://player.test/1', frameUrl: PLAYER, width: 1920, height: 800, duration: 5885 }),
    m,
    sub('sublist_aud1.txt'),
    sub('sublist_2.txt'),
  ];
  const o = organize(items, { tabUrl: PAGE });
  assert.equal(o.recommended.length, 1);
  assert.equal(o.main.item, m);
  assert.deepEqual(o.main.display, { width: 1920, height: 800, duration: 5885 });
  assert.equal(o.main.merged.length, 1);
  assert.equal(o.others.length, 6);
  assert.ok(o.others.every((c) => c.reason === 'ad'));
  assert.equal(o.folded.length, 3); // 2 sub-playlists + the merged blob
  assert.equal(o.all.length, 10);
  assert.equal(badgeCount(o), 1);
  // With the ad filter off the banners become recommended, the film still wins.
  const off = organize(items, { tabUrl: PAGE, hideAds: false });
  assert.equal(off.recommended.length, 7);
  assert.equal(off.main.item, m);
});

test('organize: Instagram → the open reel is main, neighbours in others, raw chunks hidden', () => {
  const reel = (pk, code) =>
    it({ kind: 'video', site: 'instagram', key: `instagram:${pk}`, code, url: `https://cdn.test/${pk}.mp4`, duration: 30 });
  const items = [
    it({ kind: 'video', url: 'https://scontent.cdninstagram.com/v.mp4', hidden: true, trackTag: 'dash_vp9' }),
    it({ kind: 'audio', url: 'https://scontent.cdninstagram.com/a.mp4', hidden: true, trackTag: 'dash_audio' }),
    reel('1', 'AAA'),
    reel('2', 'BBB'),
    reel('3', 'CCC'),
    it({ kind: 'blob', url: 'blob:https://www.instagram.com/x', frameUrl: 'https://www.instagram.com/reels/BBB/', duration: 30 }),
  ];
  const o = organize(items, { tabUrl: 'https://www.instagram.com/reels/BBB/' });
  assert.equal(o.main.item.code, 'BBB');
  assert.equal(o.recommended.length, 1);
  assert.deepEqual(o.others.map((c) => c.reason).sort(), ['neighbour', 'neighbour', 'player']);
  assert.equal(o.raw.length, 2);
  // Without site entries the raw chunks are all there is: they stay recommended.
  const rawOnly = organize(items.slice(0, 2), { tabUrl: 'https://www.instagram.com/reels/BBB/' });
  assert.equal(rawOnly.recommended.length, 2);
  assert.equal(rawOnly.raw.length, 0);
});

test('organize: a lone player stream is shown when nothing is downloadable; segments go to others', () => {
  const o = organize([it({ kind: 'blob', url: 'blob:x' }), it({ kind: 'segment', url: 'https://x.test/seg/' })]);
  assert.equal(o.recommended.length, 1);
  assert.equal(o.recommended[0].item.kind, 'blob');
  assert.equal(o.others[0].reason, 'segment');
  assert.equal(badgeCount(o), 0);
});

test('organize: a playlist the page player is playing beats longer progressive clips', () => {
  const banner = it({ kind: 'video', url: 'https://x.test/b.mp4', width: 640, height: 360, duration: 7 });
  const film = it({ kind: 'hls', url: 'https://x.test/m.m3u8', frameUrl: PLAYER, stream: { type: 'media', duration: 4 } });
  const blob = it({ kind: 'blob', url: 'blob:x', frameUrl: PLAYER, duration: 4 });
  const o = organize([banner, film, blob], { hideAds: false });
  assert.equal(o.main.item, film);
});

test('organize: main is the longest downloadable, live streams lose', () => {
  const short = it({ kind: 'video', url: 'https://x.test/a.mp4', width: 1280, height: 720, duration: 60 });
  const long = it({ kind: 'video', url: 'https://x.test/b.mp4', width: 640, height: 360, duration: 600 });
  const live = it({ kind: 'hls', url: 'https://x.test/live.m3u8', stream: { type: 'media', live: true, duration: 9999 } });
  const o = organize([short, live, long]);
  assert.equal(o.main.item, long);
  assert.equal(o.recommended.length, 3);
});

test('subtitles: stream segments fold, page files attach to the player card, lone files stand alone', () => {
  const m = it({
    kind: 'hls',
    url: 'https://cdn.test/s/master.m3u8',
    frameUrl: PLAYER,
    stream: {
      type: 'master',
      variants: [{ url: 'https://cdn.test/s/v/index.m3u8', height: 360 }],
      audios: [],
      subtitles: [
        { source: 'hls', ref: 'https://cdn.test/s/tr/index.m3u8', lang: 'tr', label: 'Türkçe', default: true },
        { source: 'hls', ref: 'https://cdn.test/s/en/index.m3u8', lang: 'en', label: 'English' },
      ],
    },
  });
  const subPlaylist = it({
    kind: 'hls',
    url: 'https://cdn.test/s/tr/index.m3u8',
    frameUrl: PLAYER,
    stream: { type: 'media', subtitle: true, duration: 4, segmentDir: 'https://cdn.test/s/tr/' },
  });
  const seg0 = it({ kind: 'subtitle', url: 'https://cdn.test/s/tr/seg0.vtt', frameUrl: PLAYER });
  const seg1 = it({ kind: 'subtitle', url: 'https://cdn.test/s/en/seg0.vtt', frameUrl: PLAYER });
  const sidecar = it({ kind: 'subtitle', url: 'https://cdn.test/extra/film-de.vtt', frameUrl: PLAYER, langGuess: 'de' });
  const o = organize([m, subPlaylist, seg0, seg1, sidecar]);
  assert.equal(o.main.item.id, m.id);
  assert.deepEqual(
    o.recommended.map((c) => c.item.id),
    [m.id],
  );
  assert.deepEqual(o.others, []);
  assert.deepEqual(o.folded.map((x) => x.id).sort(), [subPlaylist.id, seg0.id, seg1.id].sort());
  assert.deepEqual(
    o.main.subtitles.map((x) => x.id),
    [sidecar.id],
  );
  assert.equal(badgeCount(o), 1);
  assert.deepEqual(
    subtitleChoices(o.main).map((c) => [c.source, c.lang, c.label]),
    [
      ['hls', 'tr', 'Türkçe'],
      ['hls', 'en', 'English'],
      ['item', 'de', 'Deutsch'],
    ],
  );
  assert.deepEqual([...subtitleSegmentDirs([m, subPlaylist])].sort(), ['https://cdn.test/s/en/', 'https://cdn.test/s/tr/']);
});

test('subtitles: a <track> attaches to the video of its frame, not to the main card of another frame', () => {
  const film = it({ kind: 'video', url: 'https://cdn.test/film.mp4', frameUrl: PLAYER, duration: 5000, width: 1280, height: 720 });
  const trailer = it({ kind: 'video', url: 'https://other.test/trailer.mp4', frameUrl: PAGE, duration: 90, width: 640, height: 360 });
  const track = it({
    kind: 'subtitle',
    url: 'https://other.test/trailer-tr.vtt',
    frameUrl: PAGE,
    lang: 'tr',
    label: 'Türkçe',
    default: true,
  });
  const o = organize([film, trailer, track]);
  assert.equal(o.main.item.id, film.id);
  const trailerCard = o.recommended.find((c) => c.item.id === trailer.id);
  assert.deepEqual(
    trailerCard.subtitles.map((x) => x.id),
    [track.id],
  );
  assert.deepEqual(o.main.subtitles, []);
  assert.deepEqual(subtitleChoices(trailerCard), [
    { source: 'item', ref: track.id, lang: 'tr', label: 'Türkçe', default: true, forced: false },
  ]);
});

test('subtitles: without any video a subtitle file is listed under others', () => {
  const lone = it({ kind: 'subtitle', url: 'https://cdn.test/subs/film-en.srt', frameUrl: PAGE, langGuess: 'en' });
  const o = organize([lone]);
  assert.equal(o.main, null);
  assert.deepEqual(
    o.others.map((c) => [c.item.id, c.reason]),
    [[lone.id, 'subtitle']],
  );
  assert.deepEqual(
    subtitleChoices(o.others[0]).map((c) => c.label),
    ['English'],
  );
  assert.equal(badgeCount(o), 0);
});

test('subtitles: a subtitle playlist without its master goes to others', () => {
  const p = it({
    kind: 'hls',
    url: 'https://cdn.test/s/tr/index.m3u8',
    stream: { type: 'media', subtitle: true, segmentDir: 'https://cdn.test/s/tr/' },
  });
  const v = it({ kind: 'video', url: 'https://cdn.test/film.mp4', duration: 100 });
  const o = organize([p, v]);
  assert.equal(o.main.item.id, v.id);
  assert.deepEqual(
    o.others.map((c) => [c.item.id, c.reason]),
    [[p.id, 'subtitle']],
  );
});

test('rotating first directory: variant and audio playlists still fold under the master', () => {
  // The master lists "/mw/<token>…", the player asks for "/mt/<token>…" and "/mi/<token>…".
  const T = 'H3IjMKWanKWfYwVjZwLhI0IPYHEZYwRjBQOjYxEIDH';
  const H = 'https://s27.cdn.test';
  const m = it({
    kind: 'hls',
    url: `${H}/mt/${T}avr1`,
    frameUrl: PLAYER,
    stream: {
      type: 'master',
      variants: [
        { url: `${H}/m2/${T}vr1b1080a`, height: 800 },
        { url: `${H}/mw/${T}vr1b720`, height: 532 },
      ],
      audios: [{ url: `${H}/mw/${T}vr1b1080l0tra1`, default: true }, { url: `${H}/m9/${T}vr1b1080l0ena2` }],
    },
  });
  const video = it({ kind: 'hls', url: `${H}/mt/${T}vr1b720`, frameUrl: PLAYER, stream: { type: 'media', duration: 6512 } });
  const audio = it({ kind: 'hls', url: `${H}/mi/${T}vr1b1080l0tra1`, frameUrl: PLAYER, stream: { type: 'media', duration: 6511 } });
  const o = organize([m, audio, video]);
  assert.equal(o.main.item.id, m.id);
  assert.deepEqual(o.folded.map((x) => x.id).sort(), [audio.id, video.id].sort());
  assert.equal(o.main.display.duration, 6512);
  // Short generic names are not matched across directories.
  const other = it({ kind: 'hls', url: `${H}/other/index.m3u8`, stream: { type: 'media', duration: 30 } });
  const m2 = it({
    kind: 'hls',
    url: `${H}/a/master.m3u8`,
    stream: { type: 'master', variants: [{ url: `${H}/a/index.m3u8` }], audios: [] },
  });
  assert.equal(organize([m2, other]).folded.length, 0);
});

test('subtitles: a forced (signs-only) file is marked and loses to a full one of the same language', () => {
  const film = it({ kind: 'video', url: 'https://cdn.test/film.mp4', frameUrl: PLAYER, duration: 5000 });
  const signs = it({
    kind: 'subtitle',
    url: 'https://subs.test/a/1.vtt',
    frameUrl: PLAYER,
    langGuess: 'tr',
    subtitleInfo: { forced: true },
  });
  const full = it({
    kind: 'subtitle',
    url: 'https://subs.test/a/2.vtt',
    frameUrl: PLAYER,
    langGuess: 'tr',
    subtitleInfo: { forced: false },
  });
  const choices = subtitleChoices(organize([film, signs, full]).main);
  assert.deepEqual(
    choices.map((c) => [c.label, c.forced]),
    [
      ['Türkçe', true],
      ['Türkçe', false],
    ],
  );
  assert.deepEqual(
    autoPick(choices, ['tr']).map((c) => c.ref),
    [full.id],
  );
});

test('masterFor: the described master of a sub-playlist and which variant it is', () => {
  const m = master();
  const variant = sub('sublist_2.txt');
  const audio = sub('sublist_aud1.txt');
  assert.deepEqual(masterFor([m, variant, audio], variant), { master: m, variantUrl: 'https://cdn.test/hls/x/txt/sublist_2.txt' });
  assert.deepEqual(masterFor([m, variant, audio], audio), { master: m, variantUrl: null });
  // Not described yet, not a child, or a master itself: nothing to redirect to.
  assert.equal(masterFor([{ ...m, stream: null }, variant], variant), null);
  assert.equal(masterFor([m, sub('other.txt')], sub('other.txt')), null);
  assert.equal(masterFor([m], m), null);
  assert.equal(masterFor([m], { kind: 'video', url: 'https://cdn.test/film.mp4' }), null);
});
