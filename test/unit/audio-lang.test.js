import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAudio, audioLanguage, audioTrackLabel } from '../../src/lib/audio-lang.js';
import { languageFromName } from '../../src/lib/subtitles.js';

// A dub is the default, the original second.
const tr = { url: 'a-tr', lang: 'tr', name: 'Türkçe', default: true };
const en = { url: 'a-en', lang: 'en', name: 'English', default: false };

test('pickAudio: default, original, a language; falls back to the default track', () => {
  assert.equal(pickAudio([tr, en], 'default'), tr);
  assert.equal(pickAudio([tr, en], 'original'), en);
  assert.equal(pickAudio([tr, en], 'en'), en);
  assert.equal(pickAudio([tr, en], 'tr'), tr);
  assert.equal(pickAudio([tr, en], 'de'), tr);
  assert.equal(pickAudio([en, { ...tr, default: false }], 'default'), en); // no default flag: the first
  assert.equal(pickAudio([], 'original'), null);
});

test('pickAudio original: a track named "Orijinal" wins; only Turkish tracks keep the default', () => {
  const dub = { url: 'd', name: 'TR Dublaj', default: true };
  const orig = { url: 'o', name: 'Orijinal' };
  assert.equal(pickAudio([dub, orig], 'original'), orig);
  assert.equal(pickAudio([tr, { ...tr, url: 'tr2', default: false }], 'original'), tr);
  // Language from the name when the tag is missing.
  assert.equal(
    pickAudio(
      [
        { url: 'x', name: 'Türkçe', default: true },
        { url: 'y', name: 'İngilizce' },
      ],
      'original',
    ).url,
    'y',
  );
});

test('audioLanguage and audioTrackLabel read tags, then names', () => {
  assert.equal(audioLanguage({ lang: 'tur' }), 'tr');
  assert.equal(audioLanguage({ name: 'Türkçe Dublaj' }), 'tr');
  assert.equal(audioLanguage({ label: 'English 5.1' }), 'en');
  assert.equal(audioLanguage({ name: 'Orijinal' }), null);
  assert.equal(audioTrackLabel(tr), 'Türkçe');
  assert.equal(audioTrackLabel({ name: 'Orijinal' }), 'Orijinal');
  assert.equal(languageFromName('ALMANCA'), 'de');
});
