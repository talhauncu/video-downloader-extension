import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { SITES, BRIDGE_SCRIPT, siteById, siteForUrl, siteChunkKey, validateSite, validateSites } from '../../src/sites/index.js';
import instagram, { pickBestVersion } from '../../src/sites/instagram/site.js';
import twitter, { pickBestVariant, sizeFromUrl } from '../../src/sites/twitter/site.js';
import facebook from '../../src/sites/facebook/site.js';
import vimeo, { pickBestProgressive } from '../../src/sites/vimeo/site.js';

const ROOT = new URL('../../', import.meta.url);
const valid = () => ({
  ...instagram,
  id: 'example',
  label: 'Example',
  hosts: [/(^|\.)example\.com$/],
  matches: ['*://*.example.com/*'],
  main: 'src/sites/example/main.js',
});

test('the registered sites are valid, their files exist and versions match the extractors', () => {
  assert.deepEqual(validateSites(), []);
  assert.ok(existsSync(new URL(BRIDGE_SCRIPT, ROOT)));
  for (const site of SITES) {
    assert.ok(existsSync(new URL(site.main, ROOT)), site.main);
    const source = readFileSync(new URL(site.main, ROOT), 'utf8');
    assert.match(source, new RegExp(`const VERSION = ${site.version};`), `${site.id}: VERSION in ${site.main}`);
    for (const name of Object.values(site.globals)) assert.ok(source.includes(`window.${name}`), `${site.id}: sets window.${name}`);
  }
});

test('validateSite names every missing or malformed field', () => {
  assert.deepEqual(validateSite(valid()), []);
  const errors = validateSite({
    id: 'Bad Id',
    hosts: ['instagram.com'],
    matches: ['instagram.com'],
    main: 'src/content/x.js',
    version: 0,
    globals: {},
    fetchContext: 'tab',
  });
  for (const field of ['id', 'label', 'hosts', 'matches', 'main', 'version', 'globals', 'fetchContext', 'toItems']) {
    assert.ok(
      errors.some((e) => e.includes(field)),
      `${field}: ${errors.join(' | ')}`,
    );
  }
});

test('validateSites rejects duplicate ids and hosts claimed by two sites', () => {
  assert.ok(validateSites([valid(), valid()]).some((e) => e.includes('duplicate id: example')));
  const greedy = { ...valid(), id: 'greedy', hosts: [/instagram\.com$/], matches: ['*://*.greedy.test/*'] };
  assert.ok(validateSites([instagram, greedy]).some((e) => e.includes('greedy hosts also match instagram')));
  const twin = { ...valid(), id: 'twin', matches: ['*://*.instagram.com/*'] };
  assert.ok(validateSites([instagram, twin]).some((e) => e.includes('claimed by')));
});

test('siteForUrl picks the site by its top-frame host; test hosts can be added', () => {
  assert.equal(siteForUrl('https://www.instagram.com/reel/ABCDEFGH/')?.id, 'instagram');
  assert.equal(siteForUrl('https://instagram.com/')?.id, 'instagram');
  assert.equal(siteForUrl('https://notinstagram.com.evil.test/'), null);
  assert.equal(siteForUrl('http://127.0.0.1:8787/pages/ig.html'), null);
  assert.equal(siteForUrl('http://127.0.0.1:8787/pages/ig.html', [{ site: 'instagram', re: /^127\.0\.0\.1$/ }])?.id, 'instagram');
  assert.equal(siteForUrl('not a url'), null);
  assert.equal(siteById('instagram'), instagram);
  assert.equal(siteById('nope'), null);
});

