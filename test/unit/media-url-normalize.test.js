import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMediaUrl, cdnTrackHint, groupKey, KIND, codecHint, QUICKTIME_UNSUPPORTED } from '../../src/lib/media-url.js';

const efg = (tag) => Buffer.from(JSON.stringify({ vencode_tag: tag })).toString('base64');

test('normalizeMediaUrl drops bytestart/byteend and keeps everything else', () => {
  const url = `https://scontent.cdninstagram.com/v/t66/f2/m86/AQP.mp4?efg=${efg('dash_r2gen2hq_ln_avc_v1')}&_nc_ht=x&bytestart=0&byteend=3400`;
  const n = normalizeMediaUrl(url);
  assert.equal(n.includes('bytestart'), false);
  assert.equal(n.includes('byteend'), false);
  assert.equal(new URL(n).searchParams.get('_nc_ht'), 'x');
  assert.equal(normalizeMediaUrl('https://a.test/x.mp4?q=1'), 'https://a.test/x.mp4?q=1');
  assert.equal(normalizeMediaUrl('not a url'), 'not a url');
});

test('cdnTrackHint classifies Instagram audio/video tracks from efg', () => {
  assert.deepEqual(cdnTrackHint(`https://scontent.cdninstagram.com/v/a.mp4?efg=${efg('dash_ln_heaac_vbr3_audio')}`), {
    track: 'audio',
    tag: 'dash_ln_heaac_vbr3_audio',
  });
  assert.deepEqual(cdnTrackHint(`https://video.xx.fbcdn.net/v/a.mp4?efg=${efg('dash_r2gen2hq_ln_avc_v1')}`).track, 'video');
  assert.equal(cdnTrackHint('https://cdn.test/a.mp4?efg=zzz'), null);
  assert.deepEqual(cdnTrackHint('https://scontent.cdninstagram.com/v/a.mp4'), { track: null, tag: null });
});

test('chunks of the same Instagram file share a group key', () => {
  const a = `https://scontent.cdninstagram.com/v/a.mp4?efg=x&bytestart=0&byteend=100`;
  const b = `https://scontent.cdninstagram.com/v/a.mp4?efg=x&bytestart=101&byteend=900`;
  assert.equal(groupKey(a, KIND.VIDEO), groupKey(b, KIND.VIDEO));
});

test('codecHint reads the codec family from CDN encode tags', () => {
  assert.equal(codecHint('dash_r2gen2hq_ln_avc_v1'), 'AVC');
  assert.equal(codecHint('dash_vp9-basic-gen2_q80'), 'VP9');
  assert.equal(codecHint('dash_av1-basic-gen2_q80'), 'AV1');
  assert.equal(codecHint('dash_ln_heaac_vbr3_audio'), 'AAC');
  assert.equal(codecHint('xpv_progressive_permanent_v2'), null);
  assert.equal(codecHint(null), null);
  assert.equal(QUICKTIME_UNSUPPORTED.has('VP9'), true);
  assert.equal(QUICKTIME_UNSUPPORTED.has('AVC'), false);
});
