import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimestamp,
  detectFormat,
  formatOf,
  parseVtt,
  parseSrt,
  parseTtml,
  parseTtmlTime,
  toSrt,
  toVtt,
  mergeSubtitleSegments,
  normalizeCues,
  convertSubtitle,
  markupToSrtText,
  normalizeLanguage,
  iso639_2,
  languageLabel,
  guessLanguage,
  languageMatches,
  autoPick,
  languageSuffix,
  guessLanguageFromCues,
  looksForced,
  describeSubtitle,
} from '../../src/lib/subtitles.js';

test('parseTimestamp accepts WebVTT and SubRip forms', () => {
  assert.equal(parseTimestamp('00:00:01.500'), 1.5);
  assert.equal(parseTimestamp('01:02.250'), 62.25);
  assert.equal(parseTimestamp('01:00:00,040'), 3600.04);
  assert.equal(parseTimestamp('1:00:00.5'), 3600.5);
  assert.equal(parseTimestamp('nope'), null);
});

test('detectFormat recognises WebVTT, SubRip and TTML', () => {
  assert.equal(detectFormat('﻿WEBVTT\n\n00:00.000 --> 00:01.000\nHi'), 'vtt');
  assert.equal(detectFormat('WEBVTT - title\n'), 'vtt');
  assert.equal(detectFormat('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n'), 'srt');
  assert.equal(detectFormat('<?xml version="1.0"?>\n<tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>'), 'ttml');
  assert.equal(detectFormat('<tt:tt xmlns:tt="http://www.w3.org/ns/ttml">'), 'ttml');
  assert.equal(detectFormat('<html><body>404</body></html>'), null);
  assert.equal(detectFormat('#EXTM3U'), null);
});

test('formatOf reads MIME types, codecs and extensions', () => {
  assert.equal(formatOf({ mimeType: 'text/vtt' }), 'vtt');
  assert.equal(formatOf({ mimeType: 'application/ttml+xml' }), 'ttml');
  assert.equal(formatOf({ mimeType: 'application/mp4', codecs: 'stpp' }), 'mp4');
  assert.equal(formatOf({ mimeType: 'application/mp4', codecs: 'wvtt' }), 'mp4');
  assert.equal(formatOf({ url: 'https://x.test/a/film-tr.srt?sig=1' }), 'srt');
  assert.equal(formatOf({ url: 'https://x.test/a/sub.dfxp' }), 'ttml');
  assert.equal(formatOf({ url: 'https://x.test/a/video.mp4' }), null);
});

test('parseVtt reads cues, ids, settings, notes and X-TIMESTAMP-MAP', () => {
  const text = [
    'WEBVTT',
    'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000',
    '',
    'NOTE a comment',
    '',
    'cue-1',
    '00:00:01.000 --> 00:00:02.500 align:start line:90%',
    '<v Ali>Merhaba</v>',
    '<i>dünya</i>',
    '',
    '00:03.000 --> 00:04.000',
    'İkinci &amp; son',
    '',
  ].join('\n');
  const { cues, timestampMap } = parseVtt(text);
  assert.deepEqual(timestampMap, { mpegts: 900000, local: 0 });
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 2.5, text: '<v Ali>Merhaba</v>\n<i>dünya</i>' });
  assert.deepEqual(cues[1], { start: 3, end: 4, text: 'İkinci &amp; son' });
});

test('parseVtt tolerates a cue directly after the header and CRLF', () => {
  const { cues } = parseVtt('WEBVTT\r\n00:00:01.000 --> 00:00:02.000\r\nHi\r\n');
  assert.deepEqual(cues, [{ start: 1, end: 2, text: 'Hi' }]);
});

test('parseSrt reads numbered blocks and keeps i/b/u tags only', () => {
  const text =
    '1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Merhaba</i> <font color="red">dünya</font>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,500\r\nA & B < C\r\n';
  const { cues } = parseSrt(text);
  assert.deepEqual(cues, [
    { start: 1, end: 2, text: '<i>Merhaba</i> dünya' },
    { start: 3, end: 4.5, text: 'A &amp; B &lt; C' },
  ]);
});

test('markupToSrtText strips classes, voices, timestamps and decodes entities', () => {
  assert.equal(markupToSrtText('<c.yellow>Sarı</c> <v Ali>Ali</v> <00:00:01.000>&lt;3 &amp; <b.x>kalın</b>'), 'Sarı Ali <3 & <b>kalın</b>');
});