test('instagram.toItems: the largest progressive version, else the DASH manifest, else nothing', () => {
  const versions = [
    { url: 'https://cdn.test/small.mp4', width: 360, height: 640 },
    { url: 'https://cdn.test/big.mp4', width: 720, height: 1280 },
  ];
  assert.equal(pickBestVersion(versions).url, 'https://cdn.test/big.mp4');
  const out = instagram.toItems(
    {
      items: [
        { pk: '1', code: 'REELCODE1', versions, duration: 12, username: 'user', caption: 'First line\nsecond' },
        { pk: '2', code: 'REELCODE2', versions: [], dashManifest: '<MPD/>', width: 1080, height: 1920 },
        { pk: '3', versions: [] },
      ],
    },
    { pageUrl: 'https://www.instagram.com/reel/REELCODE1/' },
  );
  assert.equal(out.length, 2);
  assert.deepEqual(
    {
      key: out[0].entry.key,
      url: out[0].entry.url,
      kind: out[0].entry.kind,
      title: out[0].entry.title,
      site: out[0].entry.site,
      code: out[0].entry.code,
    },
    { key: 'instagram:1', url: 'https://cdn.test/big.mp4', kind: 'video', title: '@user First line', site: 'instagram', code: 'REELCODE1' },
  );
  assert.equal(out[0].sizeFrom, 'https://cdn.test/big.mp4');
  assert.equal(out[1].entry.key, 'instagram:2:dash');
  assert.equal(out[1].entry.kind, 'dash');
  assert.equal(out[1].entry.manifestText, '<MPD/>');
  assert.equal(out[1].describe, true);
});

test('twitter: the highest-bitrate MP4, else the HLS master; title from the user and the text', () => {
  const v = (url, type, bitrate) => ({ url, type, bitrate });
  const variants = [
    v('https://video.twimg.com/ext_tw_video/111/pu/pl/master.m3u8?tag=12', 'application/x-mpegURL', null),
    v('https://video.twimg.com/ext_tw_video/111/pu/vid/avc1/480x270/a.mp4?tag=12', 'video/mp4', 256000),
    v('https://video.twimg.com/ext_tw_video/111/pu/vid/avc1/1280x720/c.mp4?tag=12', 'video/mp4', 2176000),
    v('https://video.twimg.com/ext_tw_video/111/pu/vid/avc1/640x360/b.mp4?tag=12', 'video/mp4', 832000),
  ];
  assert.equal(pickBestVariant(variants).bitrate, 2176000);
  assert.deepEqual(sizeFromUrl(variants[2].url), { width: 1280, height: 720 });
  const out = twitter.toItems(
    {
      items: [
        { mediaId: '111', tweetId: '9001', user: 'someone', text: 'Look at this  https://t.co/abc', duration: 12, variants },
        { mediaId: '222', tweetId: '9002', user: 'other', variants: [variants[0]] },
        { mediaId: '333', tweetId: '9003', variants: [] },
      ],
    },
    { pageUrl: 'https://x.com/someone/status/9001' },
  );
  assert.equal(out.length, 2);
  const [video, hls] = out;
  assert.deepEqual(
    [video.entry.key, video.entry.kind, video.entry.code, video.entry.title, video.entry.width, video.entry.height],
    ['twitter:111', 'video', '9001', '@someone Look at this', 1280, 720],
  );
  assert.equal(video.sizeFrom, variants[2].url);
  assert.equal(video.entry.versions.length, 3);
  assert.deepEqual([hls.entry.key, hls.entry.kind, hls.entry.title, hls.describe], ['twitter:222:hls', 'hls', '@other', true]);
});

test('siteChunkKey: X player chunks name their media; other URLs belong to no entry', () => {
  assert.equal(siteChunkKey('https://video.twimg.com/ext_tw_video/111/pu/pl/avc1/1280x720/x.m3u8'), 'twitter:111');
  assert.equal(siteChunkKey('https://video.twimg.com/amplify_video/222/vid/avc1/0/3000/1280x720/s.m4s'), 'twitter:222');
  assert.equal(siteChunkKey('https://video.twimg.com/tweet_video/AbCd.mp4'), null);
  assert.equal(siteChunkKey('https://cdn.test/videos/111/x.m3u8'), null);
  assert.equal(siteChunkKey('not a url'), null);
  assert.equal(siteForUrl('https://x.com/someone/status/9001')?.id, 'twitter');
  assert.equal(siteForUrl('https://mobile.twitter.com/home')?.id, 'twitter');
  assert.ok(validateSite({ ...valid(), chunkOf: 'no' }).some((e) => e.includes('chunkOf')));
});

