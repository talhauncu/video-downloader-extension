// Subtitle fixtures (stage 3), written by hand rather than with ffmpeg so
// every timing quirk is deliberate. Also exports the files the extension is
// expected to produce from them. Called by generate.js; can run alone:
//   node test/fixtures/subtitles.js

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MEDIA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'media');

// ---- expected outputs -------------------------------------------------------

export const EXPECTED = {
  trSrt: [
    '1',
    '00:00:00,200 --> 00:00:00,900',
    'Merhaba dünya',
    '',
    '2',
    '00:00:01,500 --> 00:00:02,500',
    '<i>İkinci</i> satır',
    '',
    '3',
    '00:00:02,600 --> 00:00:02,900',
    'Çeviri & altyazı',
    '',
  ].join('\n'),
  trVtt: [
    'WEBVTT',
    '',
    '00:00:00.200 --> 00:00:00.900',
    'Merhaba dünya',
    '',
    '00:00:01.500 --> 00:00:02.500',
    '<i>İkinci</i> satır',
    '',
    '00:00:02.600 --> 00:00:02.900',
    'Çeviri &amp; altyazı',
    '',
  ].join('\n'),
  enSrt: [
    '1',
    '00:00:00,100 --> 00:00:00,800',
    'Hello',
    '',
    '2',
    '00:00:01,100 --> 00:00:01,800',
    'World',
    '',
    '3',
    '00:00:02,500 --> 00:00:03,400',
    'Split cue',
    '',
    '4',
    '00:00:03,500 --> 00:00:03,900',
    'The end',
    '',
  ].join('\n'),
  ttmlSrt: [
    '1',
    '00:00:00,500 --> 00:00:01,500',
    'Hello',
    'from <i>TTML</i>',
    '',
    '2',
    '00:00:02,000 --> 00:00:03,000',
    'Fish & chips',
    '',
  ].join('\n'),
  // A nameless 1.vtt: no language in the URL, Turkish dialogue.
  rotTrSrt: [
    '1',
    '00:00:00,300 --> 00:00:01,200',
    'Bunu neden yaptın?',
    '',
    '2',
    '00:00:01,500 --> 00:00:02,400',
    'Bilmiyorum, ama çok önemli değil.',
    '',
    '3',
    '00:00:02,600 --> 00:00:03,500',
    'Hadi gidelim, şimdi burada kalamayız.',
    '',
  ].join('\n'),
  loneSrt: ['1', '00:00:01,000 --> 00:00:02,000', 'Alone on the page', ''].join('\n'),
};

// ---- sources -------------------------------------------------------------------

const vtt = (map, cues) =>
  `WEBVTT\n${map ? `X-TIMESTAMP-MAP=${map}\n` : ''}\n${cues.map(([a, b, t]) => `${a} --> ${b}\n${t}\n`).join('\n')}`;
const playlist = (n) =>
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:1',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...Array.from({ length: n }, (_, i) => [`#EXTINF:1.000,`, `seg${i}.vtt`]).flat(),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

// Turkish: every segment shares one map; cue times are absolute. The cue at
// 1.5–2.5 s is repeated in the segment it runs into (players do this).
const TR_SEGMENTS = [
  vtt('MPEGTS:900000,LOCAL:00:00:00.000', [['00:00:00.200', '00:00:00.900', 'Merhaba dünya']]),
  vtt('MPEGTS:900000,LOCAL:00:00:00.000', [['00:00:01.500', '00:00:02.500', '<i>İkinci</i> satır']]),
  vtt('MPEGTS:900000,LOCAL:00:00:00.000', [
    ['00:00:01.500', '00:00:02.500', '<i>İkinci</i> satır'],
    ['00:00:02.600', '00:00:02.900', 'Çeviri &amp; altyazı'],
  ]),
  vtt('MPEGTS:900000,LOCAL:00:00:00.000', []),
];

// English: each segment restarts LOCAL at 0 and moves MPEGTS by 1 s; a cue is
// split at the 3 s boundary; classes are dropped in .srt.
const EN_SEGMENTS = [
  vtt('MPEGTS:900000,LOCAL:00:00:00.000', [['00:00:00.100', '00:00:00.800', 'Hello']]),
  vtt('MPEGTS:990000,LOCAL:00:00:00.000', [['00:00:00.100', '00:00:00.800', 'World']]),
  vtt('MPEGTS:1080000,LOCAL:00:00:00.000', [['00:00:00.500', '00:00:01.000', 'Split cue']]),
  vtt('MPEGTS:1170000,LOCAL:00:00:00.000', [
    ['00:00:00.000', '00:00:00.400', 'Split cue'],
    ['00:00:00.500', '00:00:00.900', '<c.yellow>The end</c>'],
  ]),
];

const TR_FILE = vtt(null, [
  ['00:00:00.200', '00:00:00.900', 'Merhaba dünya'],
  ['00:00:01.500', '00:00:02.500', '<i>İkinci</i> satır'],
  ['00:00:02.600', '00:00:02.900', 'Çeviri &amp; altyazı'],
]);

const EN_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="en">
  <body>
    <div>
      <p begin="00:00:00.500" end="00:00:01.500">Hello<br/>from <span tts:fontStyle="italic">TTML</span></p>
      <p begin="2s" dur="1s">Fish &amp; chips</p>
    </div>
  </body>
