// Generates media fixtures with ffmpeg. Outputs are small (a few hundred KB
// in total) and committed to the repo, so tests run without ffmpeg.
// Usage: npm run fixtures

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createCipheriv } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSubtitleFixtures } from './subtitles.js';

const MEDIA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'media');

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

// 4 seconds, 320x180 test pattern + 440 Hz tone. Small and visibly "a video".
const SOURCE = [
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=320x180:rate=15',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=44100',
  '-t',
  '4',
  '-shortest',
];
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-g', '15'];
const AAC = ['-c:a', 'aac', '-b:a', '48k'];

await fs.mkdir(MEDIA, { recursive: true });

// Stage 0/1: plain progressive files.
ffmpeg([...SOURCE, ...H264, ...AAC, '-movflags', '+faststart', path.join(MEDIA, 'sample.mp4')]);
ffmpeg([...SOURCE, '-c:v', 'libvpx', '-b:v', '150k', '-c:a', 'libopus', '-b:a', '48k', path.join(MEDIA, 'sample.webm')]);

// ---------------------------------------------------------------------------
// Stage 3: HLS fixtures.

async function fresh(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// HLS with MPEG-TS segments, 1 s each.
const TS_DIR = await fresh(path.join(MEDIA, 'hls-ts'));
ffmpeg([
  ...SOURCE,
  ...H264,
  ...AAC,
  '-f',
  'hls',
  '-hls_time',
  '1',
  '-hls_playlist_type',
  'vod',
  '-hls_list_size',
  '0',
  '-hls_segment_filename',
  path.join(TS_DIR, 'seg%d.ts'),
  path.join(TS_DIR, 'playlist.m3u8'),
]);

// HLS with fMP4 segments, two variants + hand-written master playlist.
const FMP4_DIR = await fresh(path.join(MEDIA, 'hls-fmp4'));
const variants = [
  { name: '360p', size: '640x360', bandwidth: 800000 },
  { name: '180p', size: '320x180', bandwidth: 300000 },
];
for (const v of variants) {
  const dir = await fresh(path.join(FMP4_DIR, v.name));
  ffmpeg([
    ...SOURCE,
    '-vf',
    `scale=${v.size}`,
    ...H264,
    ...AAC,
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_playlist_type',
    'vod',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    path.join(dir, 'seg%d.m4s'),
    path.join(dir, 'playlist.m3u8'),
  ]);
}
await fs.writeFile(
  path.join(FMP4_DIR, 'master.m3u8'),
  [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    ...variants.flatMap((v) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.size},CODECS="avc1.64001e,mp4a.40.2"`,
      `${v.name}/playlist.m3u8`,
    ]),
    '',
  ].join('\n'),
);

// AES-128 encrypted copy of the TS fixture, encrypted here so that the
// decrypted output must equal the plain segments byte for byte.
const AES_DIR = await fresh(path.join(MEDIA, 'hls-aes'));
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
await fs.writeFile(path.join(AES_DIR, 'key.bin'), key);
const plainPlaylist = await fs.readFile(path.join(TS_DIR, 'playlist.m3u8'), 'utf8');
const plainSegments = plainPlaylist.split('\n').filter((l) => l && !l.startsWith('#'));
const aesLines = [];
let seq = 0;
for (const line of plainPlaylist.split('\n')) {
  if (line.startsWith('#EXTINF')) {
    aesLines.push(line);
  } else if (line && !line.startsWith('#')) {
    const plain = await fs.readFile(path.join(TS_DIR, line));
    // Segment 0 uses the default IV (= sequence number); the others carry an explicit IV.
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(seq === 0 ? 0 : 0x1000 + seq, 12);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    await fs.writeFile(path.join(AES_DIR, line), enc);
    if (seq === 0) aesLines.splice(aesLines.length - 1, 0, '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    else aesLines.splice(aesLines.length - 1, 0, `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString('hex')}`);
    aesLines.push(line);
    seq++;
  } else {
    aesLines.push(line);
  }
}
await fs.writeFile(path.join(AES_DIR, 'playlist.m3u8'), aesLines.join('\n'));

// Long playlist for progress/cancel tests: the 4 TS segments repeated 50×
// (200 entries) with a per-request server delay via ?delay=.
const LONG_DIR = await fresh(path.join(MEDIA, 'hls-long'));
const longLines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
for (let i = 0; i < 50; i++) {
  if (i > 0) longLines.push('#EXT-X-DISCONTINUITY');
  for (const seg of plainSegments) {
    longLines.push('#EXTINF:1.000000,', `../hls-ts/${seg}?delay=40`);
  }
}
longLines.push('#EXT-X-ENDLIST', '');
await fs.writeFile(path.join(LONG_DIR, 'playlist.m3u8'), longLines.join('\n'));

// Live playlist (no ENDLIST) for the "cannot download live" test.
await fs.writeFile(
  path.join(MEDIA, 'hls-live.m3u8'),
  '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:1,\nhls-ts/seg0.ts\n#EXTINF:1,\nhls-ts/seg1.ts\n',
);

// ---------------------------------------------------------------------------
// Stage 4: DASH, HLS with a separate audio group, Instagram-style tracks.

// DASH with SegmentTemplate + SegmentTimeline: two video representations + audio.
const DASH_DIR = await fresh(path.join(MEDIA, 'dash'));
ffmpeg([
  ...SOURCE,
  '-filter_complex',
  '[0:v]split=2[v360][v180];[v360]scale=640:360[v360s];[v180]scale=320:180[v180s]',
  '-map',
  '[v360s]',
  '-map',
  '[v180s]',
  '-map',
  '1:a',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '32',
  '-pix_fmt',
  'yuv420p',
  '-g',
  '15',
  '-b:v:0',
  '800k',
  '-b:v:1',
  '300k',
  ...AAC,
  '-f',
  'dash',
  '-seg_duration',
  '1',
  '-use_template',
  '1',
  '-use_timeline',
  '1',
  '-init_seg_name',
  'init-$RepresentationID$.m4s',
  '-media_seg_name',
  'chunk-$RepresentationID$-$Number%05d$.m4s',
  '-adaptation_sets',
  'id=0,streams=v id=1,streams=a',
  path.join(DASH_DIR, 'manifest.mpd'),
]);

// Reddit-style DASH: one fragmented MP4 per representation + SegmentBase MPD.
const BASE_DIR = await fresh(path.join(MEDIA, 'dash-base'));
const FRAG = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000'];
ffmpeg([...SOURCE, '-an', ...H264, ...FRAG, path.join(BASE_DIR, 'DASH_180.mp4')]);
ffmpeg([...SOURCE, '-an', '-vf', 'scale=640:360', ...H264, ...FRAG, path.join(BASE_DIR, 'DASH_360.mp4')]);
ffmpeg([...SOURCE, '-vn', ...AAC, ...FRAG, path.join(BASE_DIR, 'DASH_AUDIO_48.mp4')]);
await fs.writeFile(
  path.join(BASE_DIR, 'DASHPlaylist.mpd'),
  `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H0M4.00S" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="PT0H0M4.00S">
    <AdaptationSet segmentAlignment="true" subsegmentAlignment="true" subsegmentStartsWithSAP="1" maxWidth="640" maxHeight="360">
      <Representation id="video_360" mimeType="video/mp4" codecs="avc1.64001e" width="640" height="360" frameRate="15" bandwidth="800000">
        <BaseURL>DASH_360.mp4</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="900-1000"><Initialization range="0-899"/></SegmentBase>
      </Representation>
      <Representation id="video_180" mimeType="video/mp4" codecs="avc1.64000d" width="320" height="180" frameRate="15" bandwidth="300000">
        <BaseURL>DASH_180.mp4</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="900-1000"><Initialization range="0-899"/></SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet segmentAlignment="true" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="audio_48" mimeType="audio/mp4" codecs="mp4a.40.2" audioSamplingRate="44100" bandwidth="48000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="1"/>
        <BaseURL>DASH_AUDIO_48.mp4</BaseURL>
        <SegmentBase indexRangeExact="true" indexRange="700-800"><Initialization range="0-699"/></SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`,
);

// HLS master with a separate audio rendition (video-only variant + audio playlist).
const HLSA_DIR = await fresh(path.join(MEDIA, 'hls-audio'));
const hlsFmp4 = (dir, extra) =>
  ffmpeg([
    ...SOURCE,
    ...extra,
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_playlist_type',
    'vod',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    path.join(dir, 'seg%d.m4s'),
    path.join(dir, 'playlist.m3u8'),
  ]);
hlsFmp4(await fresh(path.join(HLSA_DIR, 'video')), ['-an', ...H264]);
hlsFmp4(await fresh(path.join(HLSA_DIR, 'audio')), ['-vn', ...AAC]);
await fs.writeFile(
  path.join(HLSA_DIR, 'master.m3u8'),
  [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="audio/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.64000d,mp4a.40.2",AUDIO="aud"',
    'video/playlist.m3u8',
    '',
  ].join('\n'),
);

// Instagram-style progressive tracks fetched in byte ranges: a video-only
// file (sample.mp4 is reused) and an audio-only file.
ffmpeg([...SOURCE, '-vn', ...AAC, '-movflags', '+faststart', path.join(MEDIA, 'sample-audio.m4a')]);

// ---------------------------------------------------------------------------
// Stage 5: VP9 video + AAC audio DASH (QuickTime cannot play VP9) for the
// merge + transcode tests.
const VP9_DIR = await fresh(path.join(MEDIA, 'dash-vp9'));
ffmpeg([
  ...SOURCE,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c:v',
  'libvpx-vp9',
  '-b:v',
  '200k',
  '-deadline',
  'realtime',
  '-cpu-used',
  '8',
  '-g',
  '15',
  '-pix_fmt',
  'yuv420p',
  ...AAC,
  '-f',
  'dash',
  '-seg_duration',
  '1',
  '-use_template',
  '1',
  '-use_timeline',
  '1',
  '-init_seg_name',
  'init-$RepresentationID$.m4s',
  '-media_seg_name',
  'chunk-$RepresentationID$-$Number%05d$.m4s',
  '-adaptation_sets',
  'id=0,streams=v id=1,streams=a',
  path.join(VP9_DIR, 'manifest.mpd'),
]);

// Stage 1a: a playlist whose third segment is missing, and TS segments with 64
// junk bytes in front of each (disguised hosts do this).
const BROKEN_DIR = await fresh(path.join(MEDIA, 'hls-broken'));
await fs.writeFile(
  path.join(BROKEN_DIR, 'playlist.m3u8'),
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:1.000000,',
    '../hls-ts/seg0.ts',
    '#EXTINF:1.000000,',
    '../hls-ts/seg1.ts',
    '#EXTINF:1.000000,',
    '../hls-ts/missing.ts',
    '#EXTINF:1.000000,',
    '../hls-ts/seg3.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n'),
);

const JUNK_DIR = await fresh(path.join(MEDIA, 'hls-junk'));
const junk = Buffer.alloc(64, 0xaa);
for (const seg of plainSegments) {
  const data = await fs.readFile(path.join(TS_DIR, seg));
  await fs.writeFile(path.join(JUNK_DIR, seg), Buffer.concat([junk, data]));
}
await fs.writeFile(path.join(JUNK_DIR, 'playlist.m3u8'), plainPlaylist);

// Stage 2a: banner-sized ad clips (no audio) for the ad filter.
const ADS_DIR = await fresh(path.join(MEDIA, 'ads'));
const BANNERS = [
  [728, 90, 4],
  [728, 90, 5],
  [728, 90, 6],
  [728, 90, 7],
  [250, 250, 5],
  [300, 250, 6],
];
for (const [i, [w, h, d]] of BANNERS.entries()) {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${w}x${h}:rate=10`,
    '-t',
    String(d),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '40',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '10',
    '-movflags',
    '+faststart',
    path.join(ADS_DIR, `banner${i + 1}.mp4`),
  ]);
}

// Stage 3 (second plan): subtitles, hand-written (see subtitles.js).
await writeSubtitleFixtures(MEDIA);

console.log('Fixtures written to', MEDIA);
async function report(dir, indent = '  ') {
  for (const f of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      console.log(`${indent}${f.name}/`);
      await report(full, indent + '  ');
    } else {
      const { size } = await fs.stat(full);
      console.log(`${indent}${f.name}  ${(size / 1024).toFixed(1)} KB`);
    }
  }
}
await report(MEDIA);