test('facebook.toItems: HD, else SD, else the DASH manifest (covered by the MP4 entry once it exists)', () => {
  const out = facebook.toItems(
    {
      items: [
        {
          id: '501',
          hd: 'https://video.fbcdn.test/hd.mp4',
          sd: 'https://video.fbcdn.test/sd.mp4',
          owner: 'Bir Sayfa',
          text: 'İlk satır\nikinci',
          duration: 30,
        },
        { id: '502', sd: 'https://video.fbcdn.test/sd2.mp4' },
        { id: '503', dashManifest: '<MPD/>', owner: 'Reels' },
        { id: '504' },
      ],
    },
    { pageUrl: 'https://www.facebook.com/watch/?v=501' },
  );
  assert.equal(out.length, 3);
  assert.deepEqual(
    [out[0].entry.key, out[0].entry.url, out[0].entry.kind, out[0].entry.code, out[0].entry.title, out[0].sizeFrom],
    ['facebook:501', 'https://video.fbcdn.test/hd.mp4', 'video', '501', 'Bir Sayfa · İlk satır', 'https://video.fbcdn.test/hd.mp4'],
  );
  assert.equal(out[1].entry.url, 'https://video.fbcdn.test/sd2.mp4');
  assert.equal(out[1].entry.title, null);
  assert.deepEqual(
    [out[2].entry.key, out[2].entry.kind, out[2].entry.manifestText, out[2].entry.coveredBy, out[2].describe],
    ['facebook:503:dash', 'dash', '<MPD/>', 'facebook:503', true],
  );
  assert.equal(siteForUrl('https://www.facebook.com/reel/123456789')?.id, 'facebook');
  assert.equal(siteForUrl('https://m.facebook.com/watch/?v=1')?.id, 'facebook');
});

test('vimeo.toItems: the largest progressive file, else the HLS master; runs in frames with the frame context', () => {
  assert.equal(vimeo.allFrames, true);
  assert.equal(vimeo.fetchContext, 'frame');
  const progressive = [
    { url: 'https://vod.test/360.mp4', width: 640, height: 360, fps: 25 },
    { url: 'https://vod.test/1080.mp4', width: 1920, height: 1080, fps: 25 },
    { url: 'https://vod.test/720.mp4', width: 1280, height: 720, fps: 25 },
  ];
  assert.equal(pickBestProgressive(progressive).url, 'https://vod.test/1080.mp4');
  const out = vimeo.toItems(
    {
      items: [
        { id: '76979871', title: 'Bir film', owner: 'Bir Stüdyo', duration: 62, progressive, hls: 'https://vod.test/master.m3u8' },
        { id: '11111111', title: 'Yalnızca akış', progressive: [], hls: 'https://vod.test/other.m3u8', width: 1280, height: 720 },
        { id: '22222222', progressive: [] },
      ],
    },
    { pageUrl: 'https://vimeo.com/76979871' },
  );
  assert.equal(out.length, 2);
  assert.deepEqual(
    [out[0].entry.key, out[0].entry.kind, out[0].entry.code, out[0].entry.title, out[0].entry.width, out[0].sizeFrom],
    ['vimeo:76979871', 'video', '76979871', 'Bir Stüdyo · Bir film', 1920, 'https://vod.test/1080.mp4'],
  );
  assert.deepEqual(
    [out[1].entry.key, out[1].entry.kind, out[1].entry.url, out[1].describe],
    ['vimeo:11111111:hls', 'hls', 'https://vod.test/other.m3u8', true],
  );
  assert.equal(siteForUrl('https://player.vimeo.com/video/76979871')?.id, 'vimeo');
  assert.ok(validateSite({ ...valid(), allFrames: 'yes' }).some((e) => e.includes('allFrames')));
});