</tt>
`;

const EN_SRT =
  '1\r\n00:00:00,100 --> 00:00:00,800\r\nHello\r\n\r\n2\r\n00:00:01,100 --> 00:00:01,800\r\nWorld\r\n\r\n3\r\n00:00:02,500 --> 00:00:03,400\r\nSplit cue\r\n\r\n4\r\n00:00:03,500 --> 00:00:03,900\r\nThe end\r\n';

export async function writeSubtitleFixtures(media = MEDIA) {
  const fresh = async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  // HLS: hls-ts video (muxed audio) + Turkish and English WebVTT renditions.
  const hls = await fresh(path.join(media, 'hls-subs'));
  for (const [lang, segments] of [
    ['tr', TR_SEGMENTS],
    ['en', EN_SEGMENTS],
  ]) {
    const dir = await fresh(path.join(hls, lang));
    await fs.writeFile(path.join(dir, 'index.m3u8'), playlist(segments.length));
    for (const [i, text] of segments.entries()) await fs.writeFile(path.join(dir, `seg${i}.vtt`), text);
  }
  await fs.writeFile(
    path.join(hls, 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="tr/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="en/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.64000d,mp4a.40.2",SUBTITLES="subs"',
      '../hls-ts/playlist.m3u8',
      '',
    ].join('\n'),
  );
  // The same subtitles over video-only + audio-only playlists (as many players do):
  // served late (?delay=), the master is described after its sub-playlists.
  await fs.writeFile(
    path.join(hls, 'master-audio.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="../hls-audio/audio/playlist.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="tr/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.64000d,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"',
      '../hls-audio/video/playlist.m3u8',
      '',
    ].join('\n'),
  );

  // DASH: Reddit-style video + audio, WebVTT (tr), TTML (en) and an
  // unsupported ISO-BMFF text track (stpp, de).
  const dash = await fresh(path.join(media, 'dash-subs'));
  await fs.writeFile(path.join(dash, 'tr.vtt'), TR_FILE);
  await fs.writeFile(path.join(dash, 'en.ttml'), EN_TTML);
  await fs.writeFile(
    path.join(dash, 'manifest.mpd'),
    `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H0M4.00S" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="PT0H0M4.00S">
    <AdaptationSet contentType="video" maxWidth="320" maxHeight="180">
      <Representation id="video_180" mimeType="video/mp4" codecs="avc1.64000d" width="320" height="180" frameRate="15" bandwidth="300000">
        <BaseURL>../dash-base/DASH_180.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio">
      <Representation id="audio_48" mimeType="audio/mp4" codecs="mp4a.40.2" audioSamplingRate="44100" bandwidth="48000">
        <BaseURL>../dash-base/DASH_AUDIO_48.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="tr">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
      <Representation id="sub_tr" bandwidth="256"><BaseURL>tr.vtt</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="application/ttml+xml" lang="en" label="English">
      <Representation id="sub_en" bandwidth="256"><BaseURL>en.ttml</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="application/mp4" lang="de">
      <Representation id="sub_de" codecs="stpp" bandwidth="256"><BaseURL>de.mp4</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>
`,
  );

  // Files without a language in their name (as some players serve them): Turkish dialogue,
  // English dialogue, and a dub's Turkish signs (a few cues over 25 minutes).
  const rot = await fresh(path.join(media, 'rot-subs'));
  await fs.writeFile(
    path.join(rot, '1.vtt'),
    vtt(null, [
      ['00:00:00.300', '00:00:01.200', 'Bunu neden yaptın?'],
      ['00:00:01.500', '00:00:02.400', 'Bilmiyorum, ama çok önemli değil.'],
      ['00:00:02.600', '00:00:03.500', 'Hadi gidelim, şimdi burada kalamayız.'],
    ]),
  );
  await fs.writeFile(
    path.join(rot, '2.vtt'),
    vtt(null, [
      ['00:00:00.300', '00:00:01.200', 'Why did you do this?'],
      ['00:00:01.500', '00:00:02.400', "I don't know, but it is not that important."],
      ['00:00:02.600', '00:00:03.500', 'Come on, we have to go now.'],
    ]),
  );
  await fs.writeFile(
    path.join(rot, '3.vtt'),
    vtt(null, [
      ['00:00:20.000', '00:00:22.000', 'FRANKFURT ALMANYA'],
      ['00:09:00.000', '00:09:02.000', 'MÜHENDİSLİK FAKÜLTESİ'],
      ['00:17:00.000', '00:17:02.000', 'YARIŞ PİSTİ YENİ REKOR'],
      ['00:25:00.000', '00:25:02.000', 'GERÇEĞE DÖNÜŞTÜ'],
    ]),
  );

  // Page subtitle files: <track>s next to sample.mp4, and one on its own.
  const subs = await fresh(path.join(media, 'subs'));
  await fs.writeFile(path.join(subs, 'sample-tr.vtt'), TR_FILE);
  await fs.writeFile(path.join(subs, 'sample-en.srt'), EN_SRT);
  await fs.writeFile(path.join(subs, 'lone-en.vtt'), vtt(null, [['00:00:01.000', '00:00:02.000', 'Alone on the page']]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeSubtitleFixtures();
  console.log('Subtitle fixtures written to', MEDIA);
}
