import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilename, applyTemplate, DEFAULT_TEMPLATE } from '../../src/lib/filename.js';

const date = new Date(2026, 9, 31, 14, 5, 9);

test('default template is unchanged', () => {
  assert.equal(buildFilename({ pageUrl: 'https://www.x.com/u/1', title: 'Başlık', ext: 'mp4', date }), 'x.com-Başlık-20261031-1405.mp4');
  assert.equal(
    buildFilename({ pageUrl: 'https://www.x.com/u/1', title: 'Başlık', ext: 'mp4', date, template: DEFAULT_TEMPLATE }),
    'x.com-Başlık-20261031-1405.mp4',
  );
});

test('custom template with quality, time and reordering', () => {
  const name = buildFilename({
    pageUrl: 'https://vimeo.com/1',
    title: 'Film',
    ext: 'mp4',
    date,
    quality: '1080p',
    template: '{title} [{quality}] {site} {time}',
  });
  assert.equal(name, 'Film [1080p] vimeo.com 140509.mp4');
});

test('empty tokens vanish together with their separators', () => {
  assert.equal(applyTemplate('{site}-{title}-{quality}-{date}', { site: 'a.com', title: '', quality: '', date: 'D' }), 'a.com-D');
  assert.equal(applyTemplate('{title}_{site}', { title: '', site: 'a.com' }), 'a.com');
  assert.equal(applyTemplate('{quality} {title}', { quality: '720p', title: 'T' }), '720p T');
});

test('template that resolves to nothing falls back to video-<date>', () => {
  assert.equal(buildFilename({ ext: 'mp4', date, template: '{quality}' }), 'video-20261031-1405.mp4');
});

test('id token is 4 chars and the name stays within 120 characters', () => {
  const name = buildFilename({ pageUrl: 'https://a.test', title: 'x'.repeat(300), ext: 'mp4', date, template: '{title}-{id}' });
  assert.ok(name.length <= 120);
  assert.match(buildFilename({ ext: 'mp4', date, template: '{id}' }), /^[a-z0-9]{4}\.mp4$/);
});
