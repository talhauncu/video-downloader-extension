import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilename, sanitizePart, siteFromUrl, timestamp } from '../../src/lib/filename.js';

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