test('toSrt and toVtt write numbered / headed cue lists', () => {
  const cues = [
    { start: 1, end: 2.5, text: '<i>Merhaba</i>' },
    { start: 3661.001, end: 3662, text: 'A &amp; B' },
  ];
  assert.equal(toSrt(cues), '1\n00:00:01,000 --> 00:00:02,500\n<i>Merhaba</i>\n\n2\n01:01:01,001 --> 01:01:02,000\nA & B\n');
  assert.equal(toVtt(cues), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<i>Merhaba</i>\n\n01:01:01.001 --> 01:01:02.000\nA &amp; B\n');
  assert.equal(toSrt([]), '');
});

test('parseTtmlTime handles clock, frames and offset times', () => {
  assert.equal(parseTtmlTime('00:00:01.250'), 1.25);
  assert.equal(parseTtmlTime('00:00:01:15', { frameRate: 30 }), 1.5);
  assert.equal(parseTtmlTime('2.5s'), 2.5);
  assert.equal(parseTtmlTime('1500ms'), 1.5);
  assert.equal(parseTtmlTime('20000000t', { tickRate: 10000000 }), 2);
  assert.equal(parseTtmlTime('1m'), 60);
  assert.equal(parseTtmlTime('bad'), null);
});

test('parseTtml reads paragraphs, line breaks, styling and timed ancestors', () => {
  const ttml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
  <head><styling><style xml:id="s1" tts:color="white"/></styling></head>
  <body>
    <div>
      <p begin="00:00:01.000" end="00:00:02.000">Hello<br/>
        <span tts:fontStyle="italic">world</span></p>
      <p begin="30000000t" dur="10000000t">A &amp; B</p>
    </div>
    <div begin="10s">
      <p begin="1s" end="2s">Later</p>
    </div>
  </body>
</tt>`;
  const { cues } = parseTtml(ttml);
  assert.deepEqual(cues, [
    { start: 1, end: 2, text: 'Hello\n<i>world</i>' },
    { start: 3, end: 4, text: 'A &amp; B' },
    { start: 11, end: 12, text: 'Later' },
  ]);
});

test('parseTtml accepts namespaced (tt:) element names', () => {
  const { cues } = parseTtml(
    '<tt:tt xmlns:tt="http://www.w3.org/ns/ttml"><tt:body><tt:div><tt:p begin="0.5s" end="1.5s">Hi</tt:p></tt:div></tt:body></tt:tt>',
  );
  assert.deepEqual(cues, [{ start: 0.5, end: 1.5, text: 'Hi' }]);
});

test('normalizeCues sorts, drops duplicates and joins split cues', () => {
  const cues = normalizeCues([
    { start: 2, end: 3, text: 'B' },
    { start: 0, end: 1, text: 'A' },
    { start: 2, end: 3, text: 'B' }, // repeated in the next segment
    { start: 4, end: 5, text: 'C' }, // split at a segment boundary ...
    { start: 5, end: 6, text: 'C' }, // ... continues here
    { start: 7, end: 7, text: 'empty' },
  ]);
  assert.deepEqual(cues, [
    { start: 0, end: 1, text: 'A' },
    { start: 2, end: 3, text: 'B' },
    { start: 4, end: 6, text: 'C' },
  ]);
});

test('mergeSubtitleSegments rebases X-TIMESTAMP-MAP times on the stream start', () => {
  // Style 1: every segment shares one map; cue times are already absolute.
  const shared = [
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:00.500 --> 00:00:01.500\nBir\n',
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:00.500 --> 00:00:01.500\nBir\n\n00:00:02.000 --> 00:00:03.000\nİki\n',
  ];
  assert.deepEqual(mergeSubtitleSegments(shared), [
    { start: 0.5, end: 1.5, text: 'Bir' },
    { start: 2, end: 3, text: 'İki' },
  ]);
  // Style 2: each segment restarts LOCAL at 0 with its own MPEGTS offset.
  const perSegment = [
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00:00.200 --> 00:00:00.800\nOne\n',
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:216000,LOCAL:00:00:00.000\n\n00:00:00.200 --> 00:00:00.800\nTwo\n',
    'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:10.000,MPEGTS:306000\n\n00:00:10.000 --> 00:00:10.500\nThree\n',
    'WEBVTT\n\n', // empty segment (no cues in this second)
  ];
  assert.deepEqual(mergeSubtitleSegments(perSegment), [
    { start: 0.2, end: 0.8, text: 'One' },
    { start: 1.2, end: 1.8, text: 'Two' },
    { start: 2, end: 2.5, text: 'Three' },
  ]);
});

test('mergeSubtitleSegments concatenates DASH text segments without maps', () => {
  const segs = ['WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA\n', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nB\n'];
  assert.deepEqual(
    mergeSubtitleSegments(segs).map((c) => c.text),
    ['A', 'B'],
  );
});

test('convertSubtitle converts between formats', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i>Merhaba</i> &amp; hoşça kal\n';
  assert.equal(convertSubtitle(vtt, 'srt'), '1\n00:00:01,000 --> 00:00:02,000\n<i>Merhaba</i> & hoşça kal\n');
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nA & B\n';
  assert.equal(convertSubtitle(srt, 'vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA &amp; B\n');
  assert.throws(() => convertSubtitle('<html></html>', 'srt'), /tanınmadı/);
});

test('language helpers normalise, label and map codes', () => {
  assert.equal(normalizeLanguage('TUR'), 'tr');
  assert.equal(normalizeLanguage('pt_BR'), 'pt-br');
  assert.equal(normalizeLanguage('ger'), 'de');
  assert.equal(normalizeLanguage('Türkçe'), null);
  assert.equal(iso639_2('tr'), 'tur');
  assert.equal(iso639_2('en-US'), 'eng');
  assert.equal(iso639_2(null), 'und');
  assert.equal(languageLabel('tr'), 'Türkçe');
  assert.equal(languageLabel('en', 'English (CC)'), 'English (CC)');
  assert.equal(languageLabel(null), 'Bilinmeyen dil');
  assert.equal(languageSuffix('pt-BR'), 'pt-br');
  assert.equal(languageSuffix(null), 'altyazi');
});

test('guessLanguage reads query parameters and file name tokens', () => {
  assert.equal(guessLanguage('https://cdn.test/subs/film-tr.vtt'), 'tr');
  assert.equal(guessLanguage('https://cdn.test/subs/film_eng.srt'), 'en');
  assert.equal(guessLanguage('https://cdn.test/subs/movie.turkish.vtt'), 'tr');
  assert.equal(guessLanguage('https://cdn.test/subs/get.vtt?lang=de'), 'de');
  assert.equal(guessLanguage('https://cdn.test/subs/a8f3k2.vtt'), null);
  assert.equal(guessLanguage('not a url'), null);
});

test('languageMatches and autoPick follow the preference order', () => {
  assert.ok(languageMatches('tr', ['tr']));
  assert.ok(languageMatches('en-US', ['en']));
  assert.ok(languageMatches('tur', ['tr']));
  assert.ok(!languageMatches('en', ['tr']));
  assert.ok(languageMatches(null, ['*']));
  const choices = [
    { ref: 'a', lang: 'en' },
    { ref: 'b', lang: 'tr', forced: true },
    { ref: 'c', lang: 'tr' },
    { ref: 'd', lang: 'de' },
  ];
  assert.deepEqual(
    autoPick(choices, ['tr', 'en']).map((c) => c.ref),
    ['c', 'a'],
  );
  assert.deepEqual(
    autoPick(choices, ['fr']).map((c) => c.ref),
    [],
  );
  assert.deepEqual(
    autoPick(choices, []).map((c) => c.ref),
    [],
  );
  assert.deepEqual(
    autoPick(choices, ['*']).map((c) => c.ref),
    ['a', 'c', 'd'],
  );
});

const cuesOf = (...texts) => texts.map((text, i) => ({ start: i * 3, end: i * 3 + 2, text }));

test('guessLanguageFromCues: words, Turkish letters in capitals, scripts; null when unsure', () => {
  assert.equal(
    guessLanguageFromCues(cuesOf('Bunu neden yaptın?', 'Bilmiyorum, ama çok önemli değil.', 'Hadi gidelim, şimdi burada kalamayız.')),
    'tr',
  );
  assert.equal(guessLanguageFromCues(cuesOf('What are you doing here?', "I don't know, it's not that important.", 'We have to go.')), 'en');
  assert.equal(guessLanguageFromCues(cuesOf('<i>Ich weiß es nicht.</i>', 'Was ist das? Das ist nicht mein Auto, aber ja.')), 'de');
  // Signs of a dub: shouted, few function words.
  assert.equal(
    guessLanguageFromCues(cuesOf('FRANKFURT ALMANYA', 'MÜHENDİSLİK FAKÜLTESİ', 'YARIŞ PİSTİ YENİ REKOR', 'GERÇEĞE DÖNÜŞTÜ')),
    'tr',
  );
  assert.equal(guessLanguageFromCues(cuesOf('Что ты здесь делаешь?', 'Нам нужно идти.')), 'ru');
  assert.equal(guessLanguageFromCues(cuesOf('ok', 'hm')), null);
  assert.equal(guessLanguageFromCues([]), null);
});

test('looksForced: under one cue a minute over a long span', () => {
  const spread = (count, every) => Array.from({ length: count }, (_, i) => ({ start: 20 + i * every, end: 22 + i * every, text: 'X' }));
  assert.equal(looksForced(spread(42, 137)), true); // a dub's signs over 96 minutes
  assert.equal(looksForced(spread(900, 6)), false); // a full film
  assert.equal(looksForced(spread(3, 2)), false); // a short clip
  assert.equal(looksForced([]), false);
});

test('describeSubtitle: format, cue count, language and forced flag of a file', () => {
  const vtt =
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNe oldu? Bilmiyorum.\n\n00:00:03.000 --> 00:00:04.000\nHadi gidelim, burada çok soğuk.\n';
  assert.deepEqual(describeSubtitle(vtt), { format: 'vtt', cues: 2, langGuess: 'tr', forced: false });
  assert.throws(() => describeSubtitle('<html>not a subtitle</html>'));
});
