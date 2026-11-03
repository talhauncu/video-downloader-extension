import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilename, sanitizePart, siteFromUrl, timestamp, truncate } from '../../src/lib/filename.js';

const date = new Date(2026, 9, 31, 14, 5); // 2026-10-31 14:05 local

test('timestamp format', () => {
  assert.equal(timestamp(date), '20261031-1405');
});

test('siteFromUrl strips www and survives bad input', () => {
  assert.equal(siteFromUrl('https://www.haberler.com/x'), 'haberler.com');
  assert.equal(siteFromUrl('garbage'), 'video');
});

test('sanitizePart removes illegal characters and trailing dots', () => {
  assert.equal(sanitizePart('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(sanitizePart('  çok   boşluk  '), 'çok boşluk');
  assert.equal(sanitizePart('nokta...'), 'nokta');
});

test('buildFilename composes site, title, stamp and extension', () => {
  const name = buildFilename({ pageUrl: 'https://www.x.com/u/status/1', title: 'Harika video: izle!', ext: 'mp4', date });
  assert.equal(name, 'x.com-Harika video izle!-20261031-1405.mp4');
});

test('buildFilename falls back when title and url are empty', () => {
  assert.equal(buildFilename({ ext: '.MP4', date }), 'video-20261031-1405.mp4');
  assert.equal(buildFilename({ ext: '', date }), 'video-20261031-1405.bin');
});

test('buildFilename caps the length at 120 characters', () => {
  const name = buildFilename({ pageUrl: 'https://a.test', title: 'x'.repeat(300), ext: 'webm', date });
  assert.ok(name.length <= 120, name.length);
  assert.ok(name.endsWith('-20261031-1405.webm'));
});

test('sanitizePart drops what chrome.downloads refuses: format characters, unpaired halves, non-characters, DEL/C1, a leading tilde', () => {
  // Measured with chrome.downloads.download: each of these made it fail with "Invalid filename".
  assert.equal(sanitizePart('Aile 👨‍👩‍👧 videosu'), 'Aile 👨👩👧 videosu'); // zero-width joiner
  assert.equal(sanitizePart('a​b‎c‮d⁦e﻿f­g؜h'), 'abcdefgh'); // ZWSP, LRM, RLO, FSI, BOM, soft hyphen, ALM
  assert.equal(sanitizePart('kesik \uD83D'), 'kesik'); // half of an emoji
  assert.equal(sanitizePart('a\uDE00b'), 'ab');
  assert.equal(sanitizePart('a￾b\u{1FFFF}c'), 'abc'); // non-characters
  assert.equal(sanitizePart('a\u007Fb\u0085c'), 'a b c'); // DEL, C1 control
  assert.equal(sanitizePart('~~başlık'), 'başlık');
  // Accepted as they are: emoji, a variation selector, combining marks, a tilde inside, # % · ’ …
  assert.equal(sanitizePart('a🎮b ❤️ i̇ x~y #1 %50 · ’…'), 'a🎮b ❤️ i̇ x~y #1 %50 · ’…');
});

test('truncate never splits an emoji; long titles keep whole characters', () => {
  assert.equal(truncate('ab🎮', 3), 'ab');
  assert.equal(truncate('ab🎮', 4), 'ab🎮');
  assert.equal(truncate('kısa', 10), 'kısa');
  const name = buildFilename({
    pageUrl: 'https://x.com/',
    title: `${'ç'.repeat(100)}🎮🎮🎮`,
    ext: 'mp4',
    date: new Date(2026, 10, 3, 17, 0),
  });
  assert.ok(name.length <= 120, name.length);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name), 'no unpaired half');
});
